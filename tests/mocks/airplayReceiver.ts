/**
 * Mock AirPlay 2 receiver used by integration tests. Implements the accessory side of
 * HAP transient pairing, PIN pair-setup (M1..M6), pair-verify (M1..M4), the encrypted
 * control channel, the event channel, and the RTSP/HTTP commands AirWing sends.
 */

import net from 'node:net';
import { randomBytes } from 'node:crypto';
import bplistCreate from 'bplist-creator';
import { parseBuffer as parseBplist } from 'bplist-parser';
import { decodeTlv, encodeTlv, Tlv, TLV_FLAG_TRANSIENT } from '../../src/main/airplay/tlv8';
import { ChaChaSession, HapFramer, HapSrpServer, ed25519KeyPair, ed25519Sign, ed25519Verify, hkdf, x25519KeyPair, x25519SharedSecret } from '../../src/main/airplay/crypto';

export interface MockAirPlayOptions {
  pin?: string;
  allowTransient?: boolean;
  name?: string;
}

interface Parsed {
  method: string;
  path: string;
  protocol: string;
  headers: Record<string, string>;
  body: Buffer;
}

function parseMessages(buf: Buffer): { messages: Parsed[]; rest: Buffer } {
  const messages: Parsed[] = [];
  let rest = buf;
  for (;;) {
    const end = rest.indexOf('\r\n\r\n');
    if (end < 0) break;
    const lines = rest.subarray(0, end).toString().split('\r\n');
    const [method, path, protocol] = (lines.shift() ?? '').split(' ');
    const headers: Record<string, string> = {};
    for (const l of lines) {
      const i = l.indexOf(':');
      if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
    }
    const len = parseInt(headers['content-length'] ?? '0', 10) || 0;
    if (rest.length < end + 4 + len) break;
    messages.push({ method, path, protocol: protocol ?? 'HTTP/1.1', headers, body: Buffer.from(rest.subarray(end + 4, end + 4 + len)) });
    rest = rest.subarray(end + 4 + len);
  }
  return { messages, rest };
}

export class MockAirPlayReceiver {
  private server: net.Server | null = null;
  private eventServer: net.Server | null = null;
  port = 0;
  eventPort = 0;
  readonly accessoryId = Buffer.from('AA:BB:CC:DD:EE:01');
  readonly ltKeys = ed25519KeyPair();
  readonly pairedClients = new Map<string, Buffer>();
  readonly log: string[] = [];
  playedUrls: string[] = [];
  stopped = 0;
  rate = 0;
  eventConnections = 0;
  private eventKeys: { out: Buffer; in: Buffer } | null = null;

  constructor(private readonly opts: MockAirPlayOptions = {}) {}

  async start(): Promise<number> {
    this.eventServer = net.createServer((sock) => {
      this.eventConnections++;
      if (this.eventKeys) {
        const framer = new HapFramer(this.eventKeys.out, this.eventKeys.in);
        // Send one event request so the client exercises its reply path.
        sock.write(framer.encrypt(Buffer.from('POST /command RTSP/1.0\r\nCSeq: 1\r\nContent-Length: 0\r\n\r\n')));
        sock.on('data', (d) => {
          try {
            framer.decrypt(d);
          } catch {
            /* ignore */
          }
        });
      }
      sock.on('error', () => undefined);
    });
    await new Promise<void>((r) => this.eventServer!.listen(0, '127.0.0.1', r));
    this.eventPort = (this.eventServer.address() as net.AddressInfo).port;
    this.server = net.createServer((sock) => this.handleConnection(sock));
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.port = (this.server.address() as net.AddressInfo).port;
    return this.port;
  }

  stop(): void {
    this.server?.close();
    this.eventServer?.close();
  }

