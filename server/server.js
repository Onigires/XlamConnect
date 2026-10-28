#!/usr/bin/env node
'use strict';
/**
 * Xlam Connect coordination server (zero dependencies, Node >= 18).
 *
 *  TCP  <port>  signaling: auth, virtual IP leases, peer list, endpoint exchange
 *  UDP  <port>  (1) STUN-like endpoint reflector  (2) opaque encrypted relay
 *
 * The server never sees room passwords or traffic plaintext:
 *   - it stores only authKey (a scrypt-derived value, separate from the encryption key)
 *   - relayed packets are end-to-end encrypted between peers
 */
const net = require('net');
const dgram = require('dgram');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const VERSION = 1;
const T_STUN_REQ = 0x10, T_STUN_RES = 0x11, T_RELAY_OUT = 0x20, T_RELAY_IN = 0x21;

function parseArgs(argv) {
  const o = {
    host: process.env.XLAM_HOST || '0.0.0.0',
    port: +(process.env.XLAM_PORT || 7777),
    subnet: process.env.XLAM_SUBNET || '10.26.0.0/16',
    maxPeers: +(process.env.XLAM_MAX_PEERS || 64),
    relayMbps: +(process.env.XLAM_RELAY_MBPS || 40),
    state: process.env.XLAM_STATE || path.join(process.cwd(), 'xlam-state.json'),
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], n = () => argv[++i];
    if (a === '--host') o.host = n();
    else if (a === '--port') o.port = +n();
    else if (a === '--subnet') o.subnet = n();
    else if (a === '--max-peers') o.maxPeers = +n();
    else if (a === '--relay-mbps') o.relayMbps = +n();
    else if (a === '--state') o.state = n();
    else if (a === '--no-state') o.state = null;
    else if (a === '--quiet') o.quiet = true;
    else if (a === '-h' || a === '--help') {
      console.log(`Xlam Connect server
  --port 7777          TCP+UDP port
  --host 0.0.0.0       bind address
  --subnet 10.26.0.0/16 virtual network range handed out to peers
  --max-peers 64       max peers per network
  --relay-mbps 40      relay bandwidth cap per client (Mbit/s)
  --state FILE         persistent state (networks, IP leases)
  --no-state           keep everything in memory`);
      process.exit(0);
    }
  }
  return o;
}

const ipToInt = (s) => s.split('.').reduce((a, b) => ((a << 8) | +b) >>> 0, 0) >>> 0;
const intToIp = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');

class Server {
  constructor(opts) {
    this.o = opts;
    const [base, bits] = opts.subnet.split('/');
    this.prefix = +bits;
    this.hostBits = 32 - this.prefix;
    this.baseInt = (ipToInt(base) & (~0 << this.hostBits)) >>> 0;
    this.nets = new Map();
    this.byToken = new Map();
    this.nextId = 1;
    this.failures = new Map();
    this.saveTimer = null;
    this.load();
  }

  log(...a) { if (!this.o.quiet) console.log(new Date().toISOString().slice(11, 19), ...a); }

