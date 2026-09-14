import { describe, it, expect } from 'vitest';
import { createHash, createDecipheriv, createHmac } from 'node:crypto';
import {
  fairplayMD5Compress,
  fairplayWordsFromLittleEndian,
  FairplayMD5Mutation,
  fairplaySAPHash,
  decryptFairPlayMessage,
  encryptFairPlayMessage,
  deriveFairPlayWrappingKey,
  wrapFairPlayKey,
  fpsapExchangeForSAP,
  fpsapDescriptorForSAP,
  decryptFPSAPBody,
  validateFPSAPM4,
  newFPSAPSession,
  byteSource,
  fpsapFirstTables,
  fpsapSecondTables,
  fpsapFirstInputMask,
  fpsapSubstitute,
  fpsapMix,
  type FpsapNetworkTables,
} from '../../src/main/airplay/fairplay';

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}
function fromHex(s: string): Uint8Array {
  return Uint8Array.from(Buffer.from(s, 'hex'));
}

// --- test-only helpers ported from the Go test files ---------------------

// unwrapFairPlayKeyForTest: AES-decrypt ekey[56:72] and XOR out the mask.
function unwrapFairPlayKeyForTest(
  receiverSAP: Uint8Array,
  m3: Uint8Array,
  ekey: Uint8Array,
): Uint8Array {
  const aesKey = deriveFairPlayWrappingKey(receiverSAP, m3);
  const decipher = createDecipheriv('aes-128-ecb', Buffer.from(aesKey), null);
  decipher.setAutoPadding(false);
  const dec = Uint8Array.from(
    Buffer.concat([decipher.update(Buffer.from(ekey.subarray(56, 72))), decipher.final()]),
  );
  const key = new Uint8Array(16);
  for (let i = 0; i < 16; i++) key[i] = dec[i] ^ ekey[16 + i];
  return key;
}

function fairPlayReferenceReceiverSAP(): Uint8Array {
  const sap = new Uint8Array(128);
  sap.set(
    fromHex(
      '0001cc342a5e5b1a6773c20e21b8224df862481864ef810aae2e3703c8819c23' +
        '539de5f5d749bc5b7a266c496283ce7f03937ae1f616de0c15ff338ccaffb09e' +
        'aabbe40f5d5f558fb97f1731f8f7da60a0ec6579c33ea98312c3b67135a6694f' +
        'f82305d9ba5c615fa254d2b1834583cee42d4426c835a7a5f6c8421c0da3f1c7',
    ),
    0,
  );
  return sap;
}

function fpsapReferenceLocalSAP(): Uint8Array {
  const sap = new Uint8Array(128);
  sap.set(
    fromHex(
      '0001e4e3dd688293e6fa66b95ba41768e587c65f750218ff1be21543d573cefb' +
        '087bd36e0c6363c3c8242f4abcfa6d660b801032015405eb4ab04dda7aeff38f' +
        'fb36f4cfa48f0b5d92ae363f68b45925bbe6413ab6bdc4968f548d21e67d20f' +
        '1912b6820e53f1013cde29df7350a9b9fa7c51320aea62d2949786c87642e34ba',
    ),
    0,
  );
  return sap;
}

function filledFPSAPPayload(value: number): Uint8Array {
  const p = new Uint8Array(128);
  p.fill(value);
  return p;
}
function sparseFPSAPPayload(index: number): Uint8Array {
  const p = new Uint8Array(128);
  p[index] = 0x42;
  return p;
}

// --- vectors -------------------------------------------------------------

