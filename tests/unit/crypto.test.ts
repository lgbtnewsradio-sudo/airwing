import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { ChaChaSession, HapFramer, HapSrpClient, HapSrpServer, ed25519KeyPair, ed25519Sign, ed25519Verify, hapNonce, hkdf, x25519KeyPair, x25519SharedSecret } from '../../src/main/airplay/crypto';
import { decodeTlv, encodeTlv, Tlv } from '../../src/main/airplay/tlv8';

describe('HAP crypto primitives', () => {
  it('TLV8 round-trips including values longer than 255 bytes', () => {
    const big = randomBytes(700);
    const enc = encodeTlv([
      [Tlv.State, 3],
      [Tlv.PublicKey, big],
      [Tlv.Proof, Buffer.from([1, 2, 3])],
    ]);
    const dec = decodeTlv(enc);
    expect(dec.get(Tlv.State)![0]).toBe(3);
    expect(dec.get(Tlv.PublicKey)!.equals(big)).toBe(true);
    expect(Array.from(dec.get(Tlv.Proof)!)).toEqual([1, 2, 3]);
  });

  it('SRP client and server agree on the session key (HAP 3072/SHA-512)', () => {
    const server = new HapSrpServer('3939');
    const client = new HapSrpClient(server.salt, '3939', server.publicKey);
    server.setClientPublic(client.publicKey);
    expect(server.checkClientProof(client.proof)).toBe(true);
    expect(client.verifyServerProof(server.proof)).toBe(true);
    expect(client.sessionKey.equals(server.sessionKey)).toBe(true);
    expect(client.sessionKey.length).toBe(64);
  });

  it('rejects a wrong PIN', () => {
    const server = new HapSrpServer('1234');
    const client = new HapSrpClient(server.salt, '9999', server.publicKey);
    server.setClientPublic(client.publicKey);
    expect(server.checkClientProof(client.proof)).toBe(false);
  });

  it('ed25519 signs and verifies with raw keys', () => {
    const kp = ed25519KeyPair();
    const msg = Buffer.from('hello airplay');
    const sig = ed25519Sign(kp.privateKey, msg);
    expect(sig.length).toBe(64);
    expect(ed25519Verify(kp.publicKey, msg, sig)).toBe(true);
    expect(ed25519Verify(kp.publicKey, Buffer.from('tampered'), sig)).toBe(false);
    const again = ed25519KeyPair(kp.privateKey);
    expect(again.publicKey.equals(kp.publicKey)).toBe(true);
  });

  it('x25519 derives the same shared secret on both sides', () => {
    const a = x25519KeyPair();
    const b = x25519KeyPair();
    expect(x25519SharedSecret(a.privateKey, b.publicKey).equals(x25519SharedSecret(b.privateKey, a.publicKey))).toBe(true);
  });

  it('hapNonce matches the 4 zero bytes + 8 byte little-endian layout', () => {
    expect(hapNonce(1).toString('hex')).toBe('000000000100000000000000');
    expect(hapNonce(Buffer.from('PV-Msg02')).toString('hex')).toBe('00000000' + Buffer.from('PV-Msg02').toString('hex'));
  });

  it('ChaCha sessions encrypt/decrypt with counters and framing', () => {
    const shared = randomBytes(32);
    const out = hkdf('Control-Salt', 'Control-Write-Encryption-Key', shared);
    const inp = hkdf('Control-Salt', 'Control-Read-Encryption-Key', shared);
    const client = new HapFramer(out, inp);
    const server = new HapFramer(inp, out);
    const msg = randomBytes(3000);
    const wire = client.encrypt(msg);
    expect(wire.length).toBe(3000 + 3 * 18);
    // deliver in odd-sized pieces
    const got: Buffer[] = [];
    for (let i = 0; i < wire.length; i += 517) got.push(server.decrypt(wire.subarray(i, Math.min(i + 517, wire.length))));
    expect(Buffer.concat(got).equals(msg)).toBe(true);
    const reply = server.encrypt(Buffer.from('ok'));
    expect(client.decrypt(reply).toString()).toBe('ok');
    const s = new ChaChaSession(out, inp);
    const c1 = s.encrypt(Buffer.from('a'));
    const c2 = s.encrypt(Buffer.from('a'));
    expect(c1.equals(c2)).toBe(false); // counter advanced
  });
});
