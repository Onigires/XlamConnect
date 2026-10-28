'use strict';
const crypto = require('crypto');

const X_SPKI = Buffer.from('302a300506032b656e032100', 'hex');
const X_PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const PROTO = 'xlam-v1';

function generateIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  return {
    pub: publicKey.export({ type: 'spki', format: 'der' }).subarray(12).toString('hex'),
    priv: privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(16).toString('hex'),
  };
}

/** password -> { authKey (sent to server as verifier), encKey (never leaves the client) } */
function deriveRoomKeys(network, password) {
  return new Promise((resolve, reject) => {
    const salt = `${PROTO}|${network.trim().toLowerCase()}`;
    crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 << 20 }, (err, k) => {
      if (err) return reject(err);
      resolve({ authKey: k.subarray(0, 32), encKey: k.subarray(32, 64) });
    });
  });
}

const authProof = (authKey, nonce, pubBuf) => crypto.createHmac('sha256', authKey).update(nonce).update(pubBuf).digest();

/** Per-peer directional keys. The room password is mixed in, so a malicious coordinator
 *  that swaps public keys still can't read or inject traffic. */
function sessionKeys(identity, peerPubHex, encKey) {
  const priv = crypto.createPrivateKey({ key: Buffer.concat([X_PKCS8, Buffer.from(identity.priv, 'hex')]), format: 'der', type: 'pkcs8' });
  const pub = crypto.createPublicKey({ key: Buffer.concat([X_SPKI, Buffer.from(peerPubHex, 'hex')]), format: 'der', type: 'spki' });
  const shared = crypto.diffieHellman({ privateKey: priv, publicKey: pub });
  const mine = Buffer.from(identity.pub, 'hex'), theirs = Buffer.from(peerPubHex, 'hex');
  const iAmLow = Buffer.compare(mine, theirs) < 0;
  const info = Buffer.concat([Buffer.from(PROTO), iAmLow ? mine : theirs, iAmLow ? theirs : mine]);
  const okm = Buffer.from(crypto.hkdfSync('sha256', shared, encKey, info, 64));
  return { send: iAmLow ? okm.subarray(0, 32) : okm.subarray(32), recv: iAmLow ? okm.subarray(32) : okm.subarray(0, 32) };
}

/* ---- packet layer:  01 | srcId(4) | counter(8) | ciphertext | tag(16) ---- */
const HDR = 13, TAG = 16;

function seal(key, srcId, ctr, kind, body) {
  const out = Buffer.allocUnsafe(HDR + 1 + body.length + TAG);
  out[0] = 1; out.writeUInt32BE(srcId, 1); out.writeUInt32BE(Math.floor(ctr / 4294967296), 5); out.writeUInt32BE(ctr >>> 0, 9);
  const nonce = Buffer.alloc(12); out.copy(nonce, 4, 5, 13);
  const c = crypto.createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: TAG });
  c.setAAD(out.subarray(0, HDR), { plaintextLength: body.length + 1 });
  let o = HDR;
  o += c.update(Buffer.from([kind])).copy(out, o);
  if (body.length) o += c.update(body).copy(out, o);
  c.final();
  c.getAuthTag().copy(out, o);
  return out;
}

/** returns { kind, body, ctr } or null if authentication fails */
function open(key, pkt) {
  if (pkt.length < HDR + 1 + TAG || pkt[0] !== 1) return null;
  const nonce = Buffer.alloc(12); pkt.copy(nonce, 4, 5, 13);
  try {
    const d = crypto.createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: TAG });
    d.setAAD(pkt.subarray(0, HDR), { plaintextLength: pkt.length - HDR - TAG });
    d.setAuthTag(pkt.subarray(pkt.length - TAG));
    const pt = Buffer.concat([d.update(pkt.subarray(HDR, pkt.length - TAG)), d.final()]);
    return { kind: pt[0], body: pt.subarray(1), ctr: pkt.readUInt32BE(5) * 4294967296 + pkt.readUInt32BE(9) };
  } catch { return null; }
}

/** sliding replay window */
class ReplayWindow {
  constructor(size = 2048) { this.size = size; this.max = -1; this.seen = new Uint8Array(size); }
  check(ctr) { if (ctr > this.max) return true; if (this.max - ctr >= this.size) return false; return !this.seen[ctr % this.size]; }
  mark(ctr) {
    if (ctr > this.max) {
      const gap = ctr - this.max;
      if (gap >= this.size) this.seen.fill(0); else for (let i = 1; i <= gap; i++) this.seen[(this.max + i) % this.size] = 0;
      this.max = ctr;
    }
    this.seen[ctr % this.size] = 1;
  }
}

module.exports = { generateIdentity, deriveRoomKeys, authProof, sessionKeys, seal, open, ReplayWindow, HDR, TAG };