describe('FairPlay MD5 + SAP primitives', () => {
  it('modified MD5 and SAP hash single vectors', () => {
    const block = new Uint8Array(64);
    for (let i = 0; i < 64; i++) block[i] = (i * 3 + 1) & 0xff;
    const key = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);

    const words = fairplayMD5Compress(
      fairplayWordsFromLittleEndian(key),
      block,
      FairplayMD5Mutation.KDF,
    );
    const modified = new Uint8Array(16);
    for (let i = 0; i < 4; i++) {
      const w = words[i] >>> 0;
      modified[i * 4] = w & 0xff;
      modified[i * 4 + 1] = (w >>> 8) & 0xff;
      modified[i * 4 + 2] = (w >>> 16) & 0xff;
      modified[i * 4 + 3] = (w >>> 24) & 0xff;
    }
    expect(hex(modified)).toBe('f6f728cb5a4397b675664f9291b859aa');

    expect(hex(fairplaySAPHash(block))).toBe('75498a4e218773030e9cdf04f0c49367');
  });

  it('SAP hash corpus', () => {
    const corpus = createHash('sha256');
    let state = 0x6a09e667f3bcc909n;
    const mask = (1n << 64n) - 1n;
    for (let r = 0; r < 64; r++) {
      const block = new Uint8Array(64);
      for (let i = 0; i < 64; i++) {
        state ^= (state << 13n) & mask;
        state ^= (state >> 7n) & mask;
        state ^= (state << 17n) & mask;
        state &= mask;
        block[i] = Number(state & 0xffn);
      }
      corpus.update(Buffer.from(fairplaySAPHash(block)));
    }
    expect(corpus.digest('hex')).toBe(
      '36ad2a7920076af59452d9f0c91e3b7d1aebc53f9143bd6819e39119d4535c92',
    );
  });
});

describe('FairPlay message mode vectors', () => {
  const tests: { mode: number; decrypted: string; aesKey: string }[] = [
    {
      mode: 0,
      decrypted:
        'b66a3295ffa6b56e02ed1b3d67fef74b90fe148570de65e6773669126a4905d8405644cae0b2f5ed6109c099c7aea7398dac8d623fbd69b87242b374d98f89502bb5a63e29c46a8ed0e98466966191ec1e6c8675087fde21337db1c8fab4c21db824026335f6fc37e2e5b6f53357d06994bd383d6029a0aff654fb1521bcdde4',
      aesKey: 'f7dd1ccb9e745f7951a6e325d73a1f5f',
    },
    {
      mode: 1,
      decrypted:
        '0f95c6ddc8987eda18577da2db074e7c04715af8b3914a73be1b3d6c111953017ee0a39dfcab3e0d57f2f9fbd59c5e18101788c2ab8e3cbb403bcb48b53f3e5bf74f949e79fa5ca679df4bfcb33a69b1442675d03f948fe5bd0c5ffb64b73a5ab58f46d6baae097b599624147c2487991163ecffc4d966240f9526346a10fdb0',
      aesKey: 'b44ad891396f097aa309bc132f5b8889',
    },
    {
      mode: 2,
      decrypted:
        '40f18751b44d733e0aa0416401a7d3f40375fad3ce56900602578bca14660909820e6ef3a5e943cafef5370f72c52177d9b82278b414811201a3d99202bedcca26a4d1ad08bc2669f4bae6ca54b8a120d0425edb6082f51f5aecdb547bfdb319099c9ea2729ae6a1c4480827ce9991e273843cf1c7d74ebbebc2657659bcea9f',
      aesKey: 'd38cd8efecdb20f333273c4312d9b236',
    },
    {
      mode: 3,
      decrypted:
        '70a3c30edf0e1dfa1785ce4336ed547062672a47f714a0c1f89a83d95691103dfe5cf653d4cb8299793faf33fd0d4482ef5333b41ab094a90e1baf996bcf4989783f6918397fbacddaf00a2b97556dd8099841578bc5eb1444912b47298eaf356fdd6701bb3f64e725a80eb4c6f3556195de35c93e7cc703bdd24351468e9847',
      aesKey: '769e2fe4c5ad7fbe6fd6772d00f529f4',
    },
  ];

  for (const tc of tests) {
    it(`mode ${tc.mode} decrypt/encrypt/aesKey`, () => {
      const message = new Uint8Array(164);
      message[12] = tc.mode;
      for (let i = 16; i < 144; i++) message[i] = (i * 5 + 7) & 0xff;

      const decrypted = new Uint8Array(128);
      decryptFairPlayMessage(message, decrypted);
      expect(hex(decrypted)).toBe(tc.decrypted);

      const encrypted = new Uint8Array(128);
      encryptFairPlayMessage(tc.mode, decrypted, encrypted);
      expect(hex(encrypted)).toBe(hex(message.subarray(16, 144)));

      if (tc.mode === 3) {
        const inPlace = Uint8Array.from(message);
        decryptFairPlayMessage(inPlace, inPlace.subarray(16, 144));
        expect(hex(inPlace.subarray(16, 144))).toBe(tc.decrypted);
      }

      const aesKey = deriveFairPlayWrappingKey(fairPlayReferenceReceiverSAP(), message);
      expect(hex(aesKey)).toBe(tc.aesKey);
    });
  }
});

