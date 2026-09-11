/**
 * Crypto primitives used by AirPlay/HomeKit pairing, built only on Node's crypto module:
 * Ed25519 signatures, X25519 key agreement, HKDF-SHA512, ChaCha20-Poly1305 with HAP nonces,
 * and SRP-6a (3072-bit group, SHA-512) via fast-srp-hap.
 */

import {
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { aeadDecrypt, aeadEncrypt } from './chacha20poly1305';
import { SRP, SrpClient, SrpServer } from 'fast-srp-hap';

const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

export interface RawKeyPair {
  publicKey: Buffer;
  privateKey: Buffer;
}

export function ed25519KeyPair(seed?: Buffer): RawKeyPair {
  if (seed) {
    const priv = ed25519PrivateKey(seed);
    const pub = createPublicKey(priv).export({ type: 'spki', format: 'der' }) as Buffer;
    return { publicKey: Buffer.from(pub.subarray(pub.length - 32)), privateKey: seed };
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const priv = privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer;
  return { publicKey: Buffer.from(pub.subarray(pub.length - 32)), privateKey: Buffer.from(priv.subarray(priv.length - 32)) };
}

function ed25519PrivateKey(seed: Buffer): KeyObject {
  return createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
}

function ed25519PublicKey(pub: Buffer): KeyObject {
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, pub]), format: 'der', type: 'spki' });
}

export function ed25519Sign(seed: Buffer, message: Buffer): Buffer {
  return sign(null, message, ed25519PrivateKey(seed));
}

export function ed25519Verify(pub: Buffer, message: Buffer, signature: Buffer): boolean {
  try {
    return verify(null, message, ed25519PublicKey(pub), signature);
  } catch {
    return false;
  }
}

export function x25519KeyPair(): RawKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const priv = privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer;
  return { publicKey: Buffer.from(pub.subarray(pub.length - 32)), privateKey: Buffer.from(priv.subarray(priv.length - 32)) };
}

export function x25519SharedSecret(privateKey: Buffer, peerPublic: Buffer): Buffer {
  const priv = createPrivateKey({ key: Buffer.concat([X25519_PKCS8_PREFIX, privateKey]), format: 'der', type: 'pkcs8' });
  const pub = createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, peerPublic]), format: 'der', type: 'spki' });
  return Buffer.from(diffieHellman({ privateKey: priv, publicKey: pub }));
}

export function hkdf(salt: string, info: string, ikm: Buffer, length = 32): Buffer {
  return Buffer.from(hkdfSync('sha512', ikm, Buffer.from(salt), Buffer.from(info), length));
}

/** HAP nonce: 4 zero bytes followed by the 8-byte little-endian counter (or ASCII tag). */
export function hapNonce(counterOrTag: number | Buffer): Buffer {
  const nonce = Buffer.alloc(12);
  if (typeof counterOrTag === 'number') {
    nonce.writeUInt32LE(counterOrTag >>> 0, 4);
    nonce.writeUInt32LE(Math.floor(counterOrTag / 0x100000000) >>> 0, 8);
  } else {
    counterOrTag.copy(nonce, 12 - counterOrTag.length);
  }
  return nonce;
}

// ChaCha20-Poly1305 is implemented in TypeScript because Electron's BoringSSL-based
// node:crypto does not provide the cipher (createCipheriv throws "Unknown cipher").
export function chachaEncrypt(key: Buffer, nonce: Buffer, plaintext: Buffer, aad?: Buffer): Buffer {
  return Buffer.from(aeadEncrypt(key, nonce, plaintext, aad ?? new Uint8Array(0)));
}

export function chachaDecrypt(key: Buffer, nonce: Buffer, ciphertextWithTag: Buffer, aad?: Buffer): Buffer {
  return Buffer.from(aeadDecrypt(key, nonce, ciphertextWithTag, aad ?? new Uint8Array(0)));
}

/**
 * Stateful ChaCha20-Poly1305 session with independent send/receive counters,
 * matching pyatv's Chacha20Cipher8byteNonce semantics.
 */
export class ChaChaSession {
  private outCounter = 0;
  private inCounter = 0;

  constructor(private readonly outKey: Buffer, private readonly inKey: Buffer) {}

