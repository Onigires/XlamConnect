'use strict';
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, safeStorage, Notification, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { Engine, generateIdentity } = require('../engine');
const { isAdmin } = require('../engine/tun/netcfg');

const DEFAULTS = { nick: '', server: '', lang: '', autoConnect: false, closeToTray: true, firewall: true, networks: [], last: null };
let win, tray, engine, config, chat = [], quitting = false, admin = true;

/* ---------------- crash safety ---------------- */
function logCrash(kind, err) {
  const line = `[${new Date().toISOString()}] ${kind}: ${err && (err.stack || err.message || err)}\n`;
  console.error(line);
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'crash.log'), line); } catch {}
}
process.on('uncaughtException', (e) => logCrash('uncaughtException', e));
process.on('unhandledRejection', (e) => logCrash('unhandledRejection', e));

/* ---------------- config ---------------- */
const cfgPath = () => path.join(app.getPath('userData'), 'config.json');
function loadConfig() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(cfgPath(), 'utf8')); } catch {}
  config = { ...DEFAULTS, ...c };
  if (!config.nick) config.nick = os.userInfo().username || 'player';
  if (!config.identity) { config.identity = generateIdentity(); saveConfig(); }
}
function saveConfig() { try { fs.mkdirSync(path.dirname(cfgPath()), { recursive: true }); fs.writeFileSync(cfgPath(), JSON.stringify(config, null, 2)); } catch (e) { console.error('config save', e); } }
const seal = (s) => (safeStorage.isEncryptionAvailable() ? 'enc:' + safeStorage.encryptString(s).toString('base64') : 'plain:' + Buffer.from(s).toString('base64'));
const unseal = (s) => (s.startsWith('enc:') ? safeStorage.decryptString(Buffer.from(s.slice(4), 'base64')) : Buffer.from(s.slice(6), 'base64').toString());
const publicConfig = () => ({ ...config, identity: undefined, networks: config.networks.map((n) => ({ name: n.name, server: n.server, created: n.created })) });

/* ---------------- admin elevation (Wintun needs it) ---------------- */
function relaunchElevated() {
  const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  const args = app.isPackaged ? [] : [app.getAppPath()];
  const argList = args.length ? `-ArgumentList '"${args.join('" "')}"'` : '';
  execFile('powershell.exe', ['-NoProfile', '-Command', `Start-Process -FilePath '${exe}' ${argList} -Verb RunAs`], { windowsHide: true }, () => {});
}

/* ---------------- engine ---------------- */
function makeEngine() {
  const e = new Engine({
    identity: config.identity, nick: config.nick,
    createTun: async (cfg) => { const { WintunTun } = require('../engine/tun/wintun'); return WintunTun.create({ ...cfg, firewall: config.firewall, log: (m) => console.log('[net]', m) }); },
  });
  e.on('snapshot', (s) => { send({ type: 'snapshot', snapshot: s }); updateTray(s); });
  e.on('chat', (m) => {
    chat.push(m); if (chat.length > 300) chat.shift();
    send({ type: 'chat', message: m });
    try { if (win && !win.isDestroyed() && !win.isFocused() && Notification.isSupported()) new Notification({ title: String(m.nick), body: String(m.text) }).show(); } catch (e) { logCrash('notification', e); }
  });
  e.on('log', (l) => console.log('[engine]', l));
  return e;
}
const send = (ev) => { if (win && !win.isDestroyed()) win.webContents.send('xlam:event', ev); };

async function doConnect({ name, password, create, remember, server }) {
  name = String(name || '').trim(); server = String(server || config.server || '').trim();
  if (!server) throw Object.assign(new Error('Укажите адрес сервера'), { code: 'noserver' });
  if (!admin) throw Object.assign(new Error('Нужны права администратора для создания виртуального адаптера'), { code: 'admin' });
  if (engine.status !== 'offline') await engine.disconnect();
  engine.nick = config.nick;
  chat = [];
  await engine.connect({ server, network: name, password, create });
  config.server = server; config.last = name;
  if (remember !== false) {
    const rec = { name, password: seal(password), server, created: Date.now() };
    config.networks = [...config.networks.filter((n) => n.name.toLowerCase() !== name.toLowerCase()), rec];
  }
  saveConfig();
  return { ok: true };
}