describe('FairPlay key unwrap vector', () => {
  it('unwraps the fixed ekey', () => {
    const m3 = new Uint8Array(164);
    m3[12] = 3;
    for (let i = 16; i < 144; i++) m3[i] = (i * 5 + 7) & 0xff;
    const ekey = new Uint8Array(72);
    for (let i = 0; i < 72; i++) ekey[i] = (i * 7 + 3) & 0xff;
    const got = unwrapFairPlayKeyForTest(fairPlayReferenceReceiverSAP(), m3, ekey);
    expect(hex(got)).toBe('903e5be94732428e9965afb262b193a4');
  });
});

describe('FPSAP table data', () => {
  it('expanded table checksum', () => {
    const hash = createHash('sha256');
    let written = 0;
    const write = (data: Uint8Array): void => {
      hash.update(Buffer.from(data));
      written += data.length;
    };
    write(Uint8Array.from(fpsapFirstInputMask));
    for (const tables of [fpsapFirstTables, fpsapSecondTables] as FpsapNetworkTables[]) {
      for (const round of tables.roundSubstitution) {
        for (const ref of round) {
          const expanded = new Uint8Array(256);
          for (let value = 0; value < 256; value++) expanded[value] = fpsapSubstitute(ref, value);
          write(expanded);
        }
      }
      for (const inputTable of tables.mixColumns) {
        const expanded = new Uint8Array(256 * 4);
        for (let value = 0; value < 256; value++) {
          for (let outputByte = 0; outputByte < inputTable.length; outputByte++) {
            expanded[value * 4 + outputByte] = fpsapMix(inputTable[outputByte], value);
          }
        }
        write(expanded);
      }
      for (const ref of tables.finalSubstitution) {
        const expanded = new Uint8Array(256);
        for (let value = 0; value < 256; value++) expanded[value] = fpsapSubstitute(ref, value);
        write(expanded);
      }
    }
    expect(written).toBe(90128);
    expect(hash.digest('hex')).toBe(
      '28d0986abebe30458348dfa2957aa1d52d6f3ad5a9468c5d8a9c4139b7ca2b43',
    );
  });
});

describe('FPSAP exchange golden vectors', () => {
  const capturedM2 = fromHex(
    '46504c59030102000000008202034a114c26b77d4e2eec2c8f89fdb653b5b32d3576bc176816d110a14c3f53c08dbb936183bfdfe0a4f3c12e85216003b46f738c40c54da6c436d29d1b342d63c7b314309ae79a33bb1787709ef077cbfe4190117a3423e270fd1a2eac44da1a7934f59dc681d1b70783f228c4d077c2d495f5285c3bf8df586fc2ebfe17fb5b65',
  );
  const capturedPayload = new Uint8Array(128);
  capturedPayload.set(capturedM2.subarray(14, 142), 0);

  const tests: { name: string; payload: Uint8Array; want: string }[] = [
    { name: 'all-zeros', payload: new Uint8Array(128), want: '6f627565f3e77f5b5ede91beee7baf92e4241e0b' },
    { name: 'all-ff', payload: filledFPSAPPayload(0xff), want: 'dc2cc74f2ed55484f59f95b96082f0f5c017dd17' },
    { name: 'captured-m2', payload: capturedPayload, want: '4b911e48af23d8406368aeafbb61bfcd569e3e55' },
    { name: '42-at-0', payload: sparseFPSAPPayload(0), want: '9bfb9556b8659c2ac94b7ef9e587d71e159ea624' },
    { name: '42-at-63', payload: sparseFPSAPPayload(63), want: '150d9fa4eb456e73ba48de5779c5c996b16b3b23' },
    { name: '42-at-64', payload: sparseFPSAPPayload(64), want: 'a167db30424ff8890d085c0f1c92b2c5cc06fc45' },
    { name: '42-at-127', payload: sparseFPSAPPayload(127), want: 'd246ec5e7adc8118994b8df77146529486ac7caf' },
  ];
  for (const tc of tests) {
    it(tc.name, () => {
      const got = fpsapExchangeForSAP(
        fpsapReferenceLocalSAP(),
        decryptFPSAPBody(3, tc.payload),
      );
      expect(hex(got)).toBe(tc.want);
    });
  }
});

