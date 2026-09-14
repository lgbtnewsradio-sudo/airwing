// FairPlay's modified MD5 compression. It uses the standard MD5 rounds,
// constants and shifts, but reads message words big-endian and mutates the
// message schedule after round 31. Ported byte-for-byte from the Go reference
// (fairplay_md5.go). All uint32 arithmetic is masked with `>>> 0`.

export enum FairplayMD5Mutation {
  Swap = 0, // fpsapSwapMutation
  Cycle = 1, // fpsapCycleMutation
  KDF = 2, // fairplayKDFMutation
}

export const fairplayMD5Shift: number[] = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

export const fairplayMD5Constant: number[] = [
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee,
  0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
  0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa,
  0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed,
  0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
  0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05,
  0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039,
  0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
  0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
];

// Rotate a 32-bit value left by k (0..31 after masking), returning uint32.
export function rotl32(v: number, n: number): number {
  const k = ((n % 32) + 32) % 32;
  if (k === 0) return v >>> 0;
  return (((v << k) | (v >>> (32 - k))) >>> 0);
}

function readBE32(block: Uint8Array, offset: number): number {
  return (
    ((block[offset] << 24) |
      (block[offset + 1] << 16) |
      (block[offset + 2] << 8) |
      block[offset + 3]) >>>
    0
  );
}

function mutateFairplayMD5Message(
  message: number[],
  a: number,
  b: number,
  c: number,
  d: number,
  mutation: FairplayMD5Mutation,
): void {
  const swap = (i: number, j: number): void => {
    const tmp = message[i];
    message[i] = message[j];
    message[j] = tmp;
  };
  switch (mutation) {
    case FairplayMD5Mutation.Swap: {
      const indices = [
        a & 15, b & 15, c & 15, d & 15,
        (a >>> 4) & 15, (b >>> 4) & 15, (c >>> 4) & 15, (d >>> 4) & 15,
      ];
      for (let i = 0; i < indices.length; i++) {
        swap(i, indices[i]);
      }
      break;
    }
    case FairplayMD5Mutation.Cycle: {
      const indices = [
        a & 15, b & 15, c & 15, d & 15,
        (a >>> 4) & 15, (b >>> 4) & 15, (c >>> 4) & 15, (d >>> 4) & 15,
      ];
      const first = message[indices[0]];
      for (let i = 0; i < indices.length - 1; i++) {
        message[indices[i]] = message[indices[i + 1]];
      }
      message[indices[indices.length - 1]] = first;
      break;
    }
    case FairplayMD5Mutation.KDF: {
      swap(a & 15, b & 15);
      swap(c & 15, d & 15);
      for (let shift = 4; shift <= 12; shift += 4) {
        swap((a >>> shift) & 15, (b >>> shift) & 15);
      }
      break;
    }
  }
}

// fairplayMD5Compress applies one modified-MD5 compression to a 64-byte block.
// `state` is four uint32 words; the return is a fresh four-word array.
export function fairplayMD5Compress(
  state: number[],
  block: Uint8Array,
  mutation: FairplayMD5Mutation,
): number[] {
  const message: number[] = new Array(16);
  for (let i = 0; i < 16; i++) {
    message[i] = readBE32(block, i * 4);
  }

  let a = state[0] >>> 0;
  let b = state[1] >>> 0;
  let c = state[2] >>> 0;
  let d = state[3] >>> 0;

  for (let round = 0; round < 64; round++) {
    let f: number;
    let word: number;
    if (round < 16) {
      f = ((b & c) | (~b & d)) >>> 0;
      word = round;
    } else if (round < 32) {
      f = ((d & b) | (~d & c)) >>> 0;
      word = (5 * round + 1) & 15;
    } else if (round < 48) {
      f = (b ^ c ^ d) >>> 0;
      word = (3 * round + 5) & 15;
    } else {
      f = (c ^ (b | ~d)) >>> 0;
      word = (7 * round) & 15;
    }

    const sum =
      (((a + f) >>> 0) + fairplayMD5Constant[round]) >>> 0;
    const sum2 = (sum + message[word]) >>> 0;
    const rotated = rotl32(sum2, fairplayMD5Shift[round]);
    const newB = (b + rotated) >>> 0;
    // a, b, c, d = d, newB, b, c
    a = d;
    d = c;
    c = b;
    b = newB;

    if (round === 31) {
      mutateFairplayMD5Message(message, a, b, c, d, mutation);
    }
  }

  return [
    (state[0] + a) >>> 0,
    (state[1] + b) >>> 0,
    (state[2] + c) >>> 0,
    (state[3] + d) >>> 0,
  ];
}

// Read four little-endian uint32 words from 16 bytes.
export function fairplayWordsFromLittleEndian(input: Uint8Array): number[] {
  const out: number[] = new Array(4);
  for (let i = 0; i < 4; i++) {
    const o = i * 4;
    out[i] =
      ((input[o] |
        (input[o + 1] << 8) |
        (input[o + 2] << 16) |
        (input[o + 3] << 24)) >>>
        0);
  }
  return out;
}

// Emit four uint32 words as big-endian bytes (16 bytes).
export function fairplayWordsBigEndian(words: number[]): Uint8Array {
  const out = new Uint8Array(16);
  for (let i = 0; i < 4; i++) {
    const w = words[i] >>> 0;
    const o = i * 4;
    out[o] = (w >>> 24) & 0xff;
    out[o + 1] = (w >>> 16) & 0xff;
    out[o + 2] = (w >>> 8) & 0xff;
    out[o + 3] = w & 0xff;
  }
  return out;
}
