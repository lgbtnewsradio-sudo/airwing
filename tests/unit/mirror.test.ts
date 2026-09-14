import { describe, it, expect } from 'vitest';
import { spsPpsFromAvcC, buildAvcC, spsDimensions } from '../../src/main/airplay/mirror';
import { aeadEncrypt, aeadDecrypt } from '../../src/main/airplay/chacha20poly1305';
import { hkdfSync, randomBytes } from 'node:crypto';

/**
 * Offline checks for the mirroring transport's pure pieces. The protocol itself can only be
 * proven against a live Apple TV, but the avcC framing, SPS parsing, and the ChaCha frame
 * layout (128-byte header used as AAD, size prefilled, [0,0,0,0]+LE64 nonce) are verifiable
 * here and are exactly where a single wrong byte silently breaks a real session.
 */
describe('avcC codec config', () => {
  it('round-trips SPS/PPS through build + parse', () => {
    const sps = Uint8Array.from([0x67, 0x42, 0x00, 0x1f, 0xf8, 0x0a, 0x00, 0xb7, 0x20]);
    const pps = Uint8Array.from([0x68, 0xce, 0x06, 0xe2]);
    const avcC = buildAvcC(sps, pps);
    // Matches doubletake buildAVCCConfig: version, profile/compat/level from SPS, 0xff, 0xe1.
    expect(avcC[0]).toBe(0x01);
    expect(avcC[1]).toBe(sps[1]);
    expect(avcC[2]).toBe(sps[2]);
    expect(avcC[3]).toBe(sps[3]);
    expect(avcC[4]).toBe(0xff);
    expect(avcC[5]).toBe(0xe1);
    const parts = spsPpsFromAvcC(avcC);
    expect(parts).not.toBeNull();
    expect(Buffer.from(parts!.sps)).toEqual(Buffer.from(sps));
    expect(Buffer.from(parts!.pps)).toEqual(Buffer.from(pps));
    // The 4-byte trailer (first byte 0x02) is present.
    expect(avcC[avcC.length - 4]).toBe(0x02);
  });

  it('rejects a non-avcC buffer', () => {
    expect(spsPpsFromAvcC(Uint8Array.from([0x00, 0x00, 0x00, 0x01, 0x67]))).toBeNull();
  });
});

describe('SPS dimension parsing', () => {
  it('reads 1280x720 from a baseline SPS (doubletake vector)', () => {
    const sps = Uint8Array.from([0x67, 0x42, 0x00, 0x1f, 0xf8, 0x0a, 0x00, 0xb7, 0x20]);
    expect(spsDimensions(sps)).toEqual({ width: 1280, height: 720 });
  });

  it('rejects a non-SPS NAL', () => {
    expect(spsDimensions(Uint8Array.from([0x61, 0x80, 0x00, 0x00]))).toBeNull();
  });

  it('rejects a truncated SPS', () => {
    expect(spsDimensions(Uint8Array.from([0x67, 0x42]))).toBeNull();
  });
});

/**
 * Reproduce the exact video-frame layout sendVideoFrame produces and prove the receiver can
 * authenticate + decrypt it: header is 128 bytes with the payload size (incl. tag) at [0:4],
 * type 0x00 at [4], IDR flag at [5], NTP ts at [8:16], timeline at [40:48]; the whole header
 * is the AAD; nonce is [0,0,0,0] + LE64(counter).
 */
function frameHeader(au: Buffer, keyframe: boolean, ts: bigint, timeline: bigint): Buffer {
  const header = Buffer.alloc(128);
  header.writeUInt32LE(au.length + 16, 0);
  header[4] = 0x00;
  header[5] = keyframe ? 0x10 : 0x00;
  header.writeBigUInt64LE(ts & 0xffffffffffffffffn, 8);
  header.writeBigUInt64LE(timeline & 0xffffffffffffffffn, 40);
  return header;
}

function nonceFor(counter: bigint): Buffer {
  const nonce = Buffer.alloc(12); // [0,0,0,0] + LE64(counter)
  nonce.writeBigUInt64LE(counter, 4);
  return nonce;
}

describe('video frame ChaCha layout', () => {
  it('a frame encrypted with the mirror layout decrypts with the header as AAD', () => {
    const shared = randomBytes(32);
    const connId = 1234567890123;
    const key = Buffer.from(hkdfSync('sha512', shared, Buffer.from(`DataStream-Salt${connId}`), Buffer.from('DataStream-Output-Encryption-Key'), 32));
    const au = randomBytes(200);
    const header = frameHeader(au, true, 0x0000000100000000n, 0xdeadbeefn);
    const nonce = nonceFor(0n);
    const ct = Buffer.from(aeadEncrypt(key, nonce, au, header));
    expect(ct.length).toBe(au.length + 16);
    expect(header.readUInt32LE(0)).toBe(ct.length);
    expect(Buffer.from(aeadDecrypt(key, nonce, ct, header))).toEqual(au);
  });

  it('fails authentication if the header AAD is altered', () => {
    const key = randomBytes(32);
    const au = randomBytes(64);
    const header = frameHeader(au, false, 0n, 0n);
    const nonce = nonceFor(0n);
    const ct = Buffer.from(aeadEncrypt(key, nonce, au, header));
    const tampered = Buffer.from(header);
    tampered[5] = 0x10; // flip the keyframe flag in the AAD
    expect(() => aeadDecrypt(key, nonce, ct, tampered)).toThrow();
  });
});
