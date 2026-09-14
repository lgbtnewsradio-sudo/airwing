import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LogEvent } from '@shared/types';

/**
 * How long to wait before retrying disk logging after a failed write. On Windows a second
 * instance (or a tail/editor) holding the file produces a transient EPERM/EBUSY, which used
 * to disable file logging for the rest of the session and leave a stale log on disk.
 */
const FILE_RETRY_MS = 15_000;

class Logger extends EventEmitter {
  private buffer: LogEvent[] = [];
  private readonly max = 500;
  verbose = process.env.AIRWING_DEBUG === '1' || process.argv.includes('--verbose');
  private file: string | null = null;
  /** Epoch ms before which file writes are skipped after a failure (0 = write now). */
  private fileRetryAt = 0;
  /** Entries not written to disk while backing off, reported once writing recovers. */
  private fileDropped = 0;

  /** Mirror all events (including debug) to a log file, rotating it at ~5 MB. */
  setFile(path: string): void {
    this.file = path;
    try {
      mkdirSync(dirname(path), { recursive: true });
      if (existsSync(path) && statSync(path).size > 5 * 1024 * 1024) renameSync(path, path.replace(/\.log$/, '') + '.old.log');
      appendFileSync(path, `\n===== AirWing log started ${new Date().toISOString()} =====\n`);
      this.fileRetryAt = 0;
    } catch {
      this.fileRetryAt = Date.now() + FILE_RETRY_MS;
    }
  }

  get filePath(): string | null {
    return this.file;
  }

  private writeToFile(line: string): void {
    if (!this.file) return;
    if (Date.now() < this.fileRetryAt) {
      this.fileDropped++;
      return;
    }
    try {
      appendFileSync(this.file, line + '\n');
      if (this.fileDropped > 0) {
        const dropped = this.fileDropped;
        this.fileDropped = 0;
        appendFileSync(this.file, `[${new Date().toISOString()}] WARN  log: ${dropped} earlier entries could not be written to this file (retried and recovered)\n`);
      }
    } catch {
      // Keep buffering in memory and try again shortly instead of giving up permanently.
      this.fileDropped++;
      this.fileRetryAt = Date.now() + FILE_RETRY_MS;
    }
  }

  private push(level: LogEvent['level'], scope: string, message: string): void {
    const ev: LogEvent = { ts: Date.now(), level, scope, message };
    this.buffer.push(ev);
    if (this.buffer.length > this.max) this.buffer.shift();
    const line = `[${new Date(ev.ts).toISOString()}] ${level.toUpperCase().padEnd(5)} ${scope}: ${message}`;
    this.writeToFile(line);
    if (level !== 'debug' || this.verbose) {
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
