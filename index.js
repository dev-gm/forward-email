const { app, BrowserWindow, ipcMain } = require("electron"),
      axios = require("axios").default,
      { JSDOM } = require("jsdom"),
      path = require("path"),
      fs = require("fs");

const API_DATA = JSON.parse(fs.readFileSync(path.join(__dirname, "api.json"), { encoding: "utf-8" }));

const DNS_RECORD = `${API_DATA.DNS_RECORD_PREFIX}.${API_DATA.DOMAIN}`;

const API_URL = "https://api.cloudflare.com/client/v4/zones";

const HEADERS = {
  "Authorization": `Bearer ${API_DATA.TOKEN}`,
  "Content-Type": "application/json",
};

const ZONE = axios.get(`${API_URL}?name=${API_DATA.DOMAIN}`, {
  headers: HEADERS,
}).catch(err => console.log("ZONE: \n" + err));

function rawAliasesToArray(raw) {
  let out = [];
  let alias = "";
  let record = false;
  for (let c of raw) {
    if (c === '"' && record) {
      if (alias !== firstForward())
        out.push(alias);
      alias = "";
      record = false;
    } else if (c === '"')
      record = true;
    else if (record)
      alias += c;
  }
  return out;
}

const firstForward = () => `forward-email=${API_DATA.DEFAULT_EMAIL}`;

const alreadyPresent = (event, alias) => event.reply("msg", { msg: `Alias ${alias} was already present!` });
const addedAlias = (event, alias, endpoint) => event.reply("msg", { msg: `Added alias ${alias} to ${API_DATA.ENDPOINTS[endpoint].email}` });
const changedAlias = (event, prev_alias, new_alias) => event.reply("msg", { msg: `Changed alias ${prev_alias} to ${new_alias}` });
const replyError = (event, err) => event.reply("msg", { msg: `Error: ${err}` });

const aliasesToStr = (aliases)  => `"forward-email=${API_DATA.DEFAULT_EMAIL}""${aliases.join('""')}"`;
const aliasToStr = (alias, email) => `forward-email=${alias}:${email}`;

function parseAlias(raw) {
  let parts = raw.replace(/\s/g, '').split('=');
  parts = parts[parts.length === 1 ? 0 : 1].split(':');
  return { alias: parts[0], endpoint: parts[1] };
}

function parseAliases(raw_aliases) {
  let out = { aliases: [], endpoints: API_DATA.ENDPOINTS };
  let arr = rawAliasesToArray(raw_aliases.content).filter(value => value != firstForward()).map(raw => parseAlias(raw));
  out.aliases = arr !== undefined ? arr : [];
  return out;
}

async function getRawAliases() {
  let out = await axios.get(`${API_URL}/${(await ZONE).data.result[0].id}/dns_records?type=TXT&name=${DNS_RECORD}`, {
    headers: HEADERS,
  }).catch(err => console.log(err))
  return out.data.result[0];
}

async function getAliases(event) {
  getRawAliases()
    .then(aliases => event.reply("update-aliases", parseAliases(aliases)))
    .catch(err => replyError(event, err));
}

async function editAlias(event, args) {
  let raw_aliases = await getRawAliases();
  let aliases = rawAliasesToArray(raw_aliases.content);
  let prev = aliases[args.index];
  aliases[args.index] = aliasToStr(args.new.alias, args.new.endpoint);
  let content = aliasesToStr(aliases);
  axios.put(`${API_URL}/${(await ZONE).data.result[0].id}/dns_records/${raw_aliases.id}`, 
    {
      type: "TXT",
      name: DNS_RECORD,
      content: content,
    },
    {
      headers: HEADERS,
    },
  )
    .then(() => {
      changedAlias(prev, aliases[args.index]);
      getAliases(event);
    })
    .catch(err => replyError(event, err));
}