describe('FPSAP descriptor', () => {
  const tests: { name: string; payload: Uint8Array; want: string }[] = [
    { name: 'zero', payload: new Uint8Array(128), want: '7e38958ffe4ed433743919fe7eb16376afa4eb9e' },
    {
      name: 'one-at-zero',
      payload: (() => {
        const p = new Uint8Array(128);
        p[0] = 1;
        return p;
      })(),
      want: 'ea46797d726c6a9be43ffa72385ff97ce1c54f1b',
    },
  ];
  for (const tc of tests) {
    it(tc.name, () => {
      const got = fpsapDescriptorForSAP(fpsapReferenceLocalSAP(), decryptFPSAPBody(3, tc.payload));
      expect(hex(got)).toBe(tc.want);
    });
  }
});

describe('FPSAP session', () => {
  function writeBE32(b: Uint8Array, o: number, v: number): void {
    b[o] = (v >>> 24) & 0xff;
    b[o + 1] = (v >>> 16) & 0xff;
    b[o + 2] = (v >>> 8) & 0xff;
    b[o + 3] = v & 0xff;
  }
  function newRecord(messageType: number, payloadLength: number): Uint8Array {
    const record = new Uint8Array(12 + payloadLength);
    record.set([0x46, 0x50, 0x4c, 0x59], 0);
    record.set([3, 1, messageType, 0], 4);
    writeBE32(record, 8, payloadLength);
    return record;
  }

  it('full m1/m3 exchange and key wrap round-trip', () => {
    const m2 = new Uint8Array(142);
    m2.set([0x46, 0x50, 0x4c, 0x59], 0);
    m2.set([3, 1, 2, 0], 4);
    writeBE32(m2, 8, 130);
    m2[12] = 2;
    m2[13] = 3;
    const entropy = new Uint8Array(126);
    for (let i = 0; i < 126; i++) entropy[i] = (i + 1) & 0xff;

    const session = newFPSAPSession(byteSource(entropy));
    expect(hex(session.message1())).toBe('46504c590301010000000004020003bb');

    const m3 = session.exchangeM3(m2);
    expect(m3.length).toBe(164);
    expect(Buffer.from(m3.subarray(0, 4)).toString()).toBe('FPLY');

    const gotSAP = new Uint8Array(128);
    decryptFairPlayMessage(m3, gotSAP);
    const wantSAP = new Uint8Array(128);
    wantSAP[1] = 1;
    wantSAP.set(entropy, 2);
    expect(hex(gotSAP)).toBe(hex(wantSAP));

    const m2Ciphertext = new Uint8Array(128);
    m2Ciphertext.set(m2.subarray(14), 0);
    const wantReceiverSAP = decryptFPSAPBody(3, m2Ciphertext);
    expect(hex(session.remoteSAP)).toBe(hex(wantReceiverSAP));

    const wantTail = fpsapExchangeForSAP(wantSAP, wantReceiverSAP);
    expect(hex(m3.subarray(144))).toBe(hex(wantTail));

    const rawKey = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    const ekey = session.wrapKey(rawKey, byteSource(new Uint8Array(16).fill(0x5a)));
    expect(hex(unwrapFairPlayKeyForTest(wantReceiverSAP, m3, ekey))).toBe(hex(rawKey));

    // confirmM4 accepts an m4 whose tail matches the generated m3.
    const m4 = newRecord(4, 20);
    m4.set(m3.subarray(144), 12);
    expect(() => session.confirmM4(m4)).not.toThrow();

    expect(() => session.exchangeM3(new Uint8Array(141))).toThrow();
    for (const mode of [4, 0xff]) {
      const badMode = Uint8Array.from(m2);
      badMode[13] = mode;
      expect(() => session.exchangeM3(badMode)).toThrow();
    }
    expect(() => newFPSAPSession(byteSource(entropy.subarray(0, 125)))).toThrow();

    const otherEntropy = new Uint8Array(126).fill(0xa5);
    const otherSession = newFPSAPSession(byteSource(otherEntropy));
    const otherM3 = otherSession.exchangeM3(m2);
    expect(hex(m3.subarray(16, 144))).not.toBe(hex(otherM3.subarray(16, 144)));
  });

  it('uses receiver-selected mode', () => {
    const receiverSAP = new Uint8Array(128);
    receiverSAP[1] = 1;
    for (let i = 2; i < 128; i++) receiverSAP[i] = (i * 7 + 3) & 0xff;
    const entropy = new Uint8Array(126);
    for (let i = 0; i < 126; i++) entropy[i] = (i + 1) & 0xff;
    const wantLocalSAP = new Uint8Array(128);
    wantLocalSAP[1] = 1;
    wantLocalSAP.set(entropy, 2);

    for (const mode of [0, 1, 2, 3]) {
      const m2 = newRecord(2, 130);
      m2[12] = 2;
      m2[13] = mode;
      encryptFairPlayMessage(mode, receiverSAP, m2.subarray(14, 142));

      const session = newFPSAPSession(byteSource(entropy));
      const m3 = session.exchangeM3(m2);
      expect(m3[12]).toBe(mode);

      const gotLocalSAP = new Uint8Array(128);
      decryptFairPlayMessage(m3, gotLocalSAP);
      expect(hex(gotLocalSAP)).toBe(hex(wantLocalSAP));
      expect(hex(session.remoteSAP)).toBe(hex(receiverSAP));
      const wantTail = fpsapExchangeForSAP(wantLocalSAP, receiverSAP);
      expect(hex(m3.subarray(144))).toBe(hex(wantTail));
    }
  });

  it('validates m4 confirmation', () => {
    const m3 = new Uint8Array(164);
    for (let i = 144; i < 164; i++) m3[i] = i & 0xff;
    const m4 = new Uint8Array(32);
    m4.set([0x46, 0x50, 0x4c, 0x59], 0);
    m4.set([3, 1, 4, 0], 4);
    writeBE32(m4, 8, 20);
    m4.set(m3.subarray(144), 12);

    expect(() => validateFPSAPM4(m4, m3)).not.toThrow();
    m4[31] ^= 1;
    expect(() => validateFPSAPM4(m4, m3)).toThrow();
  });

  it('requires m3 before confirm/wrap', () => {
    const session = newFPSAPSession(byteSource(new Uint8Array(126)));
    expect(() => session.confirmM4(new Uint8Array(32))).toThrow();
    expect(() => session.wrapKey(new Uint8Array(16), byteSource(new Uint8Array(36)))).toThrow();
  });
});

