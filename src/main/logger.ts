import { EventEmitter } from 'node:events';
import type { LogEvent } from '@shared/types';

class Logger extends EventEmitter {
  private buffer: LogEvent[] = [];
  private readonly max = 500;
  verbose = process.env.AIRWING_DEBUG === '1' || process.argv.includes('--verbose');

  private push(level: LogEvent['level'], scope: string, message: string): void {
    const ev: LogEvent = { ts: Date.now(), level, scope, message };
    this.buffer.push(ev);
    if (this.buffer.length > this.max) this.buffer.shift();
    if (level !== 'debug' || this.verbose) {
      const line = `[${new Date(ev.ts).toISOString()}] ${level.toUpperCase().padEnd(5)} ${scope}: ${message}`;
      if (level === 'error') console.error(line);
      else if (level === 'warn') console.warn(line);
      else console.log(line);
    }
    this.emit('log', ev);
  }

  info(scope: string, message: string): void {
    this.push('info', scope, message);
  }
  warn(scope: string, message: string): void {
    this.push('warn', scope, message);
  }
  error(scope: string, message: string | Error): void {
    this.push('error', scope, message instanceof Error ? `${message.message}${this.verbose && message.stack ? `\n${message.stack}` : ''}` : message);
  }
  debug(scope: string, message: string): void {
    this.push('debug', scope, message);
  }
  list(): LogEvent[] {
    return [...this.buffer];
  }
}

export const log = new Logger();
