/**
 * Pure-TypeScript ChaCha20-Poly1305 AEAD (RFC 8439).
 *
 * Electron's Node runtime links BoringSSL, which does not expose the
 * "chacha20-poly1305" cipher through node:crypto, so the HAP/AirPlay 2
 * pairing and transport encryption cannot rely on createCipheriv there.
 * Payloads are small (pairing TLVs and 1 KB transport frames), so a
 * straightforward JS implementation is fast enough.
 */

function rotl(v: number, c: number): number {
  return (v << c) | (v >>> (32 - c));
}

function chachaBlock(key: Uint32Array, counter: number, nonce: Uint32Array, out: Uint8Array): void {
  const s = new Uint32Array(16);
  s[0] = 0x61707865;
  s[1] = 0x3320646e;
  s[2] = 0x79622d32;
  s[3] = 0x6b206574;
  for (let i = 0; i < 8; i++) s[4 + i] = key[i];
  s[12] = counter >>> 0;
  s[13] = nonce[0];
  s[14] = nonce[1];
  s[15] = nonce[2];
  let x0 = s[0], x1 = s[1], x2 = s[2], x3 = s[3], x4 = s[4], x5 = s[5], x6 = s[6], x7 = s[7];
  let x8 = s[8], x9 = s[9], x10 = s[10], x11 = s[11], x12 = s[12], x13 = s[13], x14 = s[14], x15 = s[15];
  for (let i = 0; i < 10; i++) {
    // column rounds
    x0 = (x0 + x4) | 0; x12 = rotl(x12 ^ x0, 16); x8 = (x8 + x12) | 0; x4 = rotl(x4 ^ x8, 12); x0 = (x0 + x4) | 0; x12 = rotl(x12 ^ x0, 8); x8 = (x8 + x12) | 0; x4 = rotl(x4 ^ x8, 7);
    x1 = (x1 + x5) | 0; x13 = rotl(x13 ^ x1, 16); x9 = (x9 + x13) | 0; x5 = rotl(x5 ^ x9, 12); x1 = (x1 + x5) | 0; x13 = rotl(x13 ^ x1, 8); x9 = (x9 + x13) | 0; x5 = rotl(x5 ^ x9, 7);
    x2 = (x2 + x6) | 0; x14 = rotl(x14 ^ x2, 16); x10 = (x10 + x14) | 0; x6 = rotl(x6 ^ x10, 12); x2 = (x2 + x6) | 0; x14 = rotl(x14 ^ x2, 8); x10 = (x10 + x14) | 0; x6 = rotl(x6 ^ x10, 7);
    x3 = (x3 + x7) | 0; x15 = rotl(x15 ^ x3, 16); x11 = (x11 + x15) | 0; x7 = rotl(x7 ^ x11, 12); x3 = (x3 + x7) | 0; x15 = rotl(x15 ^ x3, 8); x11 = (x11 + x15) | 0; x7 = rotl(x7 ^ x11, 7);
    // diagonal rounds
    x0 = (x0 + x5) | 0; x15 = rotl(x15 ^ x0, 16); x10 = (x10 + x15) | 0; x5 = rotl(x5 ^ x10, 12); x0 = (x0 + x5) | 0; x15 = rotl(x15 ^ x0, 8); x10 = (x10 + x15) | 0; x5 = rotl(x5 ^ x10, 7);
    x1 = (x1 + x6) | 0; x12 = rotl(x12 ^ x1, 16); x11 = (x11 + x12) | 0; x6 = rotl(x6 ^ x11, 12); x1 = (x1 + x6) | 0; x12 = rotl(x12 ^ x1, 8); x11 = (x11 + x12) | 0; x6 = rotl(x6 ^ x11, 7);
    x2 = (x2 + x7) | 0; x13 = rotl(x13 ^ x2, 16); x8 = (x8 + x13) | 0; x7 = rotl(x7 ^ x8, 12); x2 = (x2 + x7) | 0; x13 = rotl(x13 ^ x2, 8); x8 = (x8 + x13) | 0; x7 = rotl(x7 ^ x8, 7);
    x3 = (x3 + x4) | 0; x14 = rotl(x14 ^ x3, 16); x9 = (x9 + x14) | 0; x4 = rotl(x4 ^ x9, 12); x3 = (x3 + x4) | 0; x14 = rotl(x14 ^ x3, 8); x9 = (x9 + x14) | 0; x4 = rotl(x4 ^ x9, 7);
  }
  const r = new Uint32Array([x0, x1, x2, x3, x4, x5, x6, x7, x8, x9, x10, x11, x12, x13, x14, x15]);
  for (let i = 0; i < 16; i++) {
    const v = (r[i] + s[i]) >>> 0;
    out[i * 4] = v & 0xff;
    out[i * 4 + 1] = (v >>> 8) & 0xff;
    out[i * 4 + 2] = (v >>> 16) & 0xff;
    out[i * 4 + 3] = (v >>> 24) & 0xff;
  }
}

