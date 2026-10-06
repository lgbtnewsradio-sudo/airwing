import { promises as fs, existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { EventEmitter } from 'node:events';
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/types';
import { log } from './logger';

function deepMerge<T>(base: T, patch: Partial<T> | undefined): T {
  if (!patch) return base;
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) };
  for (const [k, v] of Object.entries(patch as any)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof (base as any)[k] === 'object' && !Array.isArray((base as any)[k])) {
      out[k] = deepMerge((base as any)[k], v as any);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as T;
}

/** JSON-file backed settings store with change events. */
export class SettingsStore extends EventEmitter {
  private data: AppSettings;
  private readonly file: string;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(userDataDir: string) {
    super();
    this.file = join(userDataDir, 'settings.json');
    this.data = DEFAULT_SETTINGS;
    try {
      if (existsSync(this.file)) {
        const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
        this.data = deepMerge(DEFAULT_SETTINGS, parsed);
      }
    } catch (err) {
      log.warn('settings', `failed to read settings: ${(err as Error).message}`);
    }
  }

  get(): AppSettings {
    return this.data;
  }

  set(patch: Partial<AppSettings>): AppSettings {
    this.data = deepMerge(this.data, patch);
    this.scheduleSave();
    this.emit('change', this.data);
    return this.data;
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.save(), 150);
  }

  async save(): Promise<void> {
    try {
      await fs.mkdir(dirname(this.file), { recursive: true });
      await fs.writeFile(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (err) {
      log.error('settings', `failed to save settings: ${(err as Error).message}`);
    }
  }

  saveSync(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch {
      /* ignore */
    }
  }

  addRecentDevice(id: string): void {
    const recent = [id, ...this.data.recentDevices.filter((d) => d !== id)].slice(0, 8);
    this.set({ recentDevices: recent });
  }
}

/**
 * Stores AirPlay pairing credentials (HAP long-term keys) per receiver.
 * Kept separate from settings so it can be wiped without losing preferences.
 */
export class CredentialStore {
  private readonly file: string;
  private data: Record<string, string> = {};
  private encrypted: Record<string, string> = {};

  constructor(userDataDir: string, private readonly encryption?: {
    isEncryptionAvailable(): boolean;
    encryptString(value: string): Buffer;
    decryptString(value: Buffer): string;
  }) {
    this.file = join(userDataDir, 'credentials.json');
    try {
      if (existsSync(this.file)) {
        const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
        if (parsed.version === 2 && parsed.entries) this.encrypted = parsed.entries;
        else this.data = parsed;
      }
    } catch {
      this.data = {};
    }
  }

  get(deviceKey: string): string | undefined {
    if (this.data[deviceKey] !== undefined) return this.data[deviceKey];
    if (this.encrypted[deviceKey] && this.encryption?.isEncryptionAvailable()) {
      try { return this.encryption.decryptString(Buffer.from(this.encrypted[deviceKey], 'base64')); }
      catch { log.warn('credentials', 'A saved pairing could not be decrypted; forget it and pair again.'); return undefined; }
    }
    return this.data[deviceKey];
  }

  set(deviceKey: string, credentials: string): void {
    this.data[deviceKey] = credentials;
    this.persist();
  }

  remove(deviceKey: string): void {
    delete this.data[deviceKey];
    delete this.encrypted[deviceKey];
    this.persist();
  }

  keys(): string[] {
    return [...new Set([...Object.keys(this.data), ...Object.keys(this.encrypted)])];
  }

  migrate(): void { if (Object.keys(this.data).length) this.persist(); }

  private persist(): void {
    if (Object.keys(this.data).length && !this.encryption?.isEncryptionAvailable()) {
      log.warn('credentials', 'Secure storage is unavailable; new pairing keys are kept in memory only.');
      return;
    }
    try {
      const entries = { ...this.encrypted };
      for (const [key, value] of Object.entries(this.data)) entries[key] = this.encryption!.encryptString(value).toString('base64');
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file + '.tmp', JSON.stringify({ version: 2, entries }, null, 2), 'utf8');
      renameSync(this.file + '.tmp', this.file);
      this.encrypted = entries;
      this.data = {};
    } catch (err) {
      log.error('credentials', `failed to save credentials: ${(err as Error).message}`);
    }
  }
}
