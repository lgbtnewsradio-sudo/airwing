import { describe, it, expect } from 'vitest';
import { createCipheriv, getCiphers, randomBytes } from 'node:crypto';
import { aeadDecrypt, aeadEncrypt, chacha20, poly1305 } from '../../src/main/airplay/chacha20poly1305';
import vectors from './chacha-vectors.json';

const hex = (s: string) => Uint8Array.from(Buffer.from(s.replace(/\s+/g, ''), 'hex'));

describe('pure-TS ChaCha20-Poly1305', () => {
  it('matches the RFC 8439 §2.4.2 ChaCha20 vector', () => {
    const key = hex('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
    const nonce = hex('000000000000004a00000000');
    const pt = Buffer.from("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.");
    const ct = chacha20(key, nonce, 1, pt);
    expect(Buffer.from(ct).toString('hex')).toBe(
      '6e2e359a2568f98041ba0728dd0d6981e97e7aec1d4360c20a27afccfd9fae0bf91b65c5524733ab8f593dabcd62b3571639d624e65152ab8f530c359f0861d807ca0dbf500d6a6156a38e088a22b65e52bc514d16ccf806818ce91ab77937365af90bbf74a35be6b40b8eedf2785e42874d',
    );
  });

  it('matches the RFC 8439 §2.5.2 Poly1305 vector', () => {
    const key = hex('85d6be7857556d337f4452fe42d506a80103808afb0db2fd4abff6af4149f51b');
    const tag = poly1305(key, Buffer.from('Cryptographic Forum Research Group'));
    expect(Buffer.from(tag).toString('hex')).toBe('a8061dc1305136c6c22b8baf0c0127a9');
  });

  it('matches the RFC 8439 §2.8.2 AEAD vector', () => {
    const key = hex('808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f');
    const nonce = hex('070000004041424344454647');
    const aad = hex('50515253c0c1c2c3c4c5c6c7');
    const pt = Buffer.from("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.");
    const out = aeadEncrypt(key, nonce, pt, aad);
    expect(Buffer.from(out.subarray(out.length - 16)).toString('hex')).toBe('1ae10b594f09e26a7e902ecbd0600691');
    expect(Buffer.from(out.subarray(0, 16)).toString('hex')).toBe('d31a8d34648e60db7b86afbc53ef7ec2');
    expect(Buffer.from(aeadDecrypt(key, nonce, out, aad)).equals(pt)).toBe(true);
    out[3] ^= 1;
    expect(() => aeadDecrypt(key, nonce, out, aad)).toThrow();
  });

  it('matches Node\'s native implementation on recorded vectors of many sizes', () => {
    for (const v of vectors as Array<{ key: string; nonce: string; pt: string; aad: string; ct: string }>) {
      const out = aeadEncrypt(hex(v.key), hex(v.nonce), hex(v.pt), hex(v.aad));
      expect(Buffer.from(out).toString('hex')).toBe(v.ct);
      expect(Buffer.from(aeadDecrypt(hex(v.key), hex(v.nonce), hex(v.ct), hex(v.aad))).toString('hex')).toBe(v.pt);
    }
  });

  it('agrees with Node\'s native cipher on random inputs when it is available', () => {
    if (!getCiphers().includes('chacha20-poly1305')) return;
    for (let i = 0; i < 50; i++) {
      const key = randomBytes(32), nonce = randomBytes(12), pt = randomBytes(Math.floor(Math.random() * 2000)), aad = randomBytes(Math.floor(Math.random() * 40));
      const c = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
      c.setAAD(aad, { plaintextLength: pt.length });
      const native = Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
      expect(Buffer.from(aeadEncrypt(key, nonce, pt, aad)).equals(native)).toBe(true);
    }
  });
});
