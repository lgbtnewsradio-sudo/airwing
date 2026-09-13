import { networkInterfaces } from 'node:os';
import net from 'node:net';

/** True when something accepts a TCP connection on host:port within the timeout. */
export function probePort(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    try {
      socket.connect(port, host);
    } catch {
      done(false);
    }
  });
}

export interface LocalAddress {
  address: string;
  netmask: string;
  iface: string;
  internal: boolean;
}

function ipToInt(ip: string): number {
  return ip.split('.').reduce((acc, oct) => ((acc << 8) + (parseInt(oct, 10) & 0xff)) >>> 0, 0);
}

/** IPv4 addresses of this machine, excluding loopback and link-local. */
export function localAddresses(): LocalAddress[] {
  const out: LocalAddress[] = [];
  for (const [iface, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (a.address.startsWith('169.254.')) continue;
      out.push({ address: a.address, netmask: a.netmask, iface, internal: a.internal });
    }
  }
  return out;
}

/** Score interfaces so real LAN adapters win over virtual (WSL, Hyper-V, VPN) ones. */
function score(a: LocalAddress): number {
  const name = a.iface.toLowerCase();
  let s = 0;
  if (/wsl|hyper-v|vethernet|virtual|vmware|vbox|docker|tailscale|zerotier|wireguard|openvpn|npcap|loopback/.test(name)) s -= 10;
  if (/wi-?fi|wlan|ethernet|eth|en0|lan/.test(name)) s += 2;
  if (a.address.startsWith('192.168.') || a.address.startsWith('10.')) s += 1;
  if (a.address.startsWith('172.')) s -= 1;
  return s;
}

/** The local address that shares a subnet with `remote`, or the best-guess LAN address. */
export function addressReaching(remote: string): string {
  if (remote === '127.0.0.1' || remote === 'localhost' || remote === '::1') return '127.0.0.1';
  const addrs = localAddresses();
  if (!addrs.length) return '127.0.0.1';
  if (/^\d+\.\d+\.\d+\.\d+$/.test(remote)) {
    const r = ipToInt(remote);
    for (const a of addrs) {
      const mask = ipToInt(a.netmask);
      if ((ipToInt(a.address) & mask) === (r & mask)) return a.address;
    }
  }
  return preferredAddress();
}

export function preferredAddress(): string {
  const addrs = localAddresses();
  if (!addrs.length) return '127.0.0.1';
  return [...addrs].sort((x, y) => score(y) - score(x))[0].address;
}
