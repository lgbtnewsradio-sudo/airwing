/** TLV8 encoding used by HomeKit/AirPlay pairing (HAP spec chapter 12). */

export const Tlv = {
  Method: 0x00,
  Identifier: 0x01,
  Salt: 0x02,
  PublicKey: 0x03,
  Proof: 0x04,
  EncryptedData: 0x05,
  State: 0x06,
  Error: 0x07,
  RetryDelay: 0x08,
  Certificate: 0x09,
  Signature: 0x0a,
  Permissions: 0x0b,
  FragmentData: 0x0c,
  FragmentLast: 0x0d,
  Name: 0x11,
  Flags: 0x13,
  Separator: 0xff,
} as const;

export const TlvError: Record<number, string> = {
  0x01: 'unknown',
  0x02: 'authentication failed (wrong PIN?)',
  0x03: 'back off',
  0x04: 'max peers',
  0x05: 'max tries',
  0x06: 'unavailable',
  0x07: 'busy',
};

export const TLV_FLAG_TRANSIENT = 0x10;

export function encodeTlv(entries: Array<[number, Uint8Array | number]>): Buffer {
  const parts: Buffer[] = [];
  for (const [tag, raw] of entries) {
    const value = typeof raw === 'number' ? Buffer.from([raw]) : Buffer.from(raw);
    if (value.length === 0) {
      parts.push(Buffer.from([tag, 0]));
      continue;
    }
    for (let pos = 0; pos < value.length; pos += 255) {
      const chunk = value.subarray(pos, Math.min(pos + 255, value.length));
      parts.push(Buffer.from([tag, chunk.length]), chunk);
    }
  }
  return Buffer.concat(parts);
}

export function decodeTlv(data: Uint8Array): Map<number, Buffer> {
  const out = new Map<number, Buffer>();
  let pos = 0;
  let lastTag = -1;
  while (pos + 2 <= data.length) {
    const tag = data[pos];
    const len = data[pos + 1];
    const value = Buffer.from(data.subarray(pos + 2, pos + 2 + len));
    if (tag === lastTag && out.has(tag)) {
      out.set(tag, Buffer.concat([out.get(tag)!, value]));
    } else {
      out.set(tag, value);
    }
    lastTag = tag;
    pos += 2 + len;
  }
  return out;
}

export function tlvErrorMessage(tlv: Map<number, Buffer>): string | undefined {
  const err = tlv.get(Tlv.Error);
  if (!err || !err.length) return undefined;
  return TlvError[err[0]] ?? `error 0x${err[0].toString(16)}`;
}
