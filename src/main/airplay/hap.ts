/**
 * HomeKit Accessory Protocol pairing as used by AirPlay 2 receivers:
 *  - Pair-Setup (M1..M6) with an on-screen PIN, producing long-term credentials
 *  - Transient Pair-Setup (M1..M4, PIN 3939) for receivers that allow it (HomePod, some TVs)
 *  - Pair-Verify (M1..M4) using stored credentials
 * Each verification derives the Control-Salt read/write keys used to encrypt the connection.
 */

import { randomBytes } from 'node:crypto';
import type { AirPlayConnection } from './connection';
import { decodeTlv, encodeTlv, Tlv, tlvErrorMessage, TLV_FLAG_TRANSIENT } from './tlv8';
import {
  ChaChaSession,
  ed25519KeyPair,
  ed25519Sign,
  ed25519Verify,
  hkdf,
  HapSrpClient,
  randomId,
  x25519KeyPair,
  x25519SharedSecret,
} from './crypto';

export interface HapCredentials {
  /** Accessory long-term public key. */
  ltpk: Buffer;
  /** Our long-term secret key (Ed25519 seed). */
  ltsk: Buffer;
  /** Accessory pairing identifier. */
  accessoryId: Buffer;
  /** Our pairing identifier. */
  clientId: Buffer;
}

export function serializeCredentials(c: HapCredentials): string {
  return [c.ltpk, c.ltsk, c.accessoryId, c.clientId].map((b) => b.toString('hex')).join(':');
}

export function parseCredentials(s: string): HapCredentials {
  const parts = s.split(':');
  if (parts.length !== 4) throw new Error('invalid credentials');
  const [ltpk, ltsk, accessoryId, clientId] = parts.map((p) => Buffer.from(p, 'hex'));
  return { ltpk, ltsk, accessoryId, clientId };
}

export interface SessionKeys {
  outKey: Buffer;
  inKey: Buffer;
  /** Shared secret the keys were derived from (for deriving additional channel keys). */
  shared: Buffer;
}

export const CONTROL_SALT = 'Control-Salt';
export const CONTROL_WRITE = 'Control-Write-Encryption-Key';
export const CONTROL_READ = 'Control-Read-Encryption-Key';
export const EVENTS_SALT = 'Events-Salt';
export const EVENTS_WRITE = 'Events-Write-Encryption-Key';
export const EVENTS_READ = 'Events-Read-Encryption-Key';

export const TRANSIENT_PIN = '3939';

function hapHeaders(hkp: number): Record<string, string | number> {
  return {
    'User-Agent': 'AirPlay/320.20',
    Connection: 'keep-alive',
    'X-Apple-HKP': hkp,
    'Content-Type': 'application/octet-stream',
  };
}

function parseTlvResponse(body: Buffer, step: string): Map<number, Buffer> {
  const tlv = decodeTlv(body);
  const err = tlvErrorMessage(tlv);
  if (err) throw new Error(`${step}: ${err}`);
  return tlv;
}

export function deriveKeys(shared: Buffer, salt = CONTROL_SALT, writeInfo = CONTROL_WRITE, readInfo = CONTROL_READ): SessionKeys {
  return { outKey: hkdf(salt, writeInfo, shared), inKey: hkdf(salt, readInfo, shared), shared };
}

export class HapPairSetup {
  private signing = ed25519KeyPair();
  private pairingId = Buffer.from(randomId());
  private salt: Buffer | null = null;
  private serverPublic: Buffer | null = null;

  constructor(private readonly conn: AirPlayConnection) {}

  /** M1/M2: tells the receiver to show its PIN and fetches the SRP salt + public key. */
  async start(): Promise<void> {
    await this.conn.post('/pair-pin-start', { headers: hapHeaders(3), allowError: true });
    const m1 = encodeTlv([
      [Tlv.Method, 0],
      [Tlv.State, 1],
    ]);
    const resp = await this.conn.post('/pair-setup', { headers: hapHeaders(3), body: m1 });
    const tlv = parseTlvResponse(resp.body, 'pair-setup M2');
    this.salt = tlv.get(Tlv.Salt) ?? null;
    this.serverPublic = tlv.get(Tlv.PublicKey) ?? null;
    if (!this.salt || !this.serverPublic) throw new Error('pair-setup M2: missing salt/public key');
  }

