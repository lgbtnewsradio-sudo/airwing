// FairPlay SAP (FPSAP) exchange, key derivation and the m1/m3/m4 session.
// Ported byte-for-byte from the Go reference (fpsap.go, fairplay_crypto.go).

import { createCipheriv, createHmac } from 'node:crypto';
import {
  fairplayMD5Compress,
  fairplayWordsFromLittleEndian,
  fairplayWordsBigEndian,
  FairplayMD5Mutation,
} from './md5';
import { fairplaySAPHash } from './sap';
import { decryptFairPlayMessage, encryptFairPlayMessage, fairplayMessageIV } from './message';
import {
  FpsapByteLookup,
  FpsapNetworkTables,
  substitute,
  mix,
  fpsapFirstInputMask,
  fpsapSecondOutputMask,
  fpsapFirstTables,
  fpsapSecondTables,
} from './tables';

// ---- byte helpers -------------------------------------------------------

function readLE32(b: Uint8Array, o: number): number {
  return ((b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0);
}
function writeLE32(b: Uint8Array, o: number, v: number): void {
  b[o] = v & 0xff;
  b[o + 1] = (v >>> 8) & 0xff;
  b[o + 2] = (v >>> 16) & 0xff;
  b[o + 3] = (v >>> 24) & 0xff;
}
function writeBE32(b: Uint8Array, o: number, v: number): void {
  b[o] = (v >>> 24) & 0xff;
  b[o + 1] = (v >>> 16) & 0xff;
  b[o + 2] = (v >>> 8) & 0xff;
  b[o + 3] = v & 0xff;
}
// Write a uint64 little-endian (value must fit a JS safe integer).
function writeLE64(b: Uint8Array, o: number, v: number): void {
  const lo = v >>> 0;
  const hi = Math.floor(v / 0x100000000) >>> 0;
  writeLE32(b, o, lo);
  writeLE32(b, o + 4, hi);
}
// ---- entropy source -----------------------------------------------------

export interface ByteSource {
  read(n: number): Uint8Array;
}

// byteSource wraps a Uint8Array as a sequential reader that throws on short read.
export function byteSource(data: Uint8Array): ByteSource {
  let offset = 0;
  return {
    read(n: number): Uint8Array {
      if (offset + n > data.length) {
        throw new Error('unexpected EOF from entropy source');
      }
      const slice = data.subarray(offset, offset + n);
      offset += n;
      return Uint8Array.from(slice);
    },
  };
}

// ---- fixed protocol constants -------------------------------------------

const fairplayInitialSessionKey = new Uint8Array([
  0xdc, 0xdc, 0xf3, 0xb9, 0x0b, 0x74, 0xdc, 0xfb, 0x86, 0x7f, 0xf7, 0x60, 0x16, 0x72, 0x90, 0x51,
]);

const fairplayKDFPrefix = new Uint8Array([
  0xfa, 0x9c, 0xad, 0x4d, 0x4b, 0x68, 0x26, 0x8c, 0x7f, 0xf3, 0x88, 0x99, 0xde, 0x92, 0x2e, 0x95, 0x1e,
]);

const fairplayKDFSuffix = new Uint8Array([
  0xec, 0x4e, 0x27, 0x5e, 0xfd, 0xf2, 0xe8, 0x30, 0x97, 0xae, 0x70, 0xfb, 0xe0, 0x00, 0x3f, 0x1c, 0x39,
]);

const fpsapM1Capabilities = 3;
const fpsapM1Payload = new Uint8Array([0x02, 0x00, fpsapM1Capabilities, 0xbb]);
const fpsapM3Label = new Uint8Array([0x8f, 0x1a, 0x9c]);

const fpsapDescriptorPrefix = new Uint8Array([
  0xa0, 0x44, 0x9c, 0x4d, 0x09, 0xe4, 0xbd, 0x7f, 0x6e, 0xc5, 0xd0, 0xcc, 0x35, 0x9d, 0xa7, 0x46, 0x7a,
]);

const fpsapDescriptorSuffix = new Uint8Array([
  0x97, 0xb5, 0x0f, 0x84, 0xe2, 0x15, 0x5a, 0x9c, 0x24, 0x99, 0x1c, 0xf4, 0x3a, 0x09, 0x63, 0x55, 0x47,
]);

const fpsapFixedBlock = new Uint8Array([
  0xaf, 0xc2, 0x2b, 0xa0, 0x49, 0xef, 0xfc, 0xfb, 0xfe, 0x67, 0xac, 0x5e, 0xbe, 0xf6, 0xfb, 0xcb,
]);

const fpsapFirstPositionMap = [0, 5, 10, 15, 4, 9, 14, 3, 8, 13, 2, 7, 12, 1, 6, 11];
const fpsapSecondPositionMap = [0, 13, 10, 7, 4, 1, 14, 11, 8, 5, 2, 15, 12, 9, 6, 3];

// ---- key derivation -----------------------------------------------------

// deriveFairPlayWrappingKey reproduces the 16-byte AES wrapping key that both
// FairPlay session endpoints compute from the decrypted m3 SAP and receiver SAP.
export function deriveFairPlayWrappingKey(receiverSAP: Uint8Array, message: Uint8Array): Uint8Array {
  const decrypted = new Uint8Array(128);
  decryptFairPlayMessage(message, decrypted);

  const material = new Uint8Array(320);
  let offset = 0;
  material.set(fairplayKDFPrefix, offset);
  offset += fairplayKDFPrefix.length;
  material.set(decrypted, offset);
  offset += decrypted.length;
  material.set(receiverSAP, offset);
  offset += receiverSAP.length;
  material.set(fairplayKDFSuffix, offset);
  offset += fairplayKDFSuffix.length;
  material[offset] = 0x80;
  writeLE64(material, material.length - 8, offset * 8);

  let state = fairplayWordsFromLittleEndian(fairplayInitialSessionKey);
  for (let o = 0; o < material.length; o += 64) {
    const block = material.subarray(o, o + 64);
    const modified = fairplayMD5Compress(state, block, FairplayMD5Mutation.KDF);
    const hashed = fairplaySAPHash(block);
    const next = new Array<number>(4);
    for (let word = 0; word < 4; word++) {
      next[word] = (modified[word] + readLE32(hashed, word * 4)) >>> 0;
    }
    state = next;
  }
  return fairplayWordsBigEndian(state);
}

// ---- descriptor / white-box exchange ------------------------------------

function fpsapDescriptorForSAP(m3SAP: Uint8Array, m2SAP: Uint8Array): Uint8Array {
  const padded = new Uint8Array(320);
  let offset = 0;
  padded.set(fpsapDescriptorPrefix, offset);
  offset += fpsapDescriptorPrefix.length;
  padded.set(m3SAP, offset);
  offset += m3SAP.length;
  padded.set(m2SAP, offset);
  offset += m2SAP.length;
  padded.set(fpsapDescriptorSuffix, offset);
  offset += fpsapDescriptorSuffix.length;
  padded[offset] = 0x80;
  writeLE64(padded, padded.length - 8, offset * 8);

  let state = fairplayWordsFromLittleEndian(fairplayInitialSessionKey);
  let firstFinal: number[] = [0, 0, 0, 0];
  for (let blockOffset = 0; blockOffset < padded.length; blockOffset += 64) {
    const block = padded.subarray(blockOffset, blockOffset + 64);
    const add = fairplaySAPHash(block);
    const summed = new Array<number>(4);
    for (let i = 0; i < 4; i++) {
      summed[i] = (state[i] + readLE32(add, i * 4)) >>> 0;
    }
    state = fairplayMD5Compress(summed, block, FairplayMD5Mutation.Cycle);
    if (blockOffset === padded.length - 64) {
      firstFinal = state;
      state = fairplayMD5Compress(state, block, FairplayMD5Mutation.Cycle);
    }
  }

  const out = new Uint8Array(20);
  writeBE32(out, 0, firstFinal[0]);
  out.set(fairplayWordsBigEndian(state), 4);
  return out;
}

function fpsapMasks(seed: Uint8Array): Uint8Array[] {
  const state = [0x1d4a4587, 0x92f39fcc, 0x1d87d836, 0xcdc86697];
  const suffix = new Uint8Array([
    0x57, 0xd8, 0xee, 0xcb, 0xde, 0xfb, 0xcf, 0x59, 0x1c, 0x27, 0xa2, 0xcf, 0xbe, 0xb0, 0x89,
  ]);
  const masks: Uint8Array[] = [];
  for (let i = 0; i < 9; i++) {
    const block = new Uint8Array(64);
    block.set(seed.subarray(0, 20), 0);
    block[20] = i;
    block.set(suffix, 21);
    block[36] = 0x80;
    writeLE32(block, 56, 0x320);
    masks.push(fairplayWordsBigEndian(fairplayMD5Compress(state, block, FairplayMD5Mutation.Swap)));
  }
  return masks;
}

function fpsapDigest32(left: Uint8Array, right: Uint8Array): Uint8Array {
  const block = new Uint8Array(64);
  block.set(left.subarray(0, 16), 0);
  block.set(right.subarray(0, 16), 16);
  block[32] = 0x80;
  writeLE32(block, 56, 0x100);
  const state = [0xb9f3dcdc, 0xfbdc740b, 0x60f77f86, 0x51907216];
  return fairplayWordsBigEndian(fairplayMD5Compress(state, block, FairplayMD5Mutation.Swap));
}

function fpsapMix(tables: FpsapNetworkTables, state: Uint8Array, substituted: Uint8Array): void {
  for (let word = 0; word < 4; word++) {
    const offset = word * 4;
    for (let outputByte = 0; outputByte < 4; outputByte++) {
      let mixed = 0;
      for (let inputByte = 0; inputByte < 4; inputByte++) {
        mixed ^= mix(tables.mixColumns[inputByte][outputByte], substituted[offset + inputByte]);
      }
      state[offset + outputByte] = mixed;
    }
  }
}

function fpsapFirstNetwork(masks: Uint8Array[]): Uint8Array {
  const state = Uint8Array.from(fpsapFixedBlock);
  for (let i = 0; i < 16; i++) state[i] ^= fpsapFirstInputMask[i];
  for (let bank = 0; bank < 9; bank++) {
    const substituted = new Uint8Array(16);
    for (let output = 0; output < 16; output++) {
      const input = fpsapFirstPositionMap[output];
      substituted[output] = substitute(fpsapFirstTables.roundSubstitution[bank][input], state[input]);
    }
    fpsapMix(fpsapFirstTables, state, substituted);
    for (let i = 0; i < 16; i++) state[i] ^= masks[bank][i];
  }
  const out = new Uint8Array(16);
  for (let output = 0; output < 16; output++) {
    const input = fpsapFirstPositionMap[output];
    out[output] = substitute(fpsapFirstTables.finalSubstitution[input], state[input]);
  }
  return out;
}

function fpsapSecondNetwork(inputState: Uint8Array, masks: Uint8Array[]): Uint8Array {
  const state = Uint8Array.from(inputState);
  for (let bank = 8; bank >= 0; bank--) {
    const substituted = new Uint8Array(16);
    for (let output = 0; output < 16; output++) {
      const input = fpsapSecondPositionMap[output];
      substituted[output] =
        substitute(fpsapSecondTables.roundSubstitution[bank][output], state[input]) ^ masks[bank][output];
    }
    fpsapMix(fpsapSecondTables, state, substituted);
  }
  const out = new Uint8Array(16);
  for (let output = 0; output < 16; output++) {
    const input = fpsapSecondPositionMap[output];
    out[output] =
      substitute(fpsapSecondTables.finalSubstitution[output], state[input]) ^ fpsapSecondOutputMask[output];
  }
  return out;
}

function fpsapExchangeSeed(seed: Uint8Array): Uint8Array {
  const masks = fpsapMasks(seed);
  const intermediate = fpsapFirstNetwork(masks);
  const left = fpsapDigest32(intermediate, fpsapFixedBlock);
  const whiteboxOutput = fpsapSecondNetwork(left, masks);
  const digest = fpsapDigest32(left, whiteboxOutput);

  const out = new Uint8Array(20);
  out.set(whiteboxOutput.subarray(0, 4), 0);
  out.set(digest, 4);
  return out;
}

export function fpsapExchangeForSAP(m3SAP: Uint8Array, m2SAP: Uint8Array): Uint8Array {
  return fpsapExchangeSeed(fpsapDescriptorForSAP(m3SAP, m2SAP));
}

export { fpsapDescriptorForSAP };

// ---- AES / HMAC primitives ----------------------------------------------

function aesEncryptBlock(key: Uint8Array, block: Uint8Array): Uint8Array {
  const cipher = createCipheriv('aes-128-ecb', Buffer.from(key), null);
  cipher.setAutoPadding(false);
  return Uint8Array.from(Buffer.concat([cipher.update(Buffer.from(block)), cipher.final()]));
}

function hmacSha1(key: Uint8Array, ...parts: Uint8Array[]): Uint8Array {
  const mac = createHmac('sha1', Buffer.from(key));
  for (const p of parts) mac.update(Buffer.from(p));
  return Uint8Array.from(mac.digest());
}

// ---- key wrapping -------------------------------------------------------

// wrapFairPlayKey emits the 72-byte AirPlay v3 encrypted-key record.
export function wrapFairPlayKey(
  receiverSAP: Uint8Array,
  m3: Uint8Array,
  rawKey: Uint8Array,
  entropy: ByteSource,
): Uint8Array {
  validateFPSAPRecord(m3, 3, 152, 'invalid m3');
  const mode = m3[12];
  if (mode >= fairplayMessageIV.length) {
    throw new Error(`unsupported FairPlay mode ${mode}`);
  }

  const ekey = new Uint8Array(72);
  ekey.set(
    new Uint8Array([
      0x46, 0x50, 0x4c, 0x59, 0x01, 0x02, 0x01, 0x00, 0x00, 0x00, 0x00, 0x3c, 0x00, 0x00, 0x00, 0x00,
    ]),
    0,
  );
  ekey.set(entropy.read(16), 16);
  writeBE32(ekey, 32, rawKey.length);

  const wrappingKey = deriveFairPlayWrappingKey(receiverSAP, m3);
  const masked = new Uint8Array(16);
  for (let i = 0; i < 16; i++) masked[i] = rawKey[i] ^ ekey[16 + i];
  ekey.set(aesEncryptBlock(wrappingKey, masked), 56);

  const senderSAP = new Uint8Array(128);
  decryptFairPlayMessage(m3, senderSAP);
  const macKey = fpsapDescriptorForSAP(senderSAP, receiverSAP);
  const mac = hmacSha1(macKey, ekey.subarray(0, 36), rawKey);
  ekey.set(mac, 36);
  return ekey;
}

// ---- record framing / validation ----------------------------------------

function newFPSAPRecord(messageType: number, payloadLength: number): Uint8Array {
  const record = new Uint8Array(12 + payloadLength);
  record.set([0x46, 0x50, 0x4c, 0x59], 0); // "FPLY"
  record.set([3, 1, messageType, 0], 4);
  writeBE32(record, 8, payloadLength);
  return record;
}

function validateFPSAPRecord(
  record: Uint8Array,
  messageType: number,
  payloadLength: number,
  context = 'record',
): void {
  const wantLength = 12 + payloadLength;
  if (record.length !== wantLength) {
    throw new Error(`${context}: length ${record.length}, want ${wantLength}`);
  }
  if (
    record[0] !== 0x46 ||
    record[1] !== 0x50 ||
    record[2] !== 0x4c ||
    record[3] !== 0x59
  ) {
    throw new Error(`${context}: invalid magic`);
  }
  if (record[4] !== 3 || record[5] !== 1 || record[6] !== messageType || record[7] !== 0) {
    throw new Error(`${context}: invalid version/type`);
  }
  const declared =
    ((record[8] << 24) | (record[9] << 16) | (record[10] << 8) | record[11]) >>> 0;
  if (declared !== payloadLength) {
    throw new Error(`${context}: declared payload length ${declared}, want ${payloadLength}`);
  }
}

export function validateFPSAPM4(m4: Uint8Array, m3: Uint8Array): void {
  validateFPSAPRecord(m4, 4, 20, 'invalid m4');
  if (m3.length !== 164) {
    throw new Error(`invalid m3 length ${m3.length}`);
  }
  for (let i = 0; i < 20; i++) {
    if (m4[12 + i] !== m3[144 + i]) {
      throw new Error('m4 confirmation does not match m3');
    }
  }
}

function decryptFPSAPBody(mode: number, payload: Uint8Array): Uint8Array {
  if (mode >= fairplayMessageIV.length) {
    throw new Error(`unsupported FairPlay mode ${mode}`);
  }
  const message = new Uint8Array(144);
  message[12] = mode;
  message.set(payload.subarray(0, 128), 16);
  const out = new Uint8Array(128);
  decryptFairPlayMessage(message, out);
  return out;
}

export { decryptFPSAPBody };

// ---- session ------------------------------------------------------------

export class FpsapSession {
  private localSAP: Uint8Array = new Uint8Array(128);
  remoteSAP: Uint8Array = new Uint8Array(128);
  private m3: Uint8Array = new Uint8Array(164);
  private hasM3 = false;

  constructor(entropy: ByteSource) {
    this.localSAP[1] = 1;
    this.localSAP.set(entropy.read(126), 2);
  }

  message1(): Uint8Array {
    const m1 = newFPSAPRecord(1, fpsapM1Payload.length);
    m1.set(fpsapM1Payload, 12);
    return m1;
  }

  exchangeM3(m2: Uint8Array): Uint8Array {
    validateFPSAPRecord(m2, 2, 130, 'invalid m2');
    if (m2[12] !== 2) {
      throw new Error(`invalid m2 payload marker ${m2[12]}`);
    }
    const mode = m2[13];
    if (mode >= fairplayMessageIV.length) {
      throw new Error(`m2 selected unsupported mode ${mode}`);
    }

    const m3 = newFPSAPRecord(3, 152);
    m3[12] = mode;
    m3.set(fpsapM3Label, 13);
    encryptFairPlayMessage(mode, this.localSAP, m3.subarray(16, 144));

    const m2Ciphertext = new Uint8Array(128);
    m2Ciphertext.set(m2.subarray(14, 142), 0);
    const m2SAP = decryptFPSAPBody(mode, m2Ciphertext);
    const tail = fpsapExchangeForSAP(this.localSAP, m2SAP);
    m3.set(tail, 144);
    this.remoteSAP = m2SAP;
    this.m3.set(m3, 0);
    this.hasM3 = true;
    return Uint8Array.from(m3);
  }

  confirmM4(m4: Uint8Array): void {
    if (!this.hasM3) {
      throw new Error('m3 has not been generated');
    }
    validateFPSAPM4(m4, this.m3);
  }

  wrapKey(rawKey: Uint8Array, entropy: ByteSource): Uint8Array {
    if (!this.hasM3) {
      throw new Error('m3 has not been generated');
    }
    return wrapFairPlayKey(this.remoteSAP, this.m3, rawKey, entropy);
  }
}

export function newFPSAPSession(entropy: ByteSource): FpsapSession {
  return new FpsapSession(entropy);
}
