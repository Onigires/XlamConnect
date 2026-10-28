'use strict';
/**
 * Xlam Connect client engine.
 *
 *   TUN adapter  <->  Engine  <->  UDP (direct, hole-punched)  or  UDP via server relay
 *                       |
 *                       +--- TCP signaling to the coordination server
 *
 * Pure Node, no native deps; the TUN device is injected (Wintun on Windows, in-memory for tests).
 */
const { EventEmitter } = require('events');
const dgram = require('dgram');
const net = require('net');
const dns = require('dns');
const os = require('os');
const C = require('./crypto');

const VERSION = 1;
const T_STUN_REQ = 0x10, T_STUN_RES = 0x11, T_RELAY_OUT = 0x20, T_RELAY_IN = 0x21, T_PEER = 0x01;
const K_DATA = 0, K_PING = 1, K_PONG = 2, K_CHAT = 3;
const MTU = 1380;

const ipToInt = (s) => s.split('.').reduce((a, b) => ((a << 8) | +b) >>> 0, 0) >>> 0;
const intToIp = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
const nowUs = () => Number(process.hrtime.bigint() / 1000n);

class Peer {
  constructor(info) {
    this.id = info.id; this.pub = info.pub; this.nick = info.nick; this.ip = info.ip; this.ipInt = ipToInt(info.ip);
    this.eps = info.eps || [];
    this.keys = null; this.ctr = 0; this.replay = new C.ReplayWindow();
    this.direct = null;            // { ip, port, lastRx }
    this.relayLastRx = 0;
    this.rttDirect = null; this.rttRelay = null;
    this.tx = 0; this.rx = 0; this.txPrev = 0; this.rxPrev = 0; this.txRate = 0; this.rxRate = 0;
    this.lastPingDirect = 0; this.lastPingRelay = 0; this.lastSeen = 0; this.since = Date.now();
  }
}

class Engine extends EventEmitter {
  /**
   * @param {object} o
   * @param {{pub:string,priv:string}} o.identity
   * @param {string} o.nick
   * @param {(cfg:{ip:string,prefix:number,mtu:number})=>Promise<object>} o.createTun  returns TUN device (EventEmitter: 'packet'; write(); close())
   * @param {boolean} [o.loopback]  include 127.0.0.1 as LAN candidate (tests)
   * @param {boolean} [o.forceRelay] never use direct paths (tests / diagnostics)
   */
  constructor(o) {
    super();
    this.o = o; this.identity = o.identity; this.nick = o.nick || 'peer';
    this.status = 'offline'; this.error = null;
    this.peers = new Map();
    this.self = null; this.network = null; this.publicEp = null; this.serverRtt = null;
    this.tun = null; this.udp = null; this.sig = null;
    this.totals = { tx: 0, rx: 0, txRate: 0, rxRate: 0 }; this._tp = { tx: 0, rx: 0 };
    this._timers = []; this._wantUp = false;
  }

  log(...a) { this.emit('log', a.join(' ')); }

  /* ================= public API ================= */

  async connect({ server, network, password, create }) {
    if (this.status !== 'offline') throw new Error('Already connected');
    this._wantUp = true; this.error = null;
    this._set('connecting');
    try {
      const [host, portStr] = String(server).trim().split(':');
      if (!host) throw this._err('badserver', 'Server address is empty');
      this.server = { host, port: +(portStr || 7777) };
      this.network = network.trim();
      this.mode = create ? 'create' : 'join';
      this.keys = await C.deriveRoomKeys(this.network, password);
      this.server.ip = await new Promise((res, rej) => dns.lookup(host, { family: 4 }, (e, a) => (e ? rej(this._err('dns', `Can't resolve ${host}`)) : res(a))));
      await this._openUdp();
      const ok = await this._signal(this.mode);
      await this._onJoined(ok, true);
      this._startTimers();
      this._set('online');
    } catch (e) {
      this._joining = false; this._queue = [];
      await this._teardown();
      this.error = e.message; this._set('offline');
      throw e;
    }
  }

  async disconnect() { this._wantUp = false; await this._teardown(); this._set('offline'); }

  sendChat(text) {
    text = String(text).slice(0, 1000);
    for (const p of this.peers.values()) this._sendPeer(p, K_CHAT, Buffer.from(text));
  }