  /** M3..M6 with the PIN shown on screen. Returns long-term credentials. */
  async finish(pin: string, displayName?: string): Promise<HapCredentials> {
    if (!this.salt || !this.serverPublic) throw new Error('pair-setup not started');
    const srp = new HapSrpClient(this.salt, pin.replace(/[^0-9]/g, ''), this.serverPublic);
    const m3 = encodeTlv([
      [Tlv.State, 3],
      [Tlv.PublicKey, srp.publicKey],
      [Tlv.Proof, srp.proof],
    ]);
    const r4 = await this.conn.post('/pair-setup', { headers: hapHeaders(3), body: m3 });
    const tlv4 = parseTlvResponse(r4.body, 'pair-setup M4');
    const serverProof = tlv4.get(Tlv.Proof);
    if (serverProof && !srp.verifyServerProof(serverProof)) throw new Error('pair-setup M4: receiver proof mismatch (wrong PIN?)');
    const sessionKey = srp.sessionKey;
    const controllerX = hkdf('Pair-Setup-Controller-Sign-Salt', 'Pair-Setup-Controller-Sign-Info', sessionKey);
    const encKey = hkdf('Pair-Setup-Encrypt-Salt', 'Pair-Setup-Encrypt-Info', sessionKey);
    const info = Buffer.concat([controllerX, this.pairingId, this.signing.publicKey]);
    const signature = ed25519Sign(this.signing.privateKey, info);
    const entries: Array<[number, Uint8Array]> = [
      [Tlv.Identifier, this.pairingId],
      [Tlv.PublicKey, this.signing.publicKey],
      [Tlv.Signature, signature],
    ];
    if (displayName) entries.push([Tlv.Name, opackString(displayName)]);
    const cipher = new ChaChaSession(encKey, encKey);
    const encrypted = cipher.encrypt(encodeTlv(entries), { nonce: Buffer.from('PS-Msg05') });
    const m5 = encodeTlv([
      [Tlv.State, 5],
      [Tlv.EncryptedData, encrypted],
    ]);
    const r6 = await this.conn.post('/pair-setup', { headers: hapHeaders(3), body: m5 });
    const tlv6 = parseTlvResponse(r6.body, 'pair-setup M6');
    const encData = tlv6.get(Tlv.EncryptedData);
    if (!encData) throw new Error('pair-setup M6: missing encrypted data');
    const decrypted = cipher.decrypt(encData, { nonce: Buffer.from('PS-Msg06') });
    const inner = decodeTlv(decrypted);
    const accessoryId = inner.get(Tlv.Identifier);
    const ltpk = inner.get(Tlv.PublicKey);
    const accSig = inner.get(Tlv.Signature);
    if (!accessoryId || !ltpk || !accSig) throw new Error('pair-setup M6: incomplete accessory info');
    const accessoryX = hkdf('Pair-Setup-Accessory-Sign-Salt', 'Pair-Setup-Accessory-Sign-Info', sessionKey);
    if (!ed25519Verify(ltpk, Buffer.concat([accessoryX, accessoryId, ltpk]), accSig)) {
      throw new Error('pair-setup M6: accessory signature invalid');
    }
    return { ltpk, ltsk: this.signing.privateKey, accessoryId, clientId: this.pairingId };
  }
}

/** Minimal OPACK encoding of {"name": value} used for the pairing display name. */
function opackString(name: string): Buffer {
  const key = Buffer.from('name');
  const val = Buffer.from(name);
  const enc = (b: Buffer) => (b.length <= 0x20 ? Buffer.concat([Buffer.from([0x40 + b.length]), b]) : Buffer.concat([Buffer.from([0x61, b.length]), b]));
  return Buffer.concat([Buffer.from([0xe1]), enc(key), enc(val)]);
}