describe('FairPlay key wrap', () => {
  function testFairPlayM3(mode: number): Uint8Array {
    const m3 = new Uint8Array(164);
    m3.set([0x46, 0x50, 0x4c, 0x59], 0);
    m3.set([3, 1, 3, 0], 4);
    m3[8] = 0;
    m3[9] = 0;
    m3[10] = 0;
    m3[11] = 152;
    m3[12] = mode;
    for (let i = 13; i < 164; i++) m3[i] = (i * 7 + 3) & 0xff;
    return m3;
  }
  function testFairPlayReceiverSAP(seed: number): Uint8Array {
    const sap = new Uint8Array(128);
    sap[1] = 1;
    for (let i = 2; i < 128; i++) sap[i] = (i * 11) ^ seed;
    return sap;
  }

  it('round-trips for all modes and matches HMAC prefix', () => {
    for (let mode = 0; mode <= 3; mode++) {
      const m3 = testFairPlayM3(mode);
      const receiverSAP = testFairPlayReceiverSAP(mode);
      const rawKey = new Uint8Array([
        0x10, 0x21, 0x32, 0x43, 0x54, 0x65, 0x76, 0x87, 0x98, 0xa9, 0xba, 0xcb, 0xdc, 0xed, 0xfe, mode,
      ]);
      const entropy = new Uint8Array(16);
      for (let i = 0; i < 16; i++) entropy[i] = (i + 1) & 0xff;

      const ekey = wrapFairPlayKey(receiverSAP, m3, rawKey, byteSource(entropy));
      expect(hex(ekey.subarray(0, 16))).toBe('46504c59010201000000003c00000000');
      const declaredLen =
        ((ekey[32] << 24) | (ekey[33] << 16) | (ekey[34] << 8) | ekey[35]) >>> 0;
      expect(declaredLen).toBe(16);
      expect(hex(ekey.subarray(16, 32))).toBe(hex(entropy));

      const senderSAP = new Uint8Array(128);
      decryptFairPlayMessage(m3, senderSAP);
      const macKey = fpsapDescriptorForSAP(senderSAP, receiverSAP);
      const mac = createHmac('sha1', Buffer.from(macKey));
      mac.update(Buffer.from(ekey.subarray(0, 36)));
      mac.update(Buffer.from(rawKey));
      expect(hex(ekey.subarray(36, 56))).toBe(mac.digest('hex'));

      expect(hex(unwrapFairPlayKeyForTest(receiverSAP, m3, ekey))).toBe(hex(rawKey));
    }
  });

  it('rejects invalid input', () => {
    const receiverSAP = testFairPlayReceiverSAP(3);
    expect(() =>
      wrapFairPlayKey(receiverSAP, new Uint8Array(143), new Uint8Array(16), byteSource(new Uint8Array(16))),
    ).toThrow();
    const badMode = testFairPlayM3(3);
    badMode[12] = 4;
    expect(() =>
      wrapFairPlayKey(receiverSAP, badMode, new Uint8Array(16), byteSource(new Uint8Array(16))),
    ).toThrow();
    expect(() =>
      wrapFairPlayKey(receiverSAP, testFairPlayM3(3), new Uint8Array(16), byteSource(new Uint8Array(15))),
    ).toThrow();
  });

  it('25F84 authenticated prefix + MAC key vector', () => {
    const m2 = fromHex(
      '46504c5903010200000000820201cf32a25714b2524f8aa0ad7af164e37bcf4424e200047efc0ad67afcd95ded1c2730bb591b962ed63a9c4ded88ba8fc78de64d91ccfd5c7b56da88e31f5cceafc7431995a01665a54e1939d25b94db64b9e45d8d063e1e6af07e9656162b0efa404275ea5a44d9591c7256b9fbe6513898b80227721988571650942ad946688a',
    );
    const m3 = fromHex(
      '46504c590301030000000098018f1a9c5b9228300aafe0b41f28b66a62a6cd62bf84eb623273dead10b1f034a8d568126faa133f6ad5ab91acda3839817b4d9530b679fee43ac9e950f6e7aaf1381bd2d3d5198a03bf5648890d19234270a3583e4651893be09c6c75463c42e544fec9abc9f7722a2cc254364365ef91ded76b8c00f9674b08920fb9401e4be6d52a33f2f9ed6fadb672be45c3cde5ad94f3fea5b32ee4',
    );
    const rawKey = fromHex('000102030405060708090a0b0c0d0e0f');
    const mask = fromHex('c853e777b9b65e7652d768d97c974f15');

    const m2Frame = new Uint8Array(144);
    m2Frame[12] = m2[13];
    m2Frame.set(m2.subarray(14), 16);
    const receiverSAP = new Uint8Array(128);
    decryptFairPlayMessage(m2Frame, receiverSAP);
    expect(hex(receiverSAP)).toBe(hex(fairPlayReferenceReceiverSAP()));

    const ekey = wrapFairPlayKey(receiverSAP, m3, rawKey, byteSource(mask));
    expect(hex(ekey.subarray(0, 56))).toBe(
      '46504c59010201000000003c00000000c853e777b9b65e7652d768d97c974f15000000102a53a0008888fe26bfb1e1f825f38f50d6730059',
    );
    const senderSAP = new Uint8Array(128);
    decryptFairPlayMessage(m3, senderSAP);
    const macKey = fpsapDescriptorForSAP(senderSAP, receiverSAP);
    expect(hex(macKey)).toBe('2fd95dc2c23122bc77c57b983a9188c4760db322');
  });

  it('captured playfair_decrypt ekey vector', () => {
    const m3 = fromHex(
      '46504c590301030000000098018f1a9c7d0af257b31f21f5c2d2bc814c032d457835ad0b06250574bbc7ab4a58cca6eead2c911d7f3e1e7ed4c058955dff3d5ceef014387a985bdb34995015e3dfbdacc56047cb926e093b13e9fdb5e1eee317c018bbc87fc5453c7671647da686da3d564875d03f8aea9d60092de06110bc7be0c16f391c369c75344ae47f33acfcf10e63a9b58bfce215e96001c49e4be967c5067f2a',
    );
    const ekey = fromHex(
      '46504c59010201000000003c0000000088e4f82c8178c18b4751ac24b27c0c2a00000010c899dc6965c1081de6a9d966e2ba3e34548cdbc651c322db18dc22f58fe154a60aecee18',
    );
    const got = unwrapFairPlayKeyForTest(fairPlayReferenceReceiverSAP(), m3, ekey);
    expect(hex(got)).toBe('8e1214398d46d72e7b1b8e32f80c8bf0');
  });
});