  snapshot() {
    const now = Date.now();
    return {
      status: this.status, error: this.error, network: this.network, server: this.server && `${this.server.host}:${this.server.port}`,
      you: this.self && { id: this.self.id, nick: this.nick, ip: this.self.ip, publicEp: this.publicEp },
      serverRtt: this.serverRtt, totals: { ...this.totals },
      peers: [...this.peers.values()].map((p) => ({
        id: p.id, nick: p.nick, ip: p.ip, path: this._path(p, now),
        rtt: this._path(p, now) === 'direct' ? p.rttDirect : p.rttRelay,
        tx: p.tx, rx: p.rx, txRate: p.txRate, rxRate: p.rxRate, lastSeen: p.lastSeen,
      })).sort((a, b) => a.nick.localeCompare(b.nick)),
    };
  }

  /* ================= setup / teardown ================= */

  _err(code, msg) { const e = new Error(msg); e.code = code; return e; }
  _set(s) { this.status = s; this._emitSnap(); }
  _emitSnap() { this.emit('snapshot', this.snapshot()); }

  _openUdp() {
    return new Promise((resolve, reject) => {
      const s = dgram.createSocket({ type: 'udp4' });
      s.on('error', (e) => this.log('udp error', e.message));
      s.on('message', (m, r) => { try { this._onUdp(m, r); } catch (e) { this.log('udp handler', e.stack || e.message); } });
      s.once('error', reject);
      s.bind(0, () => {
        s.removeListener('error', reject);
        try { s.setRecvBufferSize(4 << 20); s.setSendBufferSize(4 << 20); } catch {}
        this.udp = s; this.udpPort = s.address().port; resolve();
      });
    });
  }

