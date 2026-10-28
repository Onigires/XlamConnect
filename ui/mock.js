// Browser-only simulator for UI development (never used inside the Electron app).
export function createMock() {
  const listeners = new Set();
  const emit = (ev) => listeners.forEach((l) => l(ev));
  const q = new URLSearchParams(location.search);
  const cfg = { nick: 'Alex', server: q.get('empty') ? '' : 'vpn.example.com:7777', lang: q.get('lang') || '', autoConnect: false, closeToTray: true, firewall: true,
    networks: q.get('empty') ? [] : [{ name: 'LAN Party', server: 'vpn.example.com:7777' }, { name: 'Minecraft Crew', server: 'vpn.example.com:7777' }] };
  let snap = { status: 'offline', peers: [], totals: { tx: 0, rx: 0, txRate: 0, rxRate: 0 } };
  let chat = [], timer = null;
  const fakePeers = [
    { id: 2, nick: 'Dimon', ip: '10.26.0.2', path: 'direct', base: 18 }, { id: 3, nick: 'Kate', ip: '10.26.0.3', path: 'direct', base: 47 },
    { id: 4, nick: 'Vasya_Pro', ip: '10.26.0.4', path: 'relay', base: 134 }, { id: 5, nick: 'Максим', ip: '10.26.0.5', path: 'connecting', base: null },
  ];
  const start = (name, ms = 900) => {
    snap = { ...snap, status: 'connecting', network: name, error: null }; emit({ type: 'snapshot', snapshot: snap });
    return new Promise((res) => setTimeout(() => {
      let n = 0;
      const tick = () => {
        n++;
        const show = q.get('alone') ? [] : fakePeers;
        const peers = show.map((p) => ({ ...p, rtt: p.base == null ? null : Math.round((p.base + Math.random() * 6) * 10) / 10, tx: 1e5 * n * p.id, rx: 3e5 * n * p.id, txRate: p.path === 'connecting' ? 0 : Math.random() * 4e4, rxRate: p.path === 'connecting' ? 0 : Math.random() * 9e4 }));
        snap = { status: 'online', network: name, server: cfg.server, error: null, you: { nick: cfg.nick, ip: '10.26.0.1', publicEp: '203.0.113.42:51820' }, serverRtt: 23.4, peers,
          totals: { tx: peers.reduce((a, p) => a + p.tx, 0), rx: peers.reduce((a, p) => a + p.rx, 0), txRate: peers.reduce((a, p) => a + p.txRate, 0), rxRate: peers.reduce((a, p) => a + p.rxRate, 0) } };
        emit({ type: 'snapshot', snapshot: snap });
      };
      tick(); timer = setInterval(tick, 1000); res({ ok: true });
    }, ms));
  };
  const methods = {
    state: async () => ({ config: cfg, snapshot: snap, admin: q.get('noadmin') ? false : true, platform: 'win32', version: '1.0.0', chat }),
    saveSettings: async (p) => { Object.assign(cfg, p); return cfg; },
    connect: async (a) => { if (a.name === 'bad') throw Object.assign(new Error('x'), { code: 'badauth' }); await start(a.name); if (!cfg.networks.find((n) => n.name === a.name)) cfg.networks.push({ name: a.name, server: a.server }); return { ok: true }; },
    connectSaved: async (a) => start(a.name),
    disconnect: async () => { clearInterval(timer); snap = { status: 'offline', peers: [], totals: { tx: 0, rx: 0, txRate: 0, rxRate: 0 } }; emit({ type: 'snapshot', snapshot: snap }); return { ok: true }; },
    forget: async ({ name }) => { cfg.networks = cfg.networks.filter((n) => n.name !== name); return cfg; },
    invite: async ({ name }) => `Xlam Connect\nСеть: ${name}\nПароль: ••••\nСервер: ${cfg.server}`,
    chat: async ({ text }) => { const m = { id: 0, nick: cfg.nick, text, ts: Date.now(), me: true }; chat.push(m); emit({ type: 'chat', message: m }); return { ok: true }; },
  };
  if (q.get('chat')) setTimeout(() => { for (const [i, [n, t]] of [['Dimon', 'го в кс?'], ['Kate', 'сейчас, 5 минут'], ['Dimon', 'ок, я создал лобби на 10.26.0.2']].entries()) { const m = { id: i + 2, nick: n, text: t, ts: Date.now() - (3 - i) * 60000 }; chat.push(m); } }, 0);
  return {
    invoke: async (m, a) => { try { return { ok: true, data: await methods[m](a) }; } catch (e) { return { ok: false, error: e.message, code: e.code }; } },
    on: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    win: { minimize() {}, maximize() {}, close() {} },
  };
}
