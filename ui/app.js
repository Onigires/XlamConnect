import { call, onEvent, win, isMock } from './api.js';
import { I } from './icons.js';
import { t, setLang, detectLang, errText } from './i18n.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const S = { config: { networks: [] }, snap: { status: 'offline', peers: [], totals: {} }, admin: true, chat: [], view: 'home', dialog: null, version: '', chatOpen: true };

/* ---------- helpers ---------- */
const hue = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const av = (nick, size) => `<div class="av" style="background:hsl(${hue(nick)} 70% 62%);${size ? `width:${size}px;height:${size}px;font-size:${size / 2.5}px` : ''}">${esc([...nick][0] || '?')}</div>`;
const bytes = (n = 0) => { const u = ['Б', 'КБ', 'МБ', 'ГБ']; let i = 0; while (n >= 1024 && i < 3) { n /= 1024; i++; } return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${document.documentElement.lang === 'en' ? ['B', 'KB', 'MB', 'GB'][i] : u[i]}`; };
const rate = (n = 0) => `${bytes(n)}/${document.documentElement.lang === 'en' ? 's' : 'с'}`;
const pingCls = (v) => (v == null ? 'n' : v < 60 ? 'g' : v < 130 ? 'y' : 'r');
const time = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
function toast(msg, err) {
  const el = document.createElement('div'); el.className = 'toast' + (err ? ' err' : ''); el.innerHTML = (err ? I.alert : I.check) + `<span>${esc(msg)}</span>`;
  $('#toast-root').appendChild(el); setTimeout(() => el.remove(), 2400);
}
async function copy(text) { try { await navigator.clipboard.writeText(text); toast(t('copied')); } catch { toast('Clipboard unavailable', true); } }
const online = () => S.snap.status === 'online';
const busy = () => ['connecting', 'reconnecting'].includes(S.snap.status);

/* ---------- sidebar ---------- */
function renderSidebar() {
  const st = S.snap.status;
  const label = st === 'online' ? t('online') : st === 'connecting' ? t('connecting') : st === 'reconnecting' ? t('reconnecting') : t('offline');
  const nets = S.config.networks.map((n) => {
    const active = S.snap.network === n.name && st !== 'offline';
    return `<button class="net ${active ? 'active' : ''}" data-net="${esc(n.name)}">
      <div class="av" style="background:hsl(${hue(n.name)} 55% 42%);color:#fff;width:34px;height:34px;font-size:13px">${esc([...n.name][0].toUpperCase())}</div>
      <div class="txt"><div class="nm">${esc(n.name)}</div><div class="sv">${esc(n.server || '')}</div></div>
      ${active ? `<span class="dot ${st === 'online' ? 'on' : 'busy'}"></span>` : `<span class="del" data-del="${esc(n.name)}" title="${esc(t('forget'))}">${I.trash}</span>`}
    </button>`;
  }).join('');
  $('#sidebar').innerHTML = `
    <div class="profile">${av(S.config.nick || '?')}<div class="meta"><div class="nick">${esc(S.config.nick)}</div>
      <div class="status"><span class="dot ${st === 'online' ? 'on' : busy() ? 'busy' : ''}"></span>${label}</div></div></div>
    <div class="sec">${t('networks')}</div>
    <div class="nets scroll">${nets || `<div class="empty-nets">${t('noNetworks')}</div>`}</div>
    <div class="side-actions">
      <button class="btn primary" data-act="create">${I.plus}${t('create')}</button>
      <button class="btn" data-act="join">${I.link}${t('join')}</button>
    </div>
    <div class="side-foot"><span>v${esc(S.version)}</span><button class="icon-btn" data-act="settings" title="${esc(t('settings'))}">${I.gear}</button></div>`;
}

/* ---------- main ---------- */
function renderMain() {
  const m = $('#main');
  if (S.view === 'settings') return renderSettings(m);
  const st = S.snap.status;
  if (st === 'offline') return renderWelcome(m);
  if (st === 'connecting') { m.innerHTML = `<div class="connecting-view"><div><div class="spinner"></div><b style="color:var(--text);font-size:17px">${t('connecting')}</b><div style="margin-top:6px">${esc(S.snap.network || '')}</div></div></div>`; return; }
  renderNetwork(m);
}

function renderWelcome(m) {
  const banners = (!S.admin ? `<div class="banner">${I.alert}<div><b>${t('needAdmin')}</b>${t('needAdminText')}</div></div>` : '')
    + (!S.config.server && !S.config.networks.length ? `<div class="banner">${I.server}<div><b>${t('noServer')}</b>${t('noServerText')}</div></div>` : '');
  m.innerHTML = `<div class="welcome"><div class="box">
    <div class="orb"><img src="../assets/icon.png" alt=""></div>
    <h1>${t('welcomeTitle')}</h1><p>${t('welcomeText')}</p>${banners}
    <div class="cta"><button class="btn primary" data-act="create">${I.plus}${t('create')}</button><button class="btn" data-act="join">${I.link}${t('join')}</button></div>
    <div class="steps">
      <div class="step"><div class="n">1</div><b>${t('step1')}</b><span>${t('step1d')}</span></div>
      <div class="step"><div class="n">2</div><b>${t('step2')}</b><span>${t('step2d')}</span></div>
      <div class="step"><div class="n">3</div><b>${t('step3')}</b><span>${t('step3d')}</span></div>
    </div></div></div>`;
}

const pathBadge = (p) => `<span class="badge ${p} tip" data-tip="${esc(t(p === 'direct' ? 'directHint' : p === 'relay' ? 'relayHint' : 'linkHint'))}">${t(p === 'connecting' ? 'link' : p)}</span>`;

function peersTable() {
  const peers = S.snap.peers;
  if (!peers.length) return `<div class="table"><div class="alone">${I.users.replace('class="i"', 'class="i" style="width:34px;height:34px;color:var(--mute)"')}<h3>${t('aloneTitle')}</h3><p>${t('aloneText')}</p><button class="btn" data-act="invite">${I.copy}${t('copyInvite')}</button></div></div>`;
  return `<div class="table"><div class="trow head"><div>${t('colName')}</div><div>${t('colIp')}</div><div>${t('colPath')}</div><div>${t('colPing')}</div><div>${t('colTraffic')}</div></div>
  ${peers.map((p) => `<div class="trow">
    <div class="who">${av(p.nick)}<div class="nm">${esc(p.nick)}</div></div>
    <div><button class="copyable ip" data-copy="${esc(p.ip)}">${esc(p.ip)}${I.copy}</button></div>
    <div>${pathBadge(p.path)}</div>
    <div class="ping ${pingCls(p.rtt)}">${p.rtt == null ? '—' : Math.round(p.rtt) + ' ms'}</div>
    <div class="traffic"><span>${I.down}${rate(p.rxRate)}</span><span>${I.up}${rate(p.txRate)}</span></div></div>`).join('')}</div>`;
}

function renderNetwork(m) {
  const s = S.snap, tot = s.totals || {};
  const re = s.status === 'reconnecting';
  m.innerHTML = `<div class="nv">
    <div class="nv-head">
      <div class="av" style="background:hsl(${hue(s.network)} 55% 42%);color:#fff;width:50px;height:50px;font-size:20px;border-radius:15px">${esc([...s.network][0].toUpperCase())}</div>
      <div class="grow"><h2>${esc(s.network)}</h2><div class="sub">
        <span class="chip ${re ? '' : 'good'}">${re ? t('reconnecting') : `<span class="dot on" style="width:6px;height:6px;box-shadow:none"></span>${t('peersOnline', s.peers.length + 1)}`}</span>
        <span class="chip">${I.lock}${t('encrypted')}</span></div></div>
      <button class="btn danger" data-act="disconnect">${I.power}${t('disconnect')}</button>
    </div>
    <div class="stats">
      <div class="stat"><div class="k">${I.globe}${t('yourIp')}</div><div class="v"><button class="copyable" data-copy="${esc(s.you?.ip)}">${esc(s.you?.ip || '—')}${I.copy}</button></div></div>
      <div class="stat"><div class="k">${I.server}${t('serverPing')}</div><div class="v ${pingCls(s.serverRtt)}">${s.serverRtt == null ? '—' : Math.round(s.serverRtt)}<small>ms</small></div></div>
      <div class="stat"><div class="k">${I.down}${t('rx')}</div><div class="v">${bytes(tot.rx)}<small>${rate(tot.rxRate)}</small></div></div>
      <div class="stat"><div class="k">${I.up}${t('tx')}</div><div class="v">${bytes(tot.tx)}<small>${rate(tot.txRate)}</small></div></div>
    </div>
    <div id="peers">${peersTable()}</div></div>`;
}

/* ---------- settings ---------- */
function renderSettings(m) {
  const c = S.config, lang = document.documentElement.lang;
  const sw = (id, on) => `<label class="sw"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}><span></span></label>`;
  m.innerHTML = `<div class="settings">
    <h2><button class="icon-btn" data-act="home">${I.back}</button>${t('settings')}</h2>
    <div class="card"><div class="row2">
      <div class="field"><label>${t('nick')}</label><input class="input" id="s-nick" maxlength="24" value="${esc(c.nick)}"></div>
      <div class="field"><label>${t('server')}</label><input class="input" id="s-server" placeholder="host:7777" value="${esc(c.server)}"></div></div>
      <div class="field"><label>${t('language')}</label><div class="seg"><button data-lang="ru" class="${lang === 'ru' ? 'on' : ''}">Русский</button><button data-lang="en" class="${lang === 'en' ? 'on' : ''}">English</button></div></div>
      <div class="hint" style="color:var(--mute);font-size:12px">${t('settingsNote')}</div></div>
    <div class="card">
      <div class="toggle-row"><div>${t('autoConnect')}</div>${sw('s-auto', c.autoConnect)}</div>
      <div class="toggle-row"><div>${t('closeToTray')}</div>${sw('s-tray', c.closeToTray)}</div>
      <div class="toggle-row"><div>${t('firewall')}<small>${t('firewallHint')}</small></div>${sw('s-fw', c.firewall)}</div></div>
    <div class="card"><h4>${t('diagnostics')}</h4>
      <div class="kv"><span>${t('admin')}</span><b style="color:var(--${S.admin ? 'good' : 'bad'})">${S.admin ? t('yes') : t('no')}</b></div>
      <div class="kv"><span>${t('adapter')}</span><b>Wintun · X25519 + ChaCha20-Poly1305</b></div>
      <div class="kv"><span>${t('publicEp')}</span><b>${esc(S.snap.you?.publicEp || '—')}</b></div>
      <div class="kv"><span>${t('serverPing')}</span><b>${S.snap.serverRtt == null ? '—' : S.snap.serverRtt + ' ms'}</b></div></div>
    <div><button class="btn primary" data-act="save">${I.check}${t('save')}</button></div></div>`;
}

/* ---------- chat ---------- */
function renderChatShell() {
  const c = $('#chat');
  if (!online() || S.view === 'settings') { c.classList.add('hidden'); return; }
  c.classList.remove('hidden');
  if (!c.dataset.ready) {
    c.innerHTML = `<div class="chat-head">${I.chat}<span>${t('chat')}</span></div><div class="msgs scroll" id="msgs"></div>
      <form class="composer" id="composer"><input class="input" id="chat-in" autocomplete="off" maxlength="500" placeholder="${esc(t('chatPlaceholder'))}"><button class="btn primary" aria-label="send">${I.send}</button></form>`;
    c.dataset.ready = '1';
  }
  renderMsgs();
}
function renderMsgs() {
  const el = $('#msgs'); if (!el) return;
  const stick = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  el.innerHTML = S.chat.length ? S.chat.map((m) => `<div class="msg ${m.me ? 'me' : ''}"><div class="who2">${m.me ? t('you') : esc(m.nick)} · ${time(m.ts)}</div><div class="bub">${esc(m.text)}</div></div>`).join('') : `<div class="chat-empty">${t('chatEmpty')}</div>`;
  if (stick) el.scrollTop = el.scrollHeight;
}

/* ---------- dialogs ---------- */
function openDialog(mode) {
  S.dialog = mode;
  const create = mode === 'create';
  $('#dialog-root').innerHTML = `<div class="overlay" id="ov"><form class="dialog" id="dlg" autocomplete="off">
    <h3>${t(create ? 'createTitle' : 'joinTitle')}</h3><p class="sub">${t(create ? 'createSub' : 'joinSub')}</p>
    <div id="form-err"></div>
    <div class="field"><label>${t('netName')}</label><input class="input" id="d-name" maxlength="32" required minlength="3"></div>
    <div class="field"><label>${t('password')}</label><div class="pw"><input class="input" id="d-pw" type="password" required minlength="1"><button type="button" class="icon-btn" data-act="eye">${I.eye}</button></div></div>
    <div class="field"><label>${t('server')}</label><input class="input" id="d-server" placeholder="vpn.example.com:7777" value="${esc(S.config.server)}" required><span class="hint">${t('serverHint')}</span></div>
    <label class="check"><input type="checkbox" id="d-rem" checked>${t('remember')}</label>
    <div class="dlg-actions"><button type="button" class="btn ghost" data-act="close-dlg">${t('cancel')}</button><button class="btn primary" id="d-ok">${t(create ? 'create' : 'join')}</button></div>
  </form></div>`;
  setTimeout(() => $('#d-name')?.focus(), 30);
}
const closeDialog = () => { S.dialog = null; $('#dialog-root').innerHTML = ''; };
const showErr = (e) => { const el = $('#form-err'); if (el) el.innerHTML = `<div class="form-err">${esc(errText(e.code, e.message))}</div>`; else toast(errText(e.code, e.message), true); };

async function submitDialog() {
  const create = S.dialog === 'create';
  const args = { name: $('#d-name').value.trim(), password: $('#d-pw').value, server: $('#d-server').value.trim(), create, remember: $('#d-rem').checked };
  const ok = $('#d-ok'); ok.disabled = true;
  try { const p = call('connect', args); closeDialog(); S.view = 'home'; await p; await refresh(); }
  catch (e) { await refresh(); S.pendingRetry = args; openDialog(S.dialog || (create ? 'create' : 'join')); $('#d-name').value = args.name; $('#d-server').value = args.server; showErr(e); }
}

/* ---------- events ---------- */
document.addEventListener('click', async (ev) => {
  const w = ev.target.closest('[data-win]'); if (w) return win[w.dataset.win]();
  const cp = ev.target.closest('[data-copy]'); if (cp) return copy(cp.dataset.copy);
  const del = ev.target.closest('[data-del]');
  if (del) { ev.stopPropagation(); if (confirm(t('forgetQ', del.dataset.del))) { S.config = await call('forget', { name: del.dataset.del }); renderAll(); } return; }
  const net = ev.target.closest('[data-net]');
  if (net) {
    const name = net.dataset.net; if (S.snap.network === name && S.snap.status !== 'offline') { S.view = 'home'; return renderAll(); }
    S.view = 'home';
    try { const p = call('connectSaved', { name }); await p; } catch (e) { toast(errText(e.code, e.message), true); } return refresh();
  }
  const lang = ev.target.closest('[data-lang]'); if (lang) { S.config.lang = lang.dataset.lang; setLang(lang.dataset.lang); await call('saveSettings', { lang: lang.dataset.lang }); return renderAll(); }
  const a = ev.target.closest('[data-act]'); if (!a) return;
  switch (a.dataset.act) {
    case 'create': case 'join': return openDialog(a.dataset.act);
    case 'close-dlg': return closeDialog();
    case 'settings': S.view = 'settings'; return renderAll();
    case 'home': S.view = 'home'; return renderAll();
    case 'disconnect': await call('disconnect'); return refresh();
    case 'eye': { const i = $('#d-pw'); i.type = i.type === 'password' ? 'text' : 'password'; return; }
    case 'invite': try { await copy(await call('invite', { name: S.snap.network })); } catch (e) { toast(e.message, true); } return;
    case 'save': {
      S.config = await call('saveSettings', { nick: $('#s-nick').value.trim(), server: $('#s-server').value.trim(), autoConnect: $('#s-auto').checked, closeToTray: $('#s-tray').checked, firewall: $('#s-fw').checked });
      toast(t('saved')); return renderAll();
    }
  }
});
document.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (ev.target.id === 'dlg') return submitDialog();
  if (ev.target.id === 'composer') { const i = $('#chat-in'); const text = i.value.trim(); if (!text) return; i.value = ''; try { await call('chat', { text }); } catch (e) { toast(errText(e.code, e.message), true); } }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.dialog) closeDialog(); });

/* ---------- bootstrap ---------- */
function renderAll() { renderSidebar(); renderMain(); renderChatShell(); }
async function refresh() {
  const st = await call('state');
  S.config = st.config; S.snap = st.snapshot; S.admin = st.admin; S.chat = st.chat || []; S.version = st.version;
  setLang(detectLang(S.config.lang)); renderAll();
}
onEvent((ev) => {
  if (ev.type === 'snapshot') {
    const prev = S.snap.status; S.snap = ev.snapshot;
    if (prev !== S.snap.status || S.view === 'settings' && false) renderAll();
    else { renderSidebar(); if (S.view === 'home' && online()) { renderNetworkLive(); } }
  } else if (ev.type === 'chat') { S.chat.push(ev.message); renderMsgs(); }
  else if (ev.type === 'error') toast(ev.message, true);
});
// update only the volatile parts so hover/tooltip/copy buttons aren't torn down each second
function renderNetworkLive() {
  if (!$('#peers')) return renderAll();
  renderNetwork($('#main'));
}
await refresh();
if (isMock) document.title += ' (preview)';
