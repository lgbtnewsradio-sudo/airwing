declare module 'castv2-client' {
  export class Client {
    connect(options: { host: string; port?: number }, callback: () => void): void;
    on(event: string, cb: (...args: any[]) => void): void;
    close(): void;
    launch(app: any, cb: (err: Error | null, player?: any) => void): void;
    join(session: any, app: any, cb: (err: Error | null, player?: any) => void): void;
    getSessions(cb: (err: Error | null, sessions?: any[]) => void): void;
    stop(app: any, cb: (err: Error | null) => void): void;
    setVolume(volume: { level?: number; muted?: boolean }, cb: (err: Error | null, volume?: any) => void): void;
    getVolume(cb: (err: Error | null, volume?: any) => void): void;
  }
  export class DefaultMediaReceiver {
    static APP_ID: string;
  }
}

declare module 'castv2' {
  import { EventEmitter } from 'node:events';
  export class Client extends EventEmitter {
    connect(options: { host: string; port?: number }, cb: () => void): void;
    send(sourceId: string, destinationId: string, namespace: string, data: any): void;
    close(): void;
  }
  export class Server extends EventEmitter {
    constructor(options: { key: Buffer | string; cert: Buffer | string });
    listen(port: number, host?: string, cb?: () => void): void;
    send(clientId: string, sourceId: string, destinationId: string, namespace: string, data: any): void;
    close(): void;
  }
}

declare module 'bplist-creator' {
  function create(obj: any): Buffer;
  namespace create {
    class Real {
      constructor(value: number);
      value: number;
    }
  }
  export = create;
}

declare module 'bplist-parser' {
  export function parseBuffer(buffer: Buffer): any[];
}
