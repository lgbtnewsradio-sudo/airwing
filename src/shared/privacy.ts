const secretName = '(?:token|pin|password|passphrase|credentials?|aesKey|aesIvMask|privateKey|secretKey|clientLTSK|clientLTPK|sharedSecret|pairingCode|authorization)';
export function redactText(text: string): string {
  return text
    .replace(new RegExp(`([?&]${secretName}=)[^&\\s"']+`, 'gi'), '$1[redacted]')
    .replace(new RegExp(`("?${secretName}"?\\s*[:=]\\s*)("[^"\\r\\n]*"|'[^'\\r\\n]*'|[^,\\s}]+)`, 'gi'), '$1"[redacted]"')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/(?:[A-Z]:\\Users\\[^"\r\n]*|\/Users\/[^"\r\n]*)/gi, '[user-path]');
}
export function sanitizeDiagnostics(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeDiagnostics);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    new RegExp(`^${secretName}$`, 'i').test(key) || /^(mediaPath|sourceId|thumbnail|appIcon|txt)$/i.test(key)
      ? '[redacted]' : sanitizeDiagnostics(item),
  ]));
  return typeof value === 'string' ? redactText(value) : value;
}