async function addAlias(event, args) {
  let raw_aliases = await getRawAliases();
  let new_content = `"${aliasToStr(args.alias, API_DATA.ENDPOINTS[args.endpoint].email)}"`;
  console.log(new_content);
  if (raw_aliases.content.includes(new_content))
    return alreadyPresent(event, args.alias);
  axios.put(`${API_URL}/${(await ZONE).data.result[0].id}/dns_records/${raw_aliases.id}`, 
    {
      type: "TXT",
		  name: DNS_RECORD,
      content: raw_aliases.content + new_content,
    },
    {
      headers: HEADERS,
    }
  )
    .then(() => {
      addedAlias(event, args.alias, args.endpoint);
      getAliases(event);
    })
    .catch(err => replyError(event, err));
}

async function addAliases(event, args) {
  let raw_aliases = await getRawAliases();
  let old_aliases = rawAliasesToArray(raw_aliases.content);
  for (let i=0; i<args.length; ++i)
    if (old_aliases.includes(`"${aliasToStr(args[i].alias, API_DATA.ENDPOINTS[args[i].endpoint].email)}"`))
      alreadyPresent(event, args.splice(i, 1).alias);
  let content = "";
  for (let alias of args)
    content += `"${aliasToStr(alias.alias, API_DATA.ENDPOINTS[alias.endpoint].email)}"`;
  console.log(content);
  axios.patch(`${API_URL}/${(await ZONE).data.result[0].id}/dns_records/${raw_aliases.id}`,
    {
      type: "TXT",
		  name: DNS_RECORD,
      content: content,
    },
    {
      headers: HEADERS,
    }
  )
    .then(() => {
      for (let alias of args)
        addedAlias(event, alias.alias, alias.endpoint);
      getAliases(event);
    })
    .catch(err => replyError(event, err));
}

async function deleteAlias(event, args) {
  let raw_aliases = await getRawAliases();
  let aliases = rawAliasesToArray(raw_aliases.content);
  let to_delete = aliases.splice(args.index, 1);
  let content = aliasesToStr(aliases);
  axios.put(`${API_URL}/${(await ZONE).data.result[0].id}/dns_records/${raw_aliases.id}`, 
    {
      type: "TXT",
      name: DNS_RECORD,
      content: content,
    },
    {
      headers: HEADERS,
    },
  )
    .then(res => {
      event.reply("msg", { msg: `Deleted alias ${to_delete}` });
      getAliases(event);
    })
    .catch(err => replyError(event, err));
}

function readGDomains(event, args) {
  fs.readFile(args.path, { encoding: "utf-8" }, (err, data) => {
    if (err)
      return console.log(err);
    addAliases(event, parseGDomains(data));
  });
}

function getIndexFromInput(input) {
  for (let i=0; i<API_DATA.ENDPOINTS.length; ++i) {
    if (API_DATA.ENDPOINTS[i].old.includes(input) ||
        input === API_DATA.ENDPOINTS[i].email ||
        input === API_DATA.ENDPOINTS[i].nickname)
      return i;
  }
}

function parseGDomains(data) {
  let file = new JSDOM(data);
  let aliases = file.window.document.getElementsByClassName("alias-email");
  let emails = file.window.document.getElementsByClassName("summary-domain-name");
  let out = [];
  for (let i=0; i<aliases.length; ++i)
    out.push({ alias: aliases[i].innerHTML.trim(), endpoint: getIndexFromInput(emails[i].innerHTML.trim()) });
  return out;
}

ipcMain.on("load-aliases", async event => getAliases(event));
ipcMain.on("edit-alias", async (event, args) => editAlias(event, args));
ipcMain.on("add-alias", async (event, args) => addAlias(event, args));
ipcMain.on("delete-alias", async (event, args) => deleteAlias(event, args));
ipcMain.on("import-gdomains", async (event, args) => readGDomains(event, args));

if (require("electron-squirrel-startup")) {
  app.quit();
}

const createWindow = () => {
  const mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    }
  });

  mainWindow.loadFile(path.join(__dirname, "/public/index.html"));
};

app.on("ready", createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin")
    app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0)
    createWindow();
});
