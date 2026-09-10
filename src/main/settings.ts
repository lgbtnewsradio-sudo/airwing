import { promises as fs, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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

  constructor(userDataDir: string) {
    this.file = join(userDataDir, 'credentials.json');
    try {
      if (existsSync(this.file)) this.data = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      this.data = {};
    }
  }

  get(deviceKey: string): string | undefined {
    return this.data[deviceKey];
  }

  set(deviceKey: string, credentials: string): void {
    this.data[deviceKey] = credentials;
    this.persist();
  }

  remove(deviceKey: string): void {
    delete this.data[deviceKey];
    this.persist();
  }

  keys(): string[] {
    return Object.keys(this.data);
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (err) {
      log.error('credentials', `failed to save credentials: ${(err as Error).message}`);
    }
  }
}
