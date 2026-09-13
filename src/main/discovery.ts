/**
 * mDNS/DNS-SD discovery of AirPlay, Google Cast and AirWing web receivers.
 * Queries every LAN interface so devices are found even on machines with
 * virtual adapters (WSL, Hyper-V, VPNs) that would otherwise swallow multicast.
 */

import { EventEmitter } from 'node:events';
import mdns from 'multicast-dns';
import type { Device, DeviceCaps, DeviceKind } from '@shared/types';
import { RECEIVER_MDNS_SERVICE } from '@shared/types';
import { localAddresses } from './net';
import { log } from './logger';

type MdnsInstance = ReturnType<typeof mdns>;

const SERVICES: Record<string, DeviceKind> = {
  '_airplay._tcp.local': 'airplay',
  '_googlecast._tcp.local': 'cast',
  '_raop._tcp.local': 'raop',
  [RECEIVER_MDNS_SERVICE]: 'web',
};

const AIRPLAY_FEATURES = {
  VideoV1: 1n << 0n,
  Screen: 1n << 7n,
  Audio: 1n << 9n,
  SupportsSystemPairing: 1n << 43n,
  SupportsHKPairing: 1n << 46n,
  SupportsCoreUtilsPairing: 1n << 48n,
  VideoV2: 1n << 49n,
  UnifiedPairSetupMfi: 1n << 51n,
};

const STATUS_PIN_REQUIRED = 0x8;
const STATUS_PASSWORD = 0x80;
const STATUS_ONE_TIME_PAIRING = 0x200;

export function parseFeatures(features: string | undefined): bigint {
  if (!features) return 0n;
  const m = /^0x([0-9a-f]{1,8})(?:,0x([0-9a-f]{1,8}))?$/i.exec(features.trim());
  if (!m) {
    try {
      return BigInt(features);
    } catch {
      return 0n;
    }
  }
  const low = BigInt('0x' + m[1]);
  const high = m[2] ? BigInt('0x' + m[2]) : 0n;
  return (high << 32n) | low;
}

export function airplayCaps(txt: Record<string, string>, paired: boolean): DeviceCaps {
  const features = parseFeatures(txt.features ?? txt.ft);
  const flags = parseInt(txt.flags ?? txt.sf ?? '0', 16) || 0;
  const model = txt.model ?? '';
  const isSpeaker = /AudioAccessory|HomePod|AirPort|Sonos|Bose|Denon|Marantz|Sound|Speaker/i.test(model) && !/AppleTV/i.test(model);
  const video = (features & (AIRPLAY_FEATURES.VideoV1 | AIRPLAY_FEATURES.VideoV2)) !== 0n && !isSpeaker;
  const transient = (features & (AIRPLAY_FEATURES.SupportsSystemPairing | AIRPLAY_FEATURES.SupportsCoreUtilsPairing)) !== 0n;
  const pairingRequired = (flags & (STATUS_PIN_REQUIRED | STATUS_ONE_TIME_PAIRING | STATUS_PASSWORD)) !== 0 || txt.pw === 'true';
  const v2 = (features & (AIRPLAY_FEATURES.SupportsCoreUtilsPairing | AIRPLAY_FEATURES.SupportsHKPairing | AIRPLAY_FEATURES.VideoV2)) !== 0n;
  return {
    video,
    audio: true,
    pairingRequired,
    transientPairing: transient,
    paired,
    airplayVersion: v2 ? 2 : 1,
  };
}

export function castCaps(txt: Record<string, string>): DeviceCaps {
  // ca bitmask: 1 = video out, 4 = audio out, 8 = ??? Speakers (Google Home) report ca without bit 1.
  const ca = parseInt(txt.ca ?? '0', 10) || 0;
  const video = (ca & 1) !== 0 || ca === 0;
  return { video, audio: true, pairingRequired: false, transientPairing: false, paired: true };
}

export function parseTxt(data: Buffer[] | string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of data ?? []) {
    const s = Buffer.isBuffer(item) ? item.toString('utf8') : String(item);
    const eq = s.indexOf('=');
    if (eq < 0) out[s] = '';
    else out[s.slice(0, eq)] = s.slice(eq + 1);
  }
  return out;
}

interface PendingService {
  kind: DeviceKind;
  instance: string;
  target?: string;
  port?: number;
  txt?: Record<string, string>;
  address?: string;
  seen: number;
}