  /** open TCP signaling, auth, resolve with the server's 'ok' message */
  _signal(mode) {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host: this.server.ip, port: this.server.port });
      let buf = '', hello = null, done = false;
      const fin = (err, val) => { if (done) return; done = true; clearTimeout(to); err ? (sock.destroy(), reject(err)) : resolve(val); };
      const to = setTimeout(() => fin(this._err('timeout', `Server ${this.server.host}:${this.server.port} did not respond`)), 10000);
      sock.setNoDelay(true); sock.setKeepAlive(true, 15000);
      sock.on('error', (e) => fin(this._err('conn', `Can't reach server: ${e.code || e.message}`)));
      sock.on('close', () => { if (!done) fin(this._err('conn', 'Connection closed')); else if (this.sig === sock) this._onSignalClosed(); });
      sock.on('data', (d) => {
        buf += d.toString('utf8'); let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          let m; try { m = JSON.parse(line); } catch { return sock.destroy(); }
          if (m.t === 'hello' && !hello) {
            hello = m; this.token = Buffer.from(m.token, 'hex'); this.srvUdpPort = m.udpPort;
            this._waitStun(1200).then(() => {
              if (done) return;
              const pub = Buffer.from(this.identity.pub, 'hex');
              const msg = { t: 'auth', v: VERSION, net: this.network, mode, pub: this.identity.pub, nick: this.nick, lan: this._lanEps(),
                proof: C.authProof(this.keys.authKey, Buffer.from(m.nonce, 'hex'), pub).toString('hex') };
              if (mode === 'create') msg.authKey = this.keys.authKey.toString('hex');
              sock.write(JSON.stringify(msg) + '\n');
            });
          } else if (m.t === 'ok' && !done) { this.sig = sock; this._joining = true; this._queue = []; fin(null, m); }
          else if (m.t === 'err' && !done) fin(this._err(m.code, m.msg));
          else if (done) this._onSignalMsg(m);
        }
      });
    });
  }

  /** ask the reflector for our public endpoint; resolve when it answers (or after `ms`) */
  _waitStun(ms) {
    this._stunSeen = false;
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => { if (this._stunSeen || Date.now() - t0 > ms) return resolve(); this._stun(); setTimeout(tick, 150); };
      tick();
    });
  }

  async _onJoined(ok, first) {
    this.self = { id: ok.id, ip: ok.ip, ipInt: ipToInt(ok.ip), prefix: ok.prefix };
    const known = new Map(this.peers);
    this.peers = new Map();
    for (const info of ok.peers) this._addPeer(info, known.get(info.id));
    if (first || !this.tun) {
      try { this.tun = await this.o.createTun({ ip: ok.ip, prefix: ok.prefix, mtu: MTU }); }
      catch (e) { throw this._err('tun', e.message); }
      this.tun.on('packet', (b) => { try { this._onTunPacket(b); } catch (e) { this.log('tun packet', e.message); } });
      this.tun.on('error', (e) => this.log('tun error', e.message));
    }
    this._bcast = (ipToInt(ok.ip) | (~(0xffffffff << (32 - ok.prefix)) >>> 0)) >>> 0;
    this._joining = false;
    const q = this._queue || []; this._queue = [];
    for (const m of q) this._onSignalMsg(m);
    this._emitSnap();
  }

  _onSignalMsg(m) {
    if (this._joining) { this._queue.push(m); return; } // arrived between 'ok' and the end of _onJoined
    if (m.t === 'peer') { this._addPeer(m.peer, this.peers.get(m.peer.id)); this._emitSnap(); }
    else if (m.t === 'gone') { if (this.peers.delete(m.id)) { this._emitSnap(); } }
    else if (m.t === 'pong') this.serverRtt = Math.round((nowUs() - m.ts) / 100) / 10;
    else if (m.t === 'err') { this.error = m.msg; this.log('server:', m.msg); if (m.code === 'replaced') this._wantUp = false; }
  }

  _onSignalClosed() {
    this.sig = null;
    if (!this._wantUp || this.status === 'offline') return;
    this._set('reconnecting');
    this._reconnect(0);
  }

  async _reconnect(attempt) {
    const delay = Math.min(15000, 1000 * 2 ** attempt);
    await new Promise((r) => setTimeout(r, delay));
    if (!this._wantUp || this.status !== 'reconnecting') return;
    try {
      let ok;
      try { ok = await this._signal('join'); }
      catch (e) { if (e.code === 'notfound') ok = await this._signal('create'); else throw e; }
      await this._onJoined(ok, false);
      this.error = null; this._set('online');
    } catch (e) {
      this._joining = false; this._queue = [];
      this.error = e.message;
      if (e.code === 'badauth' || e.code === 'full' || this._wantUp === false) { this.log('giving up:', e.message); await this.disconnect(); return; }
      this._reconnect(attempt + 1);
    }
  }

  async _teardown() {
    this._timers.forEach(clearInterval); this._timers = [];
    try { this.sig?.destroy(); } catch {} this.sig = null;
    try { this.udp?.close(); } catch {} this.udp = null;
    try { await this.tun?.close(); } catch {} this.tun = null;
    this.peers = new Map(); this.self = null; this.publicEp = null; this.serverRtt = null;
  }

  _startTimers() {
    let n = 0;
    this._timers.push(setInterval(() => {
      n++;
      const now = Date.now();
      for (const p of this.peers.values()) this._tickPeer(p, now);
      if (n % 5 === 0) this._stun();
      if (n % 5 === 0 && this.sig) this.sig.write(JSON.stringify({ t: 'ping', ts: nowUs() }) + '\n');
      // rates
      let tx = 0, rx = 0;
      for (const p of this.peers.values()) { p.txRate = p.tx - p.txPrev; p.rxRate = p.rx - p.rxPrev; p.txPrev = p.tx; p.rxPrev = p.rx; tx += p.tx; rx += p.rx; }
      this.totals = { tx, rx, txRate: tx - this._tp.tx, rxRate: rx - this._tp.rx }; this._tp = { tx, rx };
      this._emitSnap();
    }, 1000));
  }

  /* ================= endpoints ================= */

  _lanEps() {
    const out = [];
    for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) {
      if (a.family !== 'IPv4' || a.address.startsWith('169.254.')) continue;
      if (a.internal && !this.o.loopback) continue;
      if (this.self && a.address.startsWith(this.self.ip.split('.').slice(0, 2).join('.') + '.')) continue; // our own virtual adapter
      out.push(`${a.address}:${this.udpPort}`);
    }
    return out;
  }

  _stun() {
    if (!this.udp || !this.token) return;
    const b = Buffer.alloc(9); b[0] = T_STUN_REQ; this.token.copy(b, 1);
    this.udp.send(b, this.srvUdpPort, this.server.ip);
  }

  /* ================= peers & paths ================= */

  _addPeer(info, old) {
    if (info.pub === this.identity.pub) return;
    let p = old;
    if (!p || p.pub !== info.pub) { p = new Peer(info); p.keys = C.sessionKeys(this.identity, info.pub, this.keys.encKey); this.log(`peer ${info.nick} ${info.ip}`); }
    p.nick = info.nick; p.ip = info.ip; p.ipInt = ipToInt(info.ip); p.eps = info.eps || [];
    this.peers.set(p.id, p);
    this._probe(p, Date.now(), true);
  }

  _path(p, now) {
    if (p.direct && now - p.direct.lastRx < 6000) return 'direct';
    if (p.relayLastRx && now - p.relayLastRx < 12000) return 'relay';
    return 'connecting';
  }

  _tickPeer(p, now) {
    const path = this._path(p, now);
    if (path === 'direct') { if (now - p.lastPingDirect >= 2000) this._probe(p, now); }
    else this._probe(p, now);
  }

  _probe(p, now, force) {
    const path = this._path(p, now);
    const body = Buffer.alloc(8); body.writeBigUInt64BE(BigInt(nowUs()));
    if (!this.o.forceRelay && (force || path !== 'direct' || now - p.lastPingDirect >= 2000)) {
      p.lastPingDirect = now;
      const targets = path === 'direct' ? [[p.direct.ip, p.direct.port]] : p.eps.slice(0, 8).map((e) => e.split(':')).map(([h, pt]) => [h, +pt]);
      for (const [h, pt] of targets) this._sendRawDirect(p, K_PING, body, h, pt);
    }
    if (path !== 'direct' && (force || now - p.lastPingRelay >= 3000)) { p.lastPingRelay = now; this._sendRawRelay(p, K_PING, body); }
  }

  /* ================= send ================= */

  _seal(p, kind, body) { return C.seal(p.keys.send, this.self.id, p.ctr++, kind, body); }

  _sendRawDirect(p, kind, body, host, port) {
    if (!this.udp || !p.keys) return; const pkt = this._seal(p, kind, body); this.udp.send(pkt, port, host); return pkt.length;
  }
  _sendRawRelay(p, kind, body) {
    if (!this.udp || !p.keys || !this.token) return;
    const pkt = this._seal(p, kind, body);
    const out = Buffer.allocUnsafe(13 + pkt.length); out[0] = T_RELAY_OUT; this.token.copy(out, 1); out.writeUInt32BE(p.id, 9); pkt.copy(out, 13);
    this.udp.send(out, this.srvUdpPort, this.server.ip); return out.length;
  }

  _sendPeer(p, kind, body) {
    const path = this._path(p, Date.now());
    const n = path === 'direct' ? this._sendRawDirect(p, kind, body, p.direct.ip, p.direct.port) : this._sendRawRelay(p, kind, body);
    if (n) { p.tx += n; }
  }

  _onTunPacket(buf) {
    if (!this.self || buf.length < 20 || buf[0] >> 4 !== 4) return;
    const dst = buf.readUInt32BE(16);
    if (dst === this.self.ipInt) return;
    if (dst === this._bcast || dst === 0xffffffff || (dst >>> 28) === 0xe) { for (const p of this.peers.values()) this._sendPeer(p, K_DATA, buf); return; }
    for (const p of this.peers.values()) if (p.ipInt === dst) return this._sendPeer(p, K_DATA, buf);
  }

  /* ================= receive ================= */

  _onUdp(msg, r) {
    const fromServer = r.address === this.server?.ip && r.port === this.srvUdpPort;
    if (fromServer) {
      if (msg[0] === T_STUN_RES && msg.length >= 7) { this.publicEp = `${intToIp(msg.readUInt32BE(1))}:${msg.readUInt16BE(5)}`; this._stunSeen = true; }
      else if (msg[0] === T_RELAY_IN) this._onPeerPacket(msg.subarray(1), null);
    } else if (msg[0] === T_PEER) this._onPeerPacket(msg, r);
  }

  _onPeerPacket(pkt, r) {
    if (pkt.length < C.HDR + 1 + C.TAG || !this.self) return;
    const p = this.peers.get(pkt.readUInt32BE(1));
    if (!p) return;
    const ctr = pkt.readUInt32BE(5) * 4294967296 + pkt.readUInt32BE(9);
    if (!p.replay.check(ctr)) return;
    const m = C.open(p.keys.recv, pkt);
    if (!m) return;
    p.replay.mark(ctr);
    const now = Date.now();
    p.rx += pkt.length; p.lastSeen = now;
    if (r) p.direct = { ip: r.address, port: r.port, lastRx: now }; else p.relayLastRx = now;
    const reply = (kind, body) => (r ? this._sendRawDirect(p, kind, body, r.address, r.port) : this._sendRawRelay(p, kind, body));

    switch (m.kind) {
      case K_DATA: {
        const b = m.body;
        if (b.length < 20 || b[0] >> 4 !== 4 || b.readUInt32BE(12) !== p.ipInt) return; // anti-spoof
        try { this.tun?.write(b); } catch (e) { this.log('tun write', e.message); }
        break;
      }
      case K_PING: reply(K_PONG, m.body); break;
      case K_PONG: {
        if (m.body.length !== 8) break;
        const rtt = Math.max(0, (nowUs() - Number(m.body.readBigUInt64BE())) / 1000);
        const v = Math.round(rtt * 10) / 10;
        if (r) p.rttDirect = v; else p.rttRelay = v;
        break;
      }
      case K_CHAT: this.emit('chat', { id: p.id, nick: p.nick, ip: p.ip, text: m.body.toString('utf8').slice(0, 1000), ts: now }); break;
    }
  }
}

module.exports = { Engine, MTU, ipToInt, intToIp };