function toU32LE(b: Uint8Array): Uint32Array {
  const out = new Uint32Array(b.length >>> 2);
  for (let i = 0; i < out.length; i++) out[i] = (b[i * 4] | (b[i * 4 + 1] << 8) | (b[i * 4 + 2] << 16) | (b[i * 4 + 3] << 24)) >>> 0;
  return out;
}

/** ChaCha20 stream cipher (RFC 8439 §2.4) with a 32-bit block counter. */
export function chacha20(key: Uint8Array, nonce: Uint8Array, counter: number, data: Uint8Array): Uint8Array {
  if (key.length !== 32) throw new Error('chacha20: key must be 32 bytes');
  if (nonce.length !== 12) throw new Error('chacha20: nonce must be 12 bytes');
  const k = toU32LE(key);
  const n = toU32LE(nonce);
  const out = new Uint8Array(data.length);
  const block = new Uint8Array(64);
  for (let off = 0, c = counter; off < data.length; off += 64, c++) {
    chachaBlock(k, c, n, block);
    const len = Math.min(64, data.length - off);
    for (let i = 0; i < len; i++) out[off + i] = data[off + i] ^ block[i];
  }
  return out;
}

/** Poly1305 one-time authenticator (RFC 8439 §2.5). BigInt arithmetic: inputs here are at most a few KB. */
export function poly1305(key: Uint8Array, msg: Uint8Array): Uint8Array {
  if (key.length !== 32) throw new Error('poly1305: key must be 32 bytes');
  const P = (1n << 130n) - 5n;
  const le = (b: Uint8Array): bigint => {
    let v = 0n;
    for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]);
    return v;
  };
  const r = le(key.subarray(0, 16)) & 0x0ffffffc0ffffffc0ffffffc0fffffffn;
  const s = le(key.subarray(16, 32));
  let acc = 0n;
  for (let off = 0; off < msg.length; off += 16) {
    const block = msg.subarray(off, Math.min(off + 16, msg.length));
    const n = le(block) | (1n << BigInt(8 * block.length));
    acc = ((acc + n) * r) % P;
  }
  acc = (acc + s) & ((1n << 128n) - 1n);
  const tag = new Uint8Array(16);
  for (let i = 0; i < 16; i++) tag[i] = Number((acc >> BigInt(8 * i)) & 0xffn);
  return tag;
}

function macData(aad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  const padA = (16 - (aad.length % 16)) % 16;
  const padC = (16 - (ciphertext.length % 16)) % 16;
  const out = new Uint8Array(aad.length + padA + ciphertext.length + padC + 16);
  out.set(aad, 0);
  out.set(ciphertext, aad.length + padA);
  const dv = new DataView(out.buffer);
  const lenOff = aad.length + padA + ciphertext.length + padC;
  dv.setUint32(lenOff, aad.length >>> 0, true);
  dv.setUint32(lenOff + 4, Math.floor(aad.length / 0x100000000), true);
  dv.setUint32(lenOff + 8, ciphertext.length >>> 0, true);
  dv.setUint32(lenOff + 12, Math.floor(ciphertext.length / 0x100000000), true);
  return out;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** AEAD encrypt: returns ciphertext || 16-byte tag. */
export function aeadEncrypt(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array = new Uint8Array(0)): Uint8Array {
  const otk = chacha20(key, nonce, 0, new Uint8Array(32));
  const ciphertext = chacha20(key, nonce, 1, plaintext);
  const tag = poly1305(otk, macData(aad, ciphertext));
  const out = new Uint8Array(ciphertext.length + 16);
  out.set(ciphertext);
  out.set(tag, ciphertext.length);
  return out;
}

/** AEAD decrypt of ciphertext || tag; throws on authentication failure. */
export function aeadDecrypt(key: Uint8Array, nonce: Uint8Array, data: Uint8Array, aad: Uint8Array = new Uint8Array(0)): Uint8Array {
  if (data.length < 16) throw new Error('ciphertext too short');
  const ciphertext = data.subarray(0, data.length - 16);
  const tag = data.subarray(data.length - 16);
  const otk = chacha20(key, nonce, 0, new Uint8Array(32));
  const expected = poly1305(otk, macData(aad, ciphertext));
  if (!constantTimeEqual(expected, tag)) throw new Error('Unsupported state or unable to authenticate data');
  return chacha20(key, nonce, 1, ciphertext);
}