export interface DiscoveryOptions {
  /** Called to check if we hold stored credentials for a receiver. */
  isPaired?: (deviceKey: string) => boolean;
  interfaces?: string[];
  staleAfterMs?: number;
}

export class Discovery extends EventEmitter {
  private instances: MdnsInstance[] = [];
  private services = new Map<string, PendingService>();
  private hosts = new Map<string, string>();
  readonly devices = new Map<string, Device>();
  private queryTimer: NodeJS.Timeout | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;
  private readonly opts: DiscoveryOptions;
  private manual = new Map<string, Device>();

  constructor(opts: DiscoveryOptions = {}) {
    super();
    this.opts = opts;
  }

  start(): void {
    this.stop();
    const ifaces = this.opts.interfaces ?? localAddresses().map((a) => a.address);
    const targets = ifaces.length ? ifaces : [undefined];
    for (const iface of targets) {
      try {
        const inst = mdns(iface ? { interface: iface, reuseAddr: true } : { reuseAddr: true });
        inst.on('response', (res, rinfo) => this.onResponse(res, rinfo?.address));
        inst.on('error', (err) => log.debug('mdns', `socket error on ${iface}: ${err.message}`));
        inst.on('warning', (err) => log.debug('mdns', `warning on ${iface}: ${err.message}`));
        this.instances.push(inst);
      } catch (err) {
        log.warn('mdns', `failed to bind ${iface}: ${(err as Error).message}`);
      }
    }
    this.query();
    let n = 0;
    this.queryTimer = setInterval(() => {
      n++;
      // Query quickly at first, then back off to every 15 s.
      if (n < 5 || n % 5 === 0) this.query();
    }, 3000);
    this.pruneTimer = setInterval(() => this.prune(), 10000);
    log.info('mdns', `discovery started on ${targets.filter(Boolean).join(', ') || 'default interface'}`);
  }

