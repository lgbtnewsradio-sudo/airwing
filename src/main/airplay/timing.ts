/** UDP timing responder for AirPlay 2 (NTP-style RTP timing packets). */

import dgram from 'node:dgram';

const NTP_EPOCH_OFFSET = 2208988800;

export function ntpNow(): { sec: number; frac: number } {
  const ms = Date.now();
  const sec = Math.floor(ms / 1000) + NTP_EPOCH_OFFSET;
  const frac = Math.floor(((ms % 1000) / 1000) * 0x100000000);
  return { sec, frac };
}

export class TimingServer {
  private socket: dgram.Socket | null = null;
  port = 0;

  start(bindAddress = '0.0.0.0'): Promise<number> {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket('udp4');
      socket.on('error', (err) => {
        if (!this.socket) reject(err);
      });
      socket.on('message', (msg, rinfo) => {
        if (msg.length < 32) return;
        const resp = Buffer.alloc(32);
        resp[0] = 0x80;
        resp[1] = 0xd3; // timing reply
        resp.writeUInt16BE(7, 2);
        resp.writeUInt32BE(0, 4);
        msg.copy(resp, 8, 24, 32); // reference = request transmit time
        const { sec, frac } = ntpNow();
        resp.writeUInt32BE(sec >>> 0, 16);
        resp.writeUInt32BE(frac >>> 0, 20);
        resp.writeUInt32BE(sec >>> 0, 24);
        resp.writeUInt32BE(frac >>> 0, 28);
        socket.send(resp, rinfo.port, rinfo.address);
      });
      socket.bind(0, bindAddress, () => {
        this.socket = socket;
        this.port = socket.address().port;
        resolve(this.port);
      });
    });
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }
}