/** Transient pairing: M1..M4 with the well-known PIN, then keys derived from the SRP session key. */
export async function transientPairVerify(conn: AirPlayConnection): Promise<SessionKeys> {
  await conn.post('/pair-pin-start', { headers: hapHeaders(4), allowError: true });
  const m1 = encodeTlv([
    [Tlv.Method, 0],
    [Tlv.State, 1],
    [Tlv.Flags, TLV_FLAG_TRANSIENT],
  ]);
  const r2 = await conn.post('/pair-setup', { headers: hapHeaders(4), body: m1 });
  const tlv2 = parseTlvResponse(r2.body, 'transient pair-setup M2');
  const salt = tlv2.get(Tlv.Salt);
  const serverPublic = tlv2.get(Tlv.PublicKey);
  if (!salt || !serverPublic) throw new Error('transient pair-setup M2: missing salt/public key');
  const srp = new HapSrpClient(salt, TRANSIENT_PIN, serverPublic);
  const m3 = encodeTlv([
    [Tlv.State, 3],
    [Tlv.PublicKey, srp.publicKey],
    [Tlv.Proof, srp.proof],
  ]);
  const r4 = await conn.post('/pair-setup', { headers: hapHeaders(4), body: m3 });
  const tlv4 = parseTlvResponse(r4.body, 'transient pair-setup M4');
  const proof = tlv4.get(Tlv.Proof);
  if (proof && !srp.verifyServerProof(proof)) throw new Error('transient pair-setup M4: receiver proof mismatch');
  return deriveKeys(srp.sessionKey);
}

/** Pair-Verify with stored credentials (M1..M4). */
export async function pairVerify(conn: AirPlayConnection, creds: HapCredentials): Promise<SessionKeys> {
  const eph = x25519KeyPair();
  const m1 = encodeTlv([
    [Tlv.State, 1],
    [Tlv.PublicKey, eph.publicKey],
  ]);
  const r2 = await conn.post('/pair-verify', { headers: hapHeaders(3), body: m1 });
  const tlv2 = parseTlvResponse(r2.body, 'pair-verify M2');
  const serverPublic = tlv2.get(Tlv.PublicKey);
  const encrypted = tlv2.get(Tlv.EncryptedData);
  if (!serverPublic || !encrypted) throw new Error('pair-verify M2: missing data');
  const shared = x25519SharedSecret(eph.privateKey, serverPublic);
  const sessionKey = hkdf('Pair-Verify-Encrypt-Salt', 'Pair-Verify-Encrypt-Info', shared);
  const cipher = new ChaChaSession(sessionKey, sessionKey);
  const inner = decodeTlv(cipher.decrypt(encrypted, { nonce: Buffer.from('PV-Msg02') }));
  const identifier = inner.get(Tlv.Identifier);
  const signature = inner.get(Tlv.Signature);
  if (!identifier || !signature) throw new Error('pair-verify M2: missing identifier/signature');
  if (!identifier.equals(creds.accessoryId)) throw new Error('pair-verify: receiver identity changed; re-pair required');
  const info = Buffer.concat([serverPublic, identifier, eph.publicKey]);
  if (!ed25519Verify(creds.ltpk, info, signature)) throw new Error('pair-verify: receiver signature invalid; re-pair required');
  const ourInfo = Buffer.concat([eph.publicKey, creds.clientId, serverPublic]);
  const ourSig = ed25519Sign(creds.ltsk, ourInfo);
  const m3Inner = encodeTlv([
    [Tlv.Identifier, creds.clientId],
    [Tlv.Signature, ourSig],
  ]);
  const m3 = encodeTlv([
    [Tlv.State, 3],
    [Tlv.EncryptedData, cipher.encrypt(m3Inner, { nonce: Buffer.from('PV-Msg03') })],
  ]);
  const r4 = await conn.post('/pair-verify', { headers: hapHeaders(3), body: m3 });
  parseTlvResponse(r4.body, 'pair-verify M4');
  return deriveKeys(shared);
}

export function newClientSecret(): Buffer {
  return randomBytes(32);
}