  encrypt(data: Buffer, opts: { nonce?: Buffer; aad?: Buffer } = {}): Buffer {
    const nonce = opts.nonce ? hapNonce(opts.nonce) : hapNonce(this.outCounter++);
    return chachaEncrypt(this.outKey, nonce, data, opts.aad);
  }

  decrypt(data: Buffer, opts: { nonce?: Buffer; aad?: Buffer } = {}): Buffer {
    const nonce = opts.nonce ? hapNonce(opts.nonce) : hapNonce(this.inCounter++);
    return chachaDecrypt(this.inKey, nonce, data, opts.aad);
  }
}

/**
 * HAP transport framing (HAP spec 6.5.2): little-endian 2-byte length (of the
 * plaintext), then ciphertext + 16-byte auth tag, with the length as AAD.
 * Frames carry at most 1024 bytes of plaintext.
 */
export class HapFramer {
  private readonly cipher: ChaChaSession;
  private rxBuffer = Buffer.alloc(0);

  constructor(outKey: Buffer, inKey: Buffer) {
    this.cipher = new ChaChaSession(outKey, inKey);
  }

  encrypt(data: Buffer): Buffer {
    const frames: Buffer[] = [];
    for (let pos = 0; pos < data.length; pos += 1024) {
      const chunk = data.subarray(pos, Math.min(pos + 1024, data.length));
      const len = Buffer.alloc(2);
      len.writeUInt16LE(chunk.length, 0);
      frames.push(len, this.cipher.encrypt(chunk, { aad: len }));
    }
    return Buffer.concat(frames);
  }

  /** Feed incoming bytes; returns any fully decrypted plaintext available so far. */
  decrypt(data: Buffer): Buffer {
    this.rxBuffer = Buffer.concat([this.rxBuffer, data]);
    const out: Buffer[] = [];
    while (this.rxBuffer.length >= 2) {
      const len = this.rxBuffer.readUInt16LE(0);
      const total = 2 + len + 16;
      if (this.rxBuffer.length < total) break;
      const aad = this.rxBuffer.subarray(0, 2);
      const body = this.rxBuffer.subarray(2, total);
      out.push(this.cipher.decrypt(Buffer.from(body), { aad: Buffer.from(aad) }));
      this.rxBuffer = this.rxBuffer.subarray(total);
    }
    return Buffer.concat(out);
  }
}

// ---------------------------------------------------------------------------
// SRP-6a (HAP profile: 3072-bit group, SHA-512, identity "Pair-Setup")
// ---------------------------------------------------------------------------

export const SRP_IDENTITY = Buffer.from('Pair-Setup');

export class HapSrpClient {
  private client: SrpClient;

  constructor(salt: Buffer, pin: string, serverPublic: Buffer, secret = randomBytes(32)) {
    this.client = new SrpClient(SRP.params.hap, salt, SRP_IDENTITY, Buffer.from(pin), secret, true);
    this.client.setB(serverPublic);
  }

  get publicKey(): Buffer {
    return this.client.computeA();
  }

  get proof(): Buffer {
    return this.client.computeM1();
  }

  get sessionKey(): Buffer {
    return this.client.computeK();
  }

  verifyServerProof(m2: Buffer): boolean {
    try {
      this.client.checkM2(m2);
      return true;
    } catch {
      return false;
    }
  }
}

/** Server side of SRP, used by the mock AirPlay receiver in tests. */
export class HapSrpServer {
  readonly salt: Buffer;
  private server: SrpServer;

  constructor(pin: string, salt = randomBytes(16), secret = randomBytes(32)) {
    this.salt = salt;
    this.server = new SrpServer(SRP.params.hap, salt, SRP_IDENTITY, Buffer.from(pin), secret);
  }

  get publicKey(): Buffer {
    return this.server.computeB();
  }

  setClientPublic(a: Buffer): void {
    this.server.setA(a);
  }

  checkClientProof(m1: Buffer): boolean {
    try {
      this.server.checkM1(m1);
      return true;
    } catch {
      return false;
    }
  }

  get proof(): Buffer {
    return this.server.computeM2();
  }

  get sessionKey(): Buffer {
    return this.server.computeK();
  }
}

export function randomId(): string {
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
