'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Server } = require('../server/server');
const { Engine, MemoryTun, generateIdentity, ipToInt } = require('../engine');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 6000, what = 'condition') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(50); }
  throw new Error('timeout waiting for ' + what);
}
function ipv4(src, dst, payload = Buffer.from('hello xlam')) {
  const b = Buffer.alloc(20 + payload.length);
  b[0] = 0x45; b.writeUInt16BE(b.length, 2); b[8] = 64; b[9] = 1;
  b.writeUInt32BE(ipToInt(src), 12); b.writeUInt32BE(ipToInt(dst), 16); payload.copy(b, 20); return b;
}
function mk(server, nick, opts = {}) {
  const tuns = [];
  const e = new Engine({ identity: generateIdentity(), nick, loopback: true, ...opts, createTun: async (cfg) => { const t = new MemoryTun(cfg); tuns.push(t); return t; } });
  e.tuns = tuns; e.addr = `127.0.0.1:${server.port}`; return e;
}

let srv;
test.before(async () => { srv = await new Server({ host: '127.0.0.1', port: 0, subnet: '10.26.0.0/16', maxPeers: 8, relayMbps: 100, state: null, quiet: true }).start(); });
test.after(() => srv.stop());

test('create/join, direct path, data, anti-spoof, broadcast, chat', async () => {
  const a = mk(srv, 'Alice'), b = mk(srv, 'Bob'), c = mk(srv, 'Carol');
  await a.connect({ server: a.addr, network: 'Game Room', password: 's3cret', create: true });
  await b.connect({ server: b.addr, network: 'game room', password: 's3cret' });
  await c.connect({ server: c.addr, network: 'GAME ROOM', password: 's3cret' });
  const ips = [a, b, c].map((e) => e.self.ip);
  assert.equal(new Set(ips).size, 3); assert.ok(ips.every((i) => i.startsWith('10.26.')));
  await waitFor(() => a.snapshot().peers.length === 2 && b.snapshot().peers.length === 2, 4000, 'peers visible');
  await waitFor(() => a.snapshot().peers.every((p) => p.path === 'direct'), 5000, 'direct path');
  const pa = a.snapshot().peers.find((p) => p.nick === 'Bob');
  assert.equal(pa.path, 'direct'); await waitFor(() => a.snapshot().peers.find((p) => p.nick === 'Bob').rtt != null, 3000, 'rtt');

  // data A -> B
  const pkt = ipv4(a.self.ip, b.self.ip);
  a.tuns[0].inject(pkt);
  await waitFor(() => b.tuns[0].received.length >= 1, 2000, 'delivery');
  assert.deepEqual(b.tuns[0].received[0], pkt);
  assert.equal(c.tuns[0].received.length, 0, 'unicast must not leak to C');

  // spoofed source dropped
  b.tuns[0].received.length = 0;
  a.tuns[0].inject(ipv4('10.26.9.9', b.self.ip));
  await sleep(300); assert.equal(b.tuns[0].received.length, 0, 'spoofed src must be dropped');

  // broadcast reaches both
  a.tuns[0].inject(ipv4(a.self.ip, '10.26.255.255'));
  await waitFor(() => b.tuns[0].received.length === 1 && c.tuns[0].received.length === 1, 2000, 'broadcast');

  // chat
  const got = new Promise((r) => c.once('chat', r));
  a.sendChat('привет всем');
  const m = await got; assert.equal(m.text, 'привет всем'); assert.equal(m.nick, 'Alice');

  // stable IP on re-join
  const oldIp = b.self.ip; await b.disconnect();
  await waitFor(() => a.snapshot().peers.length === 1, 3000, 'peer gone');
  await b.connect({ server: b.addr, network: 'Game Room', password: 's3cret' });
  assert.equal(b.self.ip, oldIp);
  await Promise.all([a.disconnect(), b.disconnect(), c.disconnect()]);
});

test('auth: wrong password, duplicate create, unknown network', async () => {
  const a = mk(srv, 'A'), b = mk(srv, 'B'), c = mk(srv, 'C'), d = mk(srv, 'D');
  await a.connect({ server: a.addr, network: 'Secure', password: 'right', create: true });
  await assert.rejects(b.connect({ server: b.addr, network: 'Secure', password: 'wrong' }), { code: 'badauth' });
  await assert.rejects(c.connect({ server: c.addr, network: 'secure', password: 'right', create: true }), { code: 'exists' });
  await assert.rejects(d.connect({ server: d.addr, network: 'Nope-net', password: 'x' }), { code: 'notfound' });
  assert.equal(b.status, 'offline');
  await a.disconnect();
});

test('relay fallback when direct is impossible', async () => {
  const a = mk(srv, 'RA', { forceRelay: true }), b = mk(srv, 'RB', { forceRelay: true });
  await a.connect({ server: a.addr, network: 'RelayNet', password: 'pw', create: true });
  await b.connect({ server: b.addr, network: 'RelayNet', password: 'pw' });
  await waitFor(() => a.snapshot().peers[0]?.path === 'relay' && b.snapshot().peers[0]?.path === 'relay', 6000, 'relay path');
  const pkt = ipv4(a.self.ip, b.self.ip, Buffer.alloc(1200, 7));
  a.tuns[0].inject(pkt);
  await waitFor(() => b.tuns[0].received.length === 1, 2000, 'relayed delivery');
  assert.deepEqual(b.tuns[0].received[0], pkt);
  assert.ok(a.snapshot().peers[0].rtt != null);
  await Promise.all([a.disconnect(), b.disconnect()]);
});

test('server drop -> auto reconnect -> traffic resumes', async () => {
  const a = mk(srv, 'XA'), b = mk(srv, 'XB');
  await a.connect({ server: a.addr, network: 'Flaky', password: 'pw', create: true });
  await b.connect({ server: b.addr, network: 'Flaky', password: 'pw' });
  await waitFor(() => a.snapshot().peers[0]?.path === 'direct', 5000, 'direct');
  for (const c of srv.byToken.values()) c.sock.destroy();
  await waitFor(() => a.status === 'reconnecting', 3000, 'reconnecting');
  await waitFor(() => a.status === 'online' && b.status === 'online' && a.snapshot().peers.length === 1, 8000, 'back online');
  await waitFor(() => a.snapshot().peers[0]?.path === 'direct' && b.snapshot().peers[0]?.path === 'direct', 6000, 'direct again').catch((e) => { console.log('DBG', JSON.stringify([a.snapshot(), b.snapshot()])); throw e; });
  const pkt = ipv4(a.self.ip, b.self.ip); a.tuns[0].inject(pkt);
  await waitFor(() => b.tuns[0].received.length >= 1, 3000, 'delivery after reconnect');
  await Promise.all([a.disconnect(), b.disconnect()]);
});