  stop(): void {
    for (const inst of this.instances) {
      try {
        inst.destroy();
      } catch {
        /* ignore */
      }
    }
    this.instances = [];
    if (this.queryTimer) clearInterval(this.queryTimer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.queryTimer = null;
    this.pruneTimer = null;
  }

  query(): void {
    const questions = Object.keys(SERVICES).map((name) => ({ name, type: 'PTR' as const }));
    for (const inst of this.instances) {
      try {
        inst.query({ questions });
      } catch (err) {
        log.debug('mdns', `query failed: ${(err as Error).message}`);
      }
    }
  }

  /** Re-announce all currently known devices (used by the UI "rescan" button). */
  rescan(): void {
    this.query();
    setTimeout(() => this.query(), 800);
  }

  addManual(device: Device): void {
    this.manual.set(device.id, device);
    this.devices.set(device.id, device);
    this.emit('change', this.list());
  }

  removeManual(id: string): void {
    this.manual.delete(id);
    this.devices.delete(id);
    this.emit('change', this.list());
  }

  list(): Device[] {
    return [...this.devices.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): Device | undefined {
    return this.devices.get(id);
  }

  /** Feed a raw mDNS response (public for tests). */
  onResponse(res: { answers?: any[]; additionals?: any[] }, from?: string): void {
    const records = [...(res.answers ?? []), ...(res.additionals ?? [])];
    const touched = new Set<string>();
    for (const r of records) {
      if (r.type === 'A' && typeof r.data === 'string') {
        this.hosts.set(r.name.toLowerCase(), r.data);
      }
    }
    for (const r of records) {
      if (r.type === 'PTR' && SERVICES[r.name]) {
        const svc = this.pending(r.data, SERVICES[r.name]);
        svc.seen = Date.now();
        touched.add(r.data);
      } else if (r.type === 'SRV') {
        const kind = this.kindOf(r.name);
        if (!kind) continue;
        const svc = this.pending(r.name, kind);
        svc.target = String(r.data?.target ?? '').toLowerCase();
        svc.port = r.data?.port;
        svc.seen = Date.now();
        touched.add(r.name);
      } else if (r.type === 'TXT') {
        const kind = this.kindOf(r.name);
        if (!kind) continue;
        const svc = this.pending(r.name, kind);
        svc.txt = parseTxt(r.data);
        svc.seen = Date.now();
        touched.add(r.name);
      }
    }
    let changed = false;
    for (const name of touched) {
      const svc = this.services.get(name);
      if (!svc) continue;
      const address = (svc.target && this.hosts.get(svc.target)) || svc.address || (svc.target ? undefined : from);
      if (!address && from && svc.target && !this.hosts.has(svc.target)) {
        // Some receivers answer SRV+TXT without an A record in the same packet; fall back to sender IP.
        svc.address = from;
      }
      const addr = address ?? svc.address;
      if (!addr || !svc.port || !svc.txt) continue;
      const device = this.toDevice(svc, addr);
      if (!device) continue;
      const prev = this.devices.get(device.id);
      if (!prev || JSON.stringify({ ...prev, lastSeen: 0 }) !== JSON.stringify({ ...device, lastSeen: 0 })) changed = true;
      // Keep the manual flag when a hand-added receiver is later discovered over mDNS.
      // Losing it meant prune() deleted a device the user had added by IP as soon as the
      // receiver was switched off, and it never came back without a restart.
      const manual = this.manual.has(device.id) || prev?.manual;
      this.devices.set(device.id, manual ? { ...device, manual: true } : device);
    }
    if (changed) this.emit('change', this.list());
  }

  private kindOf(instanceName: string): DeviceKind | undefined {
    for (const [svc, kind] of Object.entries(SERVICES)) {
      if (instanceName.endsWith('.' + svc)) return kind;
    }
    return undefined;
  }

  private pending(instance: string, kind: DeviceKind): PendingService {
    let svc = this.services.get(instance);
    if (!svc) {
      svc = { kind, instance, seen: Date.now() };
      this.services.set(instance, svc);
    }
    return svc;
  }

  private toDevice(svc: PendingService, address: string): Device | null {
    const txt = svc.txt ?? {};
    const port = svc.port!;
    let name = svc.instance.replace(/\._(airplay|googlecast|raop|airwing)\._tcp\.local$/i, '');
    if (svc.kind === 'raop') {
      // RAOP instances look like "MAC@Name"; we only surface RAOP when no _airplay record exists.
      name = name.replace(/^[0-9A-F]{12}@/i, '');
      const airplayId = `airplay:${address}:${port}`;
      if (this.devices.has(airplayId)) return null;
      const existingAirplay = [...this.services.values()].some((s) => s.kind === 'airplay' && s.target === svc.target);
      if (existingAirplay) return null;
    }
    if (svc.kind === 'cast') {
      name = txt.fn || name;
    }
    const id = svc.kind === 'cast' && txt.id ? `cast:${txt.id}` : `${svc.kind}:${address}:${port}`;
    const key = deviceKey(svc.kind, txt, address);
    const paired = this.opts.isPaired?.(key) ?? false;
    let caps: DeviceCaps;
    if (svc.kind === 'airplay' || svc.kind === 'raop') caps = airplayCaps(txt, paired);
    else if (svc.kind === 'cast') caps = castCaps(txt);
    else caps = { video: true, audio: true, pairingRequired: false, transientPairing: false, paired: true };
    return {
      id,
      kind: svc.kind,
      name: name.replace(/\\\./g, '.').replace(/\\032/g, ' '),
      host: address,
      port,
      model: txt.model ?? txt.md,
      txt,
      lastSeen: svc.seen,
      caps,
    };
  }

  private prune(): void {
    const stale = this.opts.staleAfterMs ?? 120000;
    const now = Date.now();
    let changed = false;
    for (const [id, dev] of this.devices) {
      if (dev.manual) continue;
      if (now - dev.lastSeen > stale) {
        this.devices.delete(id);
        changed = true;
      }
    }
    for (const [name, svc] of this.services) {
      if (now - svc.seen > stale) this.services.delete(name);
    }
    // `hosts` records an A record for every name seen on the network, so on a busy LAN it
    // would grow for the whole life of the app. Keep only names our services still point at.
    if (this.hosts.size > 256) {
      const wanted = new Set([...this.services.values()].map((s) => s.target).filter((t): t is string => !!t));
      for (const name of [...this.hosts.keys()]) if (!wanted.has(name)) this.hosts.delete(name);
    }
    if (changed) this.emit('change', this.list());
  }
}

/** Stable key for credential storage: prefers the receiver's advertised identifier. */
export function deviceKey(kind: DeviceKind, txt: Record<string, string>, host: string): string {
  const id = txt.pi || txt.deviceid || txt.id || host;
  return `${kind}:${id}`;
}