const api = {
  state: async () => ({ config: publicConfig(), snapshot: engine.snapshot(), admin, platform: process.platform, version: app.getVersion(), chat }),
  saveSettings: async (patch) => {
    for (const k of ['nick', 'server', 'lang', 'autoConnect', 'closeToTray', 'firewall']) if (k in patch) config[k] = patch[k];
    if (!config.nick.trim()) config.nick = os.userInfo().username || 'player';
    saveConfig(); return publicConfig();
  },
  connect: doConnect,
  connectSaved: async ({ name }) => {
    const n = config.networks.find((x) => x.name === name); if (!n) throw new Error('Сеть не найдена');
    return doConnect({ name: n.name, password: unseal(n.password), create: false, server: n.server, remember: false });
  },
  disconnect: async () => { await engine.disconnect(); return { ok: true }; },
  forget: async ({ name }) => { config.networks = config.networks.filter((n) => n.name !== name); if (config.last === name) config.last = null; saveConfig(); return publicConfig(); },
  chat: async ({ text }) => {
    text = String(text || '').trim(); if (!text) return { ok: false };
    engine.sendChat(text);
    const m = { id: 0, nick: config.nick, ip: engine.self?.ip, text, ts: Date.now(), me: true };
    chat.push(m); send({ type: 'chat', message: m }); return { ok: true };
  },
  invite: async ({ name }) => {
    const n = config.networks.find((x) => x.name === name); if (!n) throw new Error('Сеть не найдена');
    return `Xlam Connect\nСеть: ${n.name}\nПароль: ${unseal(n.password)}\nСервер: ${n.server}`;
  },
  openExternal: async ({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); },
};

/* ---------------- window / tray ---------------- */
function createWindow() {
  win = new BrowserWindow({
    width: 1100, height: 720, minWidth: 900, minHeight: 600, backgroundColor: '#0b0f14', frame: false, show: false, title: 'Xlam Connect',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, '..', 'ui', 'index.html'));
  win.once('ready-to-show', () => { if (!process.argv.includes('--hidden')) win.show(); });
  win.on('close', (e) => {
    if (quitting) return;
    if (config.closeToTray && engine.status !== 'offline') { e.preventDefault(); win.hide(); }
  });
  win.webContents.on('render-process-gone', (_e, d) => { logCrash('render-process-gone', JSON.stringify(d)); if (win && !win.isDestroyed()) win.reload(); });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

function updateTray(s) {
  if (!tray) return;
  const online = s.status === 'online';
  tray.setToolTip(online ? `Xlam Connect — ${s.network} · ${s.you?.ip} · ${s.peers.length} онлайн` : 'Xlam Connect — не подключено');
}
function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Открыть Xlam Connect', click: () => { win.show(); win.focus(); } },
    { label: 'Отключиться', click: () => engine.disconnect() },
    { type: 'separator' },
    { label: 'Выход', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', () => { win.isVisible() ? win.focus() : win.show(); });
}

/* ---------------- lifecycle ---------------- */
app.whenReady().then(async () => {
  admin = await isAdmin();
  if (process.platform === 'win32' && !admin && !process.env.XLAM_NO_ELEVATE) { relaunchElevated(); app.exit(0); return; }
  if (!app.requestSingleInstanceLock()) { app.exit(0); return; }
  app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });

  loadConfig();
  engine = makeEngine();
  ipcMain.handle('xlam', async (_e, method, args) => {
    try { if (!api[method]) throw new Error('unknown method ' + method); return { ok: true, data: await api[method](args) }; }
    catch (e) { return { ok: false, error: e.message, code: e.code }; }
  });
  ipcMain.on('win', (_e, a) => { if (!win) return; if (a === 'minimize') win.minimize(); else if (a === 'maximize') (win.isMaximized() ? win.unmaximize() : win.maximize()); else if (a === 'close') win.close(); });
  createWindow(); createTray();

  if (config.autoConnect && config.last) {
    const n = config.networks.find((x) => x.name === config.last);
    if (n) api.connectSaved({ name: n.name }).catch((e) => send({ type: 'error', message: e.message }));
  }
});

app.on('before-quit', (e) => {
  if (engine && engine.status !== 'offline' && !app._cleaned) {
    e.preventDefault(); quitting = true;
    engine.disconnect().finally(() => { app._cleaned = true; app.quit(); });
  }
});
app.on('window-all-closed', () => { if (quitting || !engine || engine.status === 'offline') app.quit(); });