  private handleConnection(sock: net.Socket): void {
    let rx: Buffer = Buffer.alloc(0);
    let framer: HapFramer | null = null;
    let srp: HapSrpServer | null = null;
    let transient = false;
    let setupSessionKey: Buffer | null = null;
    let verifyShared: Buffer | null = null;
    let verifySessionKey: Buffer | null = null;
    let verifyEph: { publicKey: Buffer; privateKey: Buffer } | null = null;
    let clientEphPub: Buffer | null = null;
    let pendingKeys: { out: Buffer; in: Buffer } | null = null;

    const send = (protocol: string, code: number, body?: Buffer, headers: Record<string, string> = {}, cseq?: string) => {
      const lines = [`${protocol} ${code} ${code === 200 ? 'OK' : 'Error'}`];
      if (cseq) lines.push(`CSeq: ${cseq}`);
      for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
      lines.push(`Content-Length: ${body?.length ?? 0}`, '', '');
      let out: Buffer = Buffer.concat([Buffer.from(lines.join('\r\n')), body ?? Buffer.alloc(0)]);
      if (framer) out = framer.encrypt(out);
      sock.write(out);
      if (pendingKeys) {
        framer = new HapFramer(pendingKeys.out, pendingKeys.in);
        pendingKeys = null;
      }
    };

    sock.on('error', () => undefined);
    sock.on('data', (data) => {
      let plain: Buffer;
      try {
        plain = framer ? framer.decrypt(data) : data;
      } catch (err) {
        this.log.push(`decrypt error: ${(err as Error).message}`);
        sock.destroy();
        return;
      }
      rx = Buffer.concat([rx, plain]);
      const { messages, rest } = parseMessages(rx);
      rx = rest;
      for (const m of messages) {
        this.log.push(`${m.method} ${m.path}${framer ? ' (enc)' : ''}`);
        const cseq = m.headers.cseq;
        const proto = m.protocol.startsWith('RTSP') ? 'RTSP/1.0' : 'HTTP/1.1';
        try {
          if (m.path === '/info') {
            send(proto, 200, bplistCreate({ name: this.opts.name ?? 'Mock TV', model: 'MockTV1,1', features: 2 ** 48 + 2 ** 43 + 2 ** 49 + 1, statusFlags: 0x244, pi: 'mock-pi', deviceID: 'AA:BB:CC:DD:EE:01' }), { 'Content-Type': 'application/x-apple-binary-plist' });
          } else if (m.path === '/pair-pin-start') {
            send(proto, 200);
          } else if (m.path === '/pair-setup') {
            const tlv = decodeTlv(m.body);
            const state = tlv.get(Tlv.State)?.[0];
            if (state === 1) {
              transient = (tlv.get(Tlv.Flags)?.[0] ?? 0) === TLV_FLAG_TRANSIENT;
              if (transient && this.opts.allowTransient === false) {
                send(proto, 200, encodeTlv([[Tlv.State, 2], [Tlv.Error, 0x02]]));
                continue;
              }
              srp = new HapSrpServer(transient ? '3939' : this.opts.pin ?? '1234');
              send(proto, 200, encodeTlv([[Tlv.State, 2], [Tlv.Salt, srp.salt], [Tlv.PublicKey, srp.publicKey]]));
            } else if (state === 3) {
              if (!srp) throw new Error('no srp');
              srp.setClientPublic(tlv.get(Tlv.PublicKey)!);
              if (!srp.checkClientProof(tlv.get(Tlv.Proof)!)) {
                send(proto, 200, encodeTlv([[Tlv.State, 4], [Tlv.Error, 0x02]]));
                continue;
              }
              const K = srp.sessionKey;
              if (transient) {
                pendingKeys = { out: hkdf('Control-Salt', 'Control-Read-Encryption-Key', K), in: hkdf('Control-Salt', 'Control-Write-Encryption-Key', K) };
                this.eventKeys = { out: hkdf('Events-Salt', 'Events-Write-Encryption-Key', K), in: hkdf('Events-Salt', 'Events-Read-Encryption-Key', K) };
              } else {
                setupSessionKey = hkdf('Pair-Setup-Encrypt-Salt', 'Pair-Setup-Encrypt-Info', K);
              }
              (srp as any).K = K;
              send(proto, 200, encodeTlv([[Tlv.State, 4], [Tlv.Proof, srp.proof]]));
            } else if (state === 5) {
              const K = (srp as any).K as Buffer;
              const cipher = new ChaChaSession(setupSessionKey!, setupSessionKey!);
              const inner = decodeTlv(cipher.decrypt(tlv.get(Tlv.EncryptedData)!, { nonce: Buffer.from('PS-Msg05') }));
              const clientId = inner.get(Tlv.Identifier)!;
              const clientLtpk = inner.get(Tlv.PublicKey)!;
              const sig = inner.get(Tlv.Signature)!;
              const controllerX = hkdf('Pair-Setup-Controller-Sign-Salt', 'Pair-Setup-Controller-Sign-Info', K);
              if (!ed25519Verify(clientLtpk, Buffer.concat([controllerX, clientId, clientLtpk]), sig)) {
                send(proto, 200, encodeTlv([[Tlv.State, 6], [Tlv.Error, 0x02]]));
                continue;
              }
              this.pairedClients.set(clientId.toString(), clientLtpk);
              const accessoryX = hkdf('Pair-Setup-Accessory-Sign-Salt', 'Pair-Setup-Accessory-Sign-Info', K);
              const accSig = ed25519Sign(this.ltKeys.privateKey, Buffer.concat([accessoryX, this.accessoryId, this.ltKeys.publicKey]));
              const m6 = encodeTlv([[Tlv.Identifier, this.accessoryId], [Tlv.PublicKey, this.ltKeys.publicKey], [Tlv.Signature, accSig]]);
              send(proto, 200, encodeTlv([[Tlv.State, 6], [Tlv.EncryptedData, cipher.encrypt(m6, { nonce: Buffer.from('PS-Msg06') })]]));
            }
          } else if (m.path === '/pair-verify') {
            const tlv = decodeTlv(m.body);
            const state = tlv.get(Tlv.State)?.[0];
            if (state === 1) {
              clientEphPub = tlv.get(Tlv.PublicKey)!;
              verifyEph = x25519KeyPair();
              verifyShared = x25519SharedSecret(verifyEph.privateKey, clientEphPub);
              verifySessionKey = hkdf('Pair-Verify-Encrypt-Salt', 'Pair-Verify-Encrypt-Info', verifyShared);
              const sig = ed25519Sign(this.ltKeys.privateKey, Buffer.concat([verifyEph.publicKey, this.accessoryId, clientEphPub]));
              const inner = encodeTlv([[Tlv.Identifier, this.accessoryId], [Tlv.Signature, sig]]);
              const cipher = new ChaChaSession(verifySessionKey, verifySessionKey);
              send(proto, 200, encodeTlv([[Tlv.State, 2], [Tlv.PublicKey, verifyEph.publicKey], [Tlv.EncryptedData, cipher.encrypt(inner, { nonce: Buffer.from('PV-Msg02') })]]));
            } else if (state === 3) {
              const cipher = new ChaChaSession(verifySessionKey!, verifySessionKey!);
              const inner = decodeTlv(cipher.decrypt(tlv.get(Tlv.EncryptedData)!, { nonce: Buffer.from('PV-Msg03') }));
              const clientId = inner.get(Tlv.Identifier)!.toString();
              const ltpk = this.pairedClients.get(clientId);
              if (!ltpk || !ed25519Verify(ltpk, Buffer.concat([clientEphPub!, Buffer.from(clientId), verifyEph!.publicKey]), inner.get(Tlv.Signature)!)) {
                send(proto, 200, encodeTlv([[Tlv.State, 4], [Tlv.Error, 0x02]]));
                continue;
              }
              pendingKeys = { out: hkdf('Control-Salt', 'Control-Read-Encryption-Key', verifyShared!), in: hkdf('Control-Salt', 'Control-Write-Encryption-Key', verifyShared!) };
              this.eventKeys = { out: hkdf('Events-Salt', 'Events-Write-Encryption-Key', verifyShared!), in: hkdf('Events-Salt', 'Events-Read-Encryption-Key', verifyShared!) };
              send(proto, 200, encodeTlv([[Tlv.State, 4]]));
            }
          } else if (m.method === 'SETUP') {
            if (!framer) {
              send(proto, 403, undefined, {}, cseq);
              continue;
            }
            send(proto, 200, bplistCreate({ eventPort: this.eventPort, timingPort: 0 }), { 'Content-Type': 'application/x-apple-binary-plist' }, cseq);
          } else if (m.method === 'RECORD' || m.path === '/feedback' || m.path.startsWith('/setProperty') || m.method === 'TEARDOWN' || m.method === 'SET_PARAMETER') {
            send(proto, 200, undefined, {}, cseq);
          } else if (m.path.startsWith('/rate')) {
            this.rate = parseFloat(/value=([0-9.]+)/.exec(m.path)?.[1] ?? '0');
            send(proto, 200, undefined, {}, cseq);
          } else if (m.path.startsWith('/scrub')) {
            send(proto, 200, undefined, {}, cseq);
          } else if (m.path === '/play') {
            if (!framer && (this.opts.allowTransient !== undefined || this.opts.pin)) {
              send(proto, 470, undefined, {}, cseq); // unauthenticated on a v2 receiver
              continue;
            }
            const plist = parseBplist(m.body)[0] as Record<string, unknown>;
            this.playedUrls.push(String(plist['Content-Location']));
            this.rate = 1;
            send(proto, 200, undefined, {}, cseq);
          } else if (m.path === '/playback-info') {
            send(proto, 200, bplistCreate({ duration: new bplistCreate.Real(120), position: new bplistCreate.Real(3.5), rate: new bplistCreate.Real(this.rate), readyToPlay: true }), { 'Content-Type': 'application/x-apple-binary-plist' }, cseq);
          } else if (m.path === '/stop') {
            this.stopped++;
            this.rate = 0;
            send(proto, 200, undefined, {}, cseq);
          } else {
            send(proto, 404, undefined, {}, cseq);
          }
        } catch (err) {
          this.log.push(`error handling ${m.path}: ${(err as Error).message}`);
          send(proto, 500, undefined, {}, cseq);
        }
      }
    });
  }
}

export function randomPin(): string {
  return String(1000 + (randomBytes(2).readUInt16BE(0) % 9000));
}