  /* ---------- persistence ---------- */
  load() {
    if (!this.o.state) return;
    try {
      const j = JSON.parse(fs.readFileSync(this.o.state, 'utf8'));
      for (const n of j.networks || []) {
        this.nets.set(n.name.toLowerCase(), {
          name: n.name, authKey: Buffer.from(n.authKey, 'hex'),
          leases: new Map(n.leases), members: new Map(),
        });
      }
      this.log(`state loaded: ${this.nets.size} network(s)`);
    } catch (e) { if (e.code !== 'ENOENT') this.log('state load failed:', e.message); }
  }
  save() {
    if (!this.o.state || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      const j = { networks: [...this.nets.values()].map((n) => ({ name: n.name, authKey: n.authKey.toString('hex'), leases: [...n.leases] })) };
      const tmp = this.o.state + '.tmp';
      try { fs.writeFileSync(tmp, JSON.stringify(j)); fs.renameSync(tmp, this.o.state); } catch (e) { this.log('state save failed:', e.message); }
    }, 400);
    this.saveTimer.unref?.();
  }

  /* ---------- lifecycle ---------- */
  start() {
    return new Promise((resolve, reject) => {
      this.tcp = net.createServer((s) => this.onConn(s));
      this.tcp.on('error', reject);
      this.tcp.listen(this.o.port, this.o.host, () => {
        this.port = this.tcp.address().port;
        this.udp = dgram.createSocket({ type: 'udp4' });
        this.udp.on('message', (m, r) => this.onUdp(m, r));
        this.udp.on('error', (e) => this.log('udp error', e.message));
        this.udp.bind(this.port, this.o.host, () => {
          this.udp.setRecvBufferSize?.(4 << 20); this.udp.setSendBufferSize?.(4 << 20);
          this.sweeper = setInterval(() => this.sweep(), 5000); this.sweeper.unref?.();
          this.log(`Xlam server on ${this.o.host}:${this.port} (tcp+udp), subnet ${this.o.subnet}`);
          resolve(this);
        });
      });
    });
  }
  stop() {
    clearInterval(this.sweeper);
    for (const c of this.byToken.values()) c.sock.destroy();
    this.tcp?.close(); try { this.udp?.close(); } catch {}
  }

  /* ---------- signaling ---------- */
  onConn(sock) {
    const remote = sock.remoteAddress;
    if ((this.failures.get(remote)?.blockedUntil || 0) > Date.now()) return sock.destroy();
    sock.setNoDelay(true); sock.setKeepAlive(true, 15000);
    const c = {
      sock, remote, buf: '', token: crypto.randomBytes(8), nonce: crypto.randomBytes(16),
      authed: false, net: null, id: 0, pub: null, nick: '', lan: [], pubEp: null, udp: null,
      lastSeen: Date.now(), tokens: this.o.relayMbps * 125000, tokenAt: Date.now(),
    };
    c.tokenHex = c.token.toString('hex');
    this.byToken.set(c.tokenHex, c);
    this.send(c, { t: 'hello', v: VERSION, nonce: c.nonce.toString('hex'), token: c.tokenHex, udpPort: this.port });
    c.authTimer = setTimeout(() => { if (!c.authed) sock.destroy(); }, 10000);
    sock.on('data', (d) => {
      c.buf += d.toString('utf8');
      if (c.buf.length > 65536) return sock.destroy();
      let i;
      while ((i = c.buf.indexOf('\n')) >= 0) {
        const line = c.buf.slice(0, i); c.buf = c.buf.slice(i + 1);
        if (!line.trim()) continue;
        let m; try { m = JSON.parse(line); } catch { return sock.destroy(); }
        try { this.onMsg(c, m); } catch (e) { this.log('msg error', e.message); sock.destroy(); }
      }
    });
    sock.on('close', () => this.onClose(c));
    sock.on('error', () => {});
  }

  send(c, obj) { if (!c.sock.destroyed) c.sock.write(JSON.stringify(obj) + '\n'); }

  fail(c, code, msg) {
    const f = this.failures.get(c.remote) || { n: 0, first: Date.now(), blockedUntil: 0 };
    if (Date.now() - f.first > 60000) { f.n = 0; f.first = Date.now(); }
    f.n++; if (f.n >= 12) f.blockedUntil = Date.now() + 60000;
    this.failures.set(c.remote, f);
    this.send(c, { t: 'err', code, msg });
    setTimeout(() => c.sock.destroy(), 100);
  }

  onMsg(c, m) {
    c.lastSeen = Date.now();
    switch (m.t) {
      case 'auth': return this.onAuth(c, m);
      case 'ping': return this.send(c, { t: 'pong', ts: m.ts });
      case 'lan': if (c.authed && Array.isArray(m.lan)) { c.lan = this.cleanEps(m.lan); this.announce(c); } return;
      default: return;
    }
  }

  cleanEps(a) { return a.filter((x) => typeof x === 'string' && /^\d{1,3}(\.\d{1,3}){3}:\d{1,5}$/.test(x)).slice(0, 8); }

  onAuth(c, m) {
    if (c.authed) return;
    if (m.v !== VERSION) return this.fail(c, 'version', 'Client/server protocol mismatch');
    const name = String(m.net || '').trim();
    if (name.length < 3 || name.length > 32 || /[\u0000-\u001f]/.test(name)) return this.fail(c, 'badname', 'Network name must be 3-32 characters');
    if (!/^[0-9a-f]{64}$/.test(m.pub || '')) return this.fail(c, 'badreq', 'bad key');
    const pubBuf = Buffer.from(m.pub, 'hex');
    const key = name.toLowerCase();
    let n = this.nets.get(key);

    if (m.mode === 'create') {
      if (n) return this.fail(c, 'exists', 'A network with this name already exists');
      if (!/^[0-9a-f]{64}$/.test(m.authKey || '')) return this.fail(c, 'badreq', 'bad auth key');
      n = { name, authKey: Buffer.from(m.authKey, 'hex'), leases: new Map(), members: new Map() };
      this.nets.set(key, n); this.log(`network created: ${name}`);
    } else {
      if (!n) return this.fail(c, 'notfound', 'Network not found');
    }
    const want = crypto.createHmac('sha256', n.authKey).update(c.nonce).update(pubBuf).digest();
    const got = Buffer.from(String(m.proof || ''), 'hex');
    if (got.length !== 32 || !crypto.timingSafeEqual(want, got)) {
      if (m.mode === 'create') this.nets.delete(key);
      return this.fail(c, 'badauth', 'Wrong password');
    }
    // replace stale session of the same identity
    for (const o of n.members.values()) if (o.pub === m.pub) { this.send(o, { t: 'err', code: 'replaced', msg: 'Signed in from another place' }); o.sock.destroy(); }
    if (n.members.size >= this.o.maxPeers) return this.fail(c, 'full', 'Network is full');

    let ip = n.leases.get(m.pub);
    if (ip === undefined) {
      const used = new Set(n.leases.values());
      const max = (2 ** this.hostBits) - 2;
      for (let h = 1; h <= max; h++) { const cand = (this.baseInt + h) >>> 0; if (!used.has(cand)) { ip = cand; break; } }
      if (ip === undefined) return this.fail(c, 'full', 'No free addresses');
      n.leases.set(m.pub, ip);
    }
    clearTimeout(c.authTimer);
    c.authed = true; c.net = n; c.pub = m.pub; c.ip = ip;
    c.nick = String(m.nick || 'peer').replace(/[\u0000-\u001f]/g, '').slice(0, 24) || 'peer';
    c.lan = this.cleanEps(m.lan || []);
    c.id = this.nextId++;
    n.members.set(c.id, c);
    this.save();
    this.send(c, {
      t: 'ok', id: c.id, ip: intToIp(ip), prefix: this.prefix, net: n.name,
      peers: [...n.members.values()].filter((p) => p !== c).map((p) => this.peerInfo(p)),
    });
    this.announce(c);
    this.log(`+ ${c.nick} (${intToIp(ip)}) joined "${n.name}" [${n.members.size}]`);
  }

  peerInfo(p) {
    return { id: p.id, pub: p.pub, nick: p.nick, ip: intToIp(p.ip), eps: [...(p.pubEp ? [p.pubEp] : []), ...p.lan] };
  }
  announce(c) {
    if (!c.authed) return;
    for (const o of c.net.members.values()) if (o !== c) this.send(o, { t: 'peer', peer: this.peerInfo(c) });
  }
  onClose(c) {
    clearTimeout(c.authTimer);
    this.byToken.delete(c.tokenHex);
    if (c.authed && c.net.members.get(c.id) === c) {
      c.net.members.delete(c.id);
      for (const o of c.net.members.values()) this.send(o, { t: 'gone', id: c.id });
      this.log(`- ${c.nick} left "${c.net.name}" [${c.net.members.size}]`);
    }
  }
  sweep() {
    const now = Date.now();
    for (const c of this.byToken.values()) if (now - c.lastSeen > 45000) c.sock.destroy();
    for (const [k, f] of this.failures) if (now - f.first > 120000 && f.blockedUntil < now) this.failures.delete(k);
  }

  /* ---------- UDP: reflector + relay ---------- */
  onUdp(msg, rinfo) {
    if (msg.length < 9) return;
    const type = msg[0];
    const c = this.byToken.get(msg.subarray(1, 9).toString('hex'));
    if (!c) return;
    if (type === T_STUN_REQ) {
      const ep = `${rinfo.address}:${rinfo.port}`;
      const out = Buffer.alloc(7); out[0] = T_STUN_RES;
      out.writeUInt32BE(ipToInt(rinfo.address), 1); out.writeUInt16BE(rinfo.port, 5);
      this.udp.send(out, rinfo.port, rinfo.address);
      c.udp = { address: rinfo.address, port: rinfo.port };
      if (c.pubEp !== ep) { c.pubEp = ep; this.announce(c); }
    } else if (type === T_RELAY_OUT && c.authed && msg.length > 13) {
      // rate limit (token bucket)
      const now = Date.now(), rate = this.o.relayMbps * 125000;
      c.tokens = Math.min(rate, c.tokens + ((now - c.tokenAt) / 1000) * rate); c.tokenAt = now;
      if (c.tokens < msg.length) return;
      c.tokens -= msg.length;
      const dst = c.net.members.get(msg.readUInt32BE(9));
      if (!dst || !dst.udp) return;
      const out = Buffer.allocUnsafe(msg.length - 12); out[0] = T_RELAY_IN; msg.copy(out, 1, 13);
      this.udp.send(out, dst.udp.port, dst.udp.address);
    }
  }
}

module.exports = { Server, parseArgs };

if (require.main === module) {
  const s = new Server(parseArgs(process.argv.slice(2)));
  s.start().catch((e) => { console.error('Failed to start:', e.message); process.exit(1); });
  process.on('SIGINT', () => { s.save(); setTimeout(() => process.exit(0), 600); });
}
