'use strict';
const { EventEmitter } = require('events');
/** In-memory TUN used by tests and the headless dev mode. inject() = "the OS sent a packet into the adapter". */
class MemoryTun extends EventEmitter {
  constructor(cfg) { super(); this.cfg = cfg; this.received = []; this.closed = false; }
  inject(buf) { this.emit('packet', buf); }
  write(buf) { this.received.push(Buffer.from(buf)); this.emit('written', buf); }
  close() { this.closed = true; }
}
module.exports = { MemoryTun };
