'use strict';
/**
 * Wintun (https://www.wintun.net) adapter driven from Node through koffi.
 * Windows only, needs Administrator. Packets are raw IPv4/IPv6 (layer 3).
 */
const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const { configureAdapter } = require('./netcfg');

const ADAPTER_NAME = 'Xlam Connect';
const TUNNEL_TYPE = 'Xlam';
// fixed GUID so Windows keeps the same network profile / settings for our adapter between runs
const ADAPTER_GUID = { data1: 0x6a0b3e1c, data2: 0x51f4, data3: 0x4d3a, data4: [0x9b, 0x2d, 0x3c, 0x7e, 0x8a, 0x11, 0xc4, 0x5f] };
const RING_CAPACITY = 0x400000; // 4 MiB

function findDll(extra) {
  const cands = [
    extra,
    process.resourcesPath && path.join(process.resourcesPath, 'wintun', 'amd64', 'wintun.dll'),
    path.join(__dirname, '..', '..', 'assets', 'wintun', 'amd64', 'wintun.dll'),
  ].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error('wintun.dll not found. Reinstall the app.');
}

class WintunTun extends EventEmitter {
  static async create({ ip, prefix, mtu, dllPath, firewall = true, log = () => {} }) {
    if (process.platform !== 'win32') throw new Error('Wintun is only available on Windows');
    let koffi;
    try { koffi = require('koffi'); } catch { throw new Error('Native module "koffi" is missing. Run: npm install'); }
    const dll = koffi.load(findDll(dllPath));
    const k32 = koffi.load('kernel32.dll');
    const GUID = koffi.struct('GUID', { data1: 'uint32', data2: 'uint16', data3: 'uint16', data4: koffi.array('uint8', 8) });
    const api = {
      create: dll.func('void *WintunCreateAdapter(const char16_t *name, const char16_t *type, _In_ GUID *guid)'),
      open: dll.func('void *WintunOpenAdapter(const char16_t *name)'),
      close: dll.func('void WintunCloseAdapter(void *adapter)'),
      start: dll.func('void *WintunStartSession(void *adapter, uint32 capacity)'),
      end: dll.func('void WintunEndSession(void *session)'),
      readEvent: dll.func('void *WintunGetReadWaitEvent(void *session)'),
      recv: dll.func('void *WintunReceivePacket(void *session, _Out_ uint32 *size)'),
      release: dll.func('void WintunReleaseReceivePacket(void *session, void *packet)'),
      alloc: dll.func('void *WintunAllocateSendPacket(void *session, uint32 size)'),
      send: dll.func('void WintunSendPacket(void *session, void *packet)'),
      wait: k32.func('uint32 __stdcall WaitForSingleObject(void *handle, uint32 ms)'),
    };
    const t = new WintunTun();
    t.koffi = koffi; t.api = api;
    // a stale adapter from a crashed run would block re-creation
    try { const old = api.open(ADAPTER_NAME); if (old) api.close(old); } catch {}
    t.adapter = api.create(ADAPTER_NAME, TUNNEL_TYPE, ADAPTER_GUID);
    if (!t.adapter) throw new Error('Could not create the Wintun adapter. Run Xlam Connect as Administrator.');
    t.session = api.start(t.adapter, RING_CAPACITY);
    if (!t.session) { api.close(t.adapter); throw new Error('Could not start the Wintun session.'); }
    t.event = api.readEvent(t.session);
    t.running = true;
    await configureAdapter({ name: ADAPTER_NAME, ip, prefix, mtu, firewall, log });
    t._loop();
    return t;
  }

  // NOTE: koffi.view() makes an external ArrayBuffer, which Electron forbids (it threw on every packet and took the
  // main process down on the first inbound data). decode()/encode() copy instead and work everywhere.
  _view(ptr, len) {
    return Buffer.from(this.koffi.decode(ptr, 'uint8_t', len)); // copy out of the ring
  }

  _arr(n) { // cached fixed-size array types (creating one per packet would leak)
    this._arrs = this._arrs || new Map();
    let t = this._arrs.get(n);
    if (!t) { t = this.koffi.array('uint8_t', n); this._arrs.set(n, t); }
    return t;
  }

  async _loop() {
    const { api } = this;
    const sizeBuf = [0];
    while (this.running) {
      let got = 0;
      for (;;) {
        sizeBuf[0] = 0;
        const pkt = api.recv(this.session, sizeBuf);
        if (!pkt) break;
        const n = sizeBuf[0];
        try { if (n > 0) this.emit('packet', this._view(pkt, n)); } catch (e) { try { this.emit('error', e); } catch {} }
        api.release(this.session, pkt);
        if (++got >= 256) break; // don't starve the event loop
      }
      if (got >= 256) { await new Promise(setImmediate); continue; }
      await new Promise((resolve) => api.wait.async(this.event, 250, () => resolve()));
    }
  }

  write(buf) {
    if (!this.running) return;
    const { api, koffi } = this;
    const p = api.alloc(this.session, buf.length);
    if (!p) return; // ring full -> drop, like a real NIC
    try { koffi.encode(p, this._arr(buf.length), buf); }
    catch (e) { // Wintun has no "cancel": an allocated packet must be sent, so send zeros (IP version 0 -> the OS drops it)
      try { this.emit('error', e); } catch {}
      try { koffi.encode(p, this._arr(buf.length), Buffer.alloc(buf.length)); } catch {}
    }
    api.send(this.session, p);
  }

  async close() {
    if (!this.running) return;
    this.running = false;
    await new Promise((r) => setTimeout(r, 300)); // let the read loop leave WaitForSingleObject
    try { this.api.end(this.session); } catch {}
    try { this.api.close(this.adapter); } catch {}
  }
}

module.exports = { WintunTun, ADAPTER_NAME };
