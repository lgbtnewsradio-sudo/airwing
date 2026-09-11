import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
  session,
  desktopCapturer,
  screen,
  dialog,
  shell,
  globalShortcut,
  Notification,
  type MenuItemConstructorOptions,
} from 'electron';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import {
  IPC,
  type AppSettings,
  type CaptureCommand,
  type CaptureSource,
  type Device,
  type DisplayInfo,
  type ExtendDesktopInfo,
  type MediaControlAction,
  type Rect,
  type StreamConfig,
  type StreamMeta,
  type ReceiverInfo,
} from '@shared/types';
import type { FragmentInfo } from '@shared/fmp4';
import { log } from './logger';
import { SettingsStore, CredentialStore } from './settings';
import { Discovery, deviceKey } from './discovery';
import { StreamHub } from './streamHub';
import { LocalServer } from './server';
import { SessionManager } from './sessions';
import { localAddresses, preferredAddress } from './net';

const userDataArg = process.argv.find((a) => a.startsWith('--user-data-dir='));
if (userDataArg) app.setPath('userData', userDataArg.slice('--user-data-dir='.length));

const isDev = !app.isPackaged;
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

// Chromium flags that help capture/encode performance.
app.commandLine.appendSwitch('enable-features', 'WebCodecs,PlatformHEVCEncoderSupport');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.setAppUserModelId('dev.airwing.app');

let mainWindow: BrowserWindow | null = null;
let regionWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

const userData = app.getPath('userData');
log.setFile(join(userData, 'logs', 'airwing.log'));
const settings = new SettingsStore(userData);
const credentials = new CredentialStore(userData);
const hub = new StreamHub();
// In a packaged build the resources folder ships inside app.asar; Electron's fs reads it transparently.
const resourcesDir = app.isPackaged ? join(app.getAppPath(), 'resources') : join(process.cwd(), 'resources');
const server = new LocalServer({
  port: settings.get().serverPort,
  bindAddress: settings.get().bindAddress,
  hub,
  staticDir: resourcesDir,
  requireCode: () => settings.get().receiverRequireCode,
  deviceName: () => senderName(),
});
const discovery = new Discovery({ isPaired: (key) => !!credentials.get(key) });
const sessions = new SessionManager({ hub, server, credentials, senderName: () => senderName() });

/** Current capture request (set by the renderer before calling getDisplayMedia). */
let pendingCapture: { sourceId: string; audio: boolean; muteLocal: boolean } | null = null;
let currentConfig: StreamConfig | null = null;

function appVersion(): string {
  if (app.isPackaged) return app.getVersion();
  try {
    return JSON.parse(require('node:fs').readFileSync(join(process.cwd(), 'package.json'), 'utf8')).version ?? app.getVersion();
  } catch {
    return app.getVersion();
  }
}

function senderName(): string {
  return settings.get().deviceName || `AirWing on ${require('node:os').hostname()}`;
}

function send(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args);
}

function iconPath(name: string): string {
  const candidates = [join(resourcesDir, name), join(process.cwd(), 'resources', name), join(process.cwd(), 'build', name)];
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
}

// --------------------------------------------------------------------------- window

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 560,
    height: 720,
    minWidth: 420,
    minHeight: 520,
    show: false,
    title: 'AirWing',
    backgroundColor: '#0f1219',
    autoHideMenuBar: true,
    icon: iconPath('icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  win.once('ready-to-show', () => {
    if (!settings.get().startMinimized || process.argv.includes('--show')) win.show();
  });
  win.on('close', (e) => {
    if (!quitting && (hub.active || sessions.count > 0)) {
      e.preventDefault();
      win.hide();
      if (settings.get().showNotifications && Notification.isSupported()) {
        new Notification({ title: 'AirWing is still streaming', body: 'Use the tray icon to stop or reopen the window.' }).show();
      }
    }
  });
  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  return win;
}

function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow();
  mainWindow.show();
  mainWindow.focus();
}

// --------------------------------------------------------------------------- tray

function buildTrayMenu(): Menu {
  const devices = discovery.list().filter((d) => d.kind !== 'raop');
  const active = new Set(sessions.list().map((s) => s.device.id));
  const deviceItems: MenuItemConstructorOptions[] = devices.slice(0, 12).map((d) => ({
    label: `${active.has(d.id) ? '● ' : ''}${d.name} (${d.kind === 'cast' ? 'Cast' : 'AirPlay'})`,
    click: () => {
      if (active.has(d.id)) void sessions.disconnect(d.id, 'stopped from tray');
      else void quickConnect(d);
    },
  }));
  const template: MenuItemConstructorOptions[] = [
    { label: hub.active ? 'AirWing — streaming' : 'AirWing', enabled: false },
    { type: 'separator' },
    ...(deviceItems.length ? deviceItems : [{ label: 'No receivers found', enabled: false }]),
    { type: 'separator' },
    { label: hub.paused ? 'Resume' : 'Pause', enabled: hub.active, click: () => togglePause() },
    { label: 'Stop mirroring', enabled: hub.active || sessions.count > 0, click: () => void stopAll() },
    { type: 'separator' },
    { label: 'Open AirWing', click: () => showWindow() },
    { label: 'Open browser receiver', click: () => void shell.openExternal(server.receiverUrl(preferredAddress())) },
    { type: 'separator' },
    { label: 'Quit', click: () => quitApp() },
  ];
  return Menu.buildFromTemplate(template);
}

function createTray(): void {
  const img = nativeImage.createFromPath(iconPath('tray.png'));
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  tray.setToolTip('AirWing');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', () => showWindow());
  tray.on('double-click', () => showWindow());
}

function refreshTray(): void {
  tray?.setContextMenu(buildTrayMenu());
  tray?.setToolTip(hub.active ? `AirWing — streaming to ${sessions.count} receiver(s)` : 'AirWing');
}

/** Connect from the tray using the last stream configuration. */
async function quickConnect(device: Device): Promise<void> {
  if (!hub.active) {
    const cfg = settings.get().stream;
    sendCaptureCommand({ type: 'start', config: cfg });
    showWindow();
  }
  await sessions.connect(device, { type: 'live' });
  settings.addRecentDevice(device.id);
}

// --------------------------------------------------------------------------- capture

function sendCaptureCommand(cmd: CaptureCommand): void {
  if (cmd.type === 'start') {
    currentConfig = cmd.config;
    pendingCapture = { sourceId: cmd.config.sourceId ?? '', audio: cmd.config.audio, muteLocal: cmd.config.muteLocal };
  }
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow();
  send(IPC.captureCommand, cmd);
}

let captureRestarts = 0;
let restartTimer: NodeJS.Timeout | null = null;

/** Bring capture back after it ended unexpectedly, as long as someone is still watching. */
function maybeRestartCapture(reason: string): void {
  if (restartTimer || quitting) return;
  const watchers = sessions.count + server.viewerCount;
  if (watchers === 0 || !currentConfig) return;
  if (captureRestarts >= 5) {
    log.error('capture', `capture keeps stopping (${reason}); giving up after ${captureRestarts} restarts`);
    return;
  }
  captureRestarts++;
  const delay = Math.min(4000, 400 * captureRestarts);
  log.warn('capture', `capture ended (${reason}); restarting in ${delay} ms for ${watchers} watcher(s), attempt ${captureRestarts}`);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (!quitting && currentConfig && !hub.active) sendCaptureCommand({ type: 'start', config: currentConfig });
  }, delay);
}

function togglePause(): void {
  if (!hub.active) return;
  sendCaptureCommand({ type: 'pause', paused: !hub.paused });
}

async function stopAll(): Promise<void> {
  sendCaptureCommand({ type: 'stop' });
  await sessions.disconnectAll();
  hub.end();
  refreshTray();
}

function installDisplayMediaHandler(): void {
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      try {
        const want = pendingCapture;
        const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
        let source = want?.sourceId ? sources.find((s) => s.id === want.sourceId) : undefined;
        if (!source) source = sources.find((s) => s.id.startsWith('screen:')) ?? sources[0];
        if (!source) {
          callback({});
          return;
        }
        const audio = want?.audio ? (want.muteLocal ? 'loopbackWithMute' : 'loopback') : undefined;
        log.info('capture', `granting capture of "${source.name}" (${source.id})${audio ? ` with ${audio} audio` : ''}`);
        callback(audio ? { video: source, audio } : { video: source });
      } catch (err) {
        log.error('capture', `display media handler failed: ${(err as Error).message}`);
        callback({});
      }
    },
    { useSystemPicker: false },
  );
}

async function listSources(): Promise<CaptureSource[]> {
  const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: true });
  const displays = screen.getAllDisplays();
  return sources
    .filter((s) => s.name !== 'AirWing' && !/^AirWing/.test(s.name))
    .map((s) => {
      const isScreen = s.id.startsWith('screen:');
      const display = isScreen ? displays.find((d) => String(d.id) === s.display_id) : undefined;
      return {
        id: s.id,
        kind: isScreen ? 'screen' : 'window',
        name: isScreen && display ? displayLabel(display, displays.indexOf(display)) : s.name,
        thumbnail: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL(),
        appIcon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : undefined,
        displayId: s.display_id || undefined,
        bounds: display?.bounds,
        size: display ? { width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor) } : undefined,
        isVirtualDisplay: display ? isVirtualDisplay(display) : false,
      } satisfies CaptureSource;
    });
}

function displayLabel(d: Electron.Display, index: number): string {
  const primary = screen.getPrimaryDisplay().id === d.id;
  const base = d.label && !/^\\\\/.test(d.label) ? d.label : `Display ${index + 1}`;
  return `${base}${primary ? ' (Primary)' : ''} — ${d.size.width * d.scaleFactor}×${d.size.height * d.scaleFactor}`;
}

function isVirtualDisplay(d: Electron.Display): boolean {
  return /virtual|idd|usbmmidd|parsec|spacedesk|amyuni/i.test(d.label ?? '');
}

function listDisplays(): DisplayInfo[] {
  const primary = screen.getPrimaryDisplay();
  return screen.getAllDisplays().map((d, i) => ({
    id: String(d.id),
    label: displayLabel(d, i),
    bounds: d.bounds,
    scaleFactor: d.scaleFactor,
    primary: d.id === primary.id,
    internal: d.internal,
    isVirtual: isVirtualDisplay(d),
  }));
}

function selectRegion(displayId?: string): Promise<Rect | null> {
  return new Promise((resolve) => {
    const displays = screen.getAllDisplays();
    const display = displays.find((d) => String(d.id) === displayId) ?? screen.getPrimaryDisplay();
    if (regionWindow && !regionWindow.isDestroyed()) regionWindow.close();
    const win = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      fullscreen: false,
      hasShadow: false,
      title: 'AirWing region',
      webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, sandbox: false },
    });
    regionWindow = win;
    win.setBounds(display.bounds);
    win.setAlwaysOnTop(true, 'screen-saver');
    let settled = false;
    const finish = (rect: Rect | null) => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener('region:result', handler);
      if (!win.isDestroyed()) win.close();
      resolve(rect);
    };
    const handler = (_e: Electron.IpcMainEvent, rect: Rect | null) => {
      if (!rect) return finish(null);
      const sf = display.scaleFactor;
      finish({ x: Math.round(rect.x * sf), y: Math.round(rect.y * sf), width: Math.round(rect.width * sf), height: Math.round(rect.height * sf) });
    };
    ipcMain.on('region:result', handler);
    win.on('closed', () => finish(null));
    if (isDev && process.env.ELECTRON_RENDERER_URL) void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/region.html`);
    else void win.loadFile(join(__dirname, '../renderer/region.html'));
  });
}

// --------------------------------------------------------------------------- extend desktop

const VIRTUAL_DISPLAY_DRIVER_URL = 'https://github.com/VirtualDrivers/Virtual-Display-Driver/releases/latest';

function extendDesktopInfo(): Promise<ExtendDesktopInfo> {
  const displays = listDisplays();
  const virtualDisplays = displays.filter((d) => d.isVirtual);
  return new Promise((resolve) => {
    const ps = 'Get-PnpDevice -Class Display,Monitor -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -match "Virtual Display|IddSample|usbmmidd|Amyuni|spacedesk|Parsec" } | Select-Object -ExpandProperty FriendlyName';
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 8000, windowsHide: true }, (err, stdout) => {
      const installed = !err && stdout.trim().length > 0;
      resolve({ virtualDisplays, driverInstalled: installed || virtualDisplays.length > 0, driverUrl: VIRTUAL_DISPLAY_DRIVER_URL });
    });
  });
}

// --------------------------------------------------------------------------- IPC

function receiverInfo(): ReceiverInfo {
  const addr = preferredAddress();
  return {
    url: server.receiverUrl(addr),
    remoteUrl: server.remoteUrl(addr),
    code: server.code,
    port: server.port,
    addresses: localAddresses().map((a) => a.address),
  };
}

function registerIpc(): void {
  ipcMain.handle(IPC.devicesList, () => discovery.list());
  ipcMain.handle(IPC.devicesRescan, () => discovery.rescan());
  ipcMain.handle(IPC.devicesAddManual, async (_e, input: { host: string; port?: number; kind: 'airplay' | 'cast'; name?: string }) => {
    const host = input.host.trim();
    const port = input.port || (input.kind === 'cast' ? 8009 : 7000);
    const device: Device = {
      id: `${input.kind}:${host}:${port}`,
      kind: input.kind,
      name: input.name?.trim() || `${host} (${input.kind === 'cast' ? 'Cast' : 'AirPlay'})`,
      host,
      port,
      txt: {},
      manual: true,
      lastSeen: Date.now(),
      caps: { video: true, audio: true, pairingRequired: false, transientPairing: true, paired: !!credentials.get(`${input.kind}:${host}`) },
    };
    discovery.addManual(device);
    const s = settings.get();
    if (!s.manualDevices.some((m) => m.host === host && m.kind === input.kind)) {
      settings.set({ manualDevices: [...s.manualDevices, { host, port, kind: input.kind, name: input.name }] });
    }
    return device;
  });
  ipcMain.handle(IPC.devicesRemoveManual, (_e, id: string) => {
    const dev = discovery.get(id);
    discovery.removeManual(id);
    if (dev) settings.set({ manualDevices: settings.get().manualDevices.filter((m) => !(m.host === dev.host && m.kind === dev.kind)) });
  });
  ipcMain.handle(IPC.devicesForget, (_e, id: string) => {
    const dev = discovery.get(id);
    if (dev) {
      sessions.forgetCredentials(dev);
      dev.caps.paired = false;
      send(IPC.devicesChanged, discovery.list());
    }
  });
  ipcMain.handle(IPC.sourcesList, () => listSources());
  ipcMain.handle(IPC.displaysList, () => listDisplays());
  ipcMain.handle(IPC.regionSelect, (_e, displayId?: string) => selectRegion(displayId));
  ipcMain.handle(IPC.extendDesktopInfo, () => extendDesktopInfo());
  ipcMain.handle(IPC.extendDesktopInstall, () => shell.openExternal(VIRTUAL_DISPLAY_DRIVER_URL));

  ipcMain.handle(IPC.captureStart, (_e, config: StreamConfig) => {
    settings.set({ stream: config });
    sendCaptureCommand({ type: 'start', config });
  });
  ipcMain.handle(IPC.captureStop, () => stopAll());
  ipcMain.handle(IPC.capturePause, (_e, paused: boolean) => sendCaptureCommand({ type: 'pause', paused }));
  ipcMain.on(IPC.streamMeta, (_e, meta: StreamMeta) => {
    hub.setMeta(meta);
    refreshTray();
  });
  ipcMain.on(IPC.streamData, (_e, data: ArrayBuffer | Uint8Array, info: FragmentInfo) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data instanceof Uint8Array ? data.buffer : data, data instanceof Uint8Array ? data.byteOffset : 0, data.byteLength);
    hub.push(buf, info);
  });
  ipcMain.on(IPC.streamState, (_e, state: { active: boolean; paused: boolean; dropped?: number; error?: string; reason?: string }) => {
    if (state.error) log.error('capture', state.error);
    else if (state.reason && !state.active) log.info('capture', `capture stopped: ${state.reason}`);
    if (typeof state.dropped === 'number') hub.reportDropped(state.dropped);
    if (!state.active && hub.active) hub.end();
    if (state.active) {
      captureRestarts = 0;
      if (hub.paused !== state.paused) hub.setPaused(state.paused);
    } else if (state.reason && state.reason !== 'stopped by request') {
      // Windows can end a capture on its own (display change, session switch, a source
      // that goes away). Anyone still watching would just see a frozen picture, so bring
      // the capture back instead of leaving it dead.
      maybeRestartCapture(state.reason);
    }
    refreshTray();
    send(IPC.streamStats, hub.stats(sessions.count));
  });
  ipcMain.handle(IPC.streamStats, () => hub.stats(sessions.count));
  ipcMain.handle(IPC.captureStatus, () => ({ active: hub.active, paused: hub.paused, config: currentConfig }));

  ipcMain.handle(IPC.sessionConnect, async (_e, deviceId: string, target?: { type: 'live' } | { type: 'file'; path: string }) => {
    const device = discovery.get(deviceId);
    if (!device) throw new Error('device not found');
    settings.addRecentDevice(deviceId);
    const info = await sessions.connect(device, target ?? { type: 'live' });
    refreshTray();
    return info;
  });
  ipcMain.handle(IPC.sessionDisconnect, async (_e, deviceId: string) => {
    await sessions.disconnect(deviceId, 'stopped');
    refreshTray();
  });
  ipcMain.handle(IPC.sessionsList, () => sessions.list());
  ipcMain.handle(IPC.sessionMediaControl, (_e, deviceId: string, action: MediaControlAction) => sessions.mediaControl(deviceId, action));
  ipcMain.handle(IPC.pairingStart, async (_e, deviceId: string) => {
    const device = discovery.get(deviceId);
    if (!device) throw new Error('device not found');
    await sessions.startPairing(device);
  });
  ipcMain.handle(IPC.pairingFinish, async (_e, deviceId: string, pin: string) => {
    const device = discovery.get(deviceId);
    if (!device) throw new Error('device not found');
    await sessions.finishPairing(device, pin);
    device.caps.paired = true;
    send(IPC.devicesChanged, discovery.list());
  });
  ipcMain.handle(IPC.pairingCancel, (_e, deviceId: string) => sessions.cancelPairing(deviceId));

  ipcMain.handle(IPC.settingsGet, () => settings.get());
  ipcMain.handle(IPC.settingsSet, (_e, patch: Partial<AppSettings>) => {
    const before = settings.get();
    const after = settings.set(patch);
    if (patch.hotkeys) registerHotkeys();
    if (patch.launchAtLogin !== undefined && patch.launchAtLogin !== before.launchAtLogin) {
      app.setLoginItemSettings({ openAtLogin: after.launchAtLogin, args: ['--hidden'] });
    }
    return after;
  });
  ipcMain.handle(IPC.receiverInfo, () => receiverInfo());
  ipcMain.handle(IPC.localAddresses, () => localAddresses());
  ipcMain.handle(IPC.mediaPick, async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Choose media to stream',
      properties: ['openFile'],
      filters: [
        { name: 'Media', extensions: ['mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'flv', 'ts', 'mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePaths.length) return null;
    const path = result.filePaths[0];
    const media = server.registerMedia(path);
    return { path, name: media.name, mime: media.mime, size: media.size, url: server.mediaUrl('127.0.0.1', media) };
  });
  ipcMain.handle(IPC.appVersion, () => appVersion());
  ipcMain.handle(IPC.appOpenExternal, (_e, url: string) => shell.openExternal(url));
  ipcMain.handle(IPC.appQuit, () => quitApp());
  ipcMain.handle(IPC.logList, () => log.list());
  ipcMain.handle(IPC.windowMinimize, () => mainWindow?.minimize());
  ipcMain.handle(IPC.windowClose, () => mainWindow?.close());
}

// --------------------------------------------------------------------------- hotkeys

function registerHotkeys(): void {
  globalShortcut.unregisterAll();
  const hk = settings.get().hotkeys;
  const tryRegister = (accel: string, fn: () => void) => {
    if (!accel) return;
    try {
      if (!globalShortcut.register(accel, fn)) log.warn('hotkeys', `could not register ${accel}`);
    } catch (err) {
      log.warn('hotkeys', `invalid accelerator ${accel}: ${(err as Error).message}`);
    }
  };
  tryRegister(hk.toggleMirror, () => {
    if (hub.active) void stopAll();
    else sendCaptureCommand({ type: 'start', config: settings.get().stream });
  });
  tryRegister(hk.togglePause, () => togglePause());
  tryRegister(hk.stopAll, () => void stopAll());
}

// --------------------------------------------------------------------------- remote control (phone web page)

function wireRemote(): void {
  server.setRemoteStateProvider(() => ({
    streaming: hub.active,
    paused: hub.paused,
    stats: hub.stats(sessions.count),
    sessions: sessions.list().map((s) => ({ id: s.id, name: s.device.name, kind: s.device.kind, state: s.state, position: s.position, duration: s.duration, playing: s.playing })),
    devices: discovery.list().filter((d) => d.kind !== 'raop').map((d) => ({ id: d.id, name: d.name, kind: d.kind })),
    name: senderName(),
  }));
  server.on('remote-state-request', () => server.broadcastRemoteState());
  server.on('remote', async (cmd: { type: string; deviceId?: string; action?: MediaControlAction }, reply: (r: unknown) => void) => {
    try {
      switch (cmd.type) {
        case 'pause':
          sendCaptureCommand({ type: 'pause', paused: true });
          break;
        case 'resume':
          sendCaptureCommand({ type: 'pause', paused: false });
          break;
        case 'stop':
          await stopAll();
          break;
        case 'start':
          sendCaptureCommand({ type: 'start', config: settings.get().stream });
          break;
        case 'connect': {
          const dev = cmd.deviceId ? discovery.get(cmd.deviceId) : undefined;
          if (dev) await quickConnect(dev);
          break;
        }
        case 'disconnect':
          if (cmd.deviceId) await sessions.disconnect(cmd.deviceId, 'stopped from remote');
          break;
        case 'media':
          if (cmd.deviceId && cmd.action) await sessions.mediaControl(cmd.deviceId, cmd.action);
          break;
      }
      reply({ ok: true });
    } catch (err) {
      reply({ ok: false, error: (err as Error).message });
    }
    server.broadcastRemoteState();
  });
}

// --------------------------------------------------------------------------- lifecycle

function quitApp(): void {
  quitting = true;
  app.quit();
}

app.on('second-instance', () => showWindow());

app.whenReady().then(async () => {
  log.info('app', `AirWing ${appVersion()} starting (electron ${process.versions.electron}, chrome ${process.versions.chrome})`);
  installDisplayMediaHandler();
  registerIpc();
  wireRemote();
  try {
    await server.start();
    const addr = preferredAddress();
    log.info('server', `browser receiver: ${server.receiverUrl(addr)}  phone remote: ${server.remoteUrl(addr)}`);
  } catch (err) {
    log.error('server', err as Error);
  }
  discovery.on('change', (list: Device[]) => {
    send(IPC.devicesChanged, list);
    refreshTray();
  });
  discovery.start();
  for (const m of settings.get().manualDevices) {
    const port = m.port || (m.kind === 'cast' ? 8009 : 7000);
    discovery.addManual({
      id: `${m.kind}:${m.host}:${port}`,
      kind: m.kind,
      name: m.name || `${m.host} (${m.kind === 'cast' ? 'Cast' : 'AirPlay'})`,
      host: m.host,
      port,
      txt: {},
      manual: true,
      lastSeen: Date.now(),
      caps: { video: true, audio: true, pairingRequired: false, transientPairing: true, paired: !!credentials.get(`${m.kind}:${m.host}`) },
    });
  }
  sessions.on('change', (list) => {
    send(IPC.sessionsChanged, list);
    refreshTray();
    server.broadcastRemoteState();
  });
  sessions.on('pairing-required', (prompt) => {
    showWindow();
    send(IPC.pairingPrompt, prompt);
  });
  hub.on('stats', () => send(IPC.streamStats, hub.stats(sessions.count)));
  hub.on('meta', () => send(IPC.streamStats, hub.stats(sessions.count)));
  hub.on('end', () => send(IPC.streamStats, hub.stats(sessions.count)));
  server.on('viewer', (count: number) => {
    // A new browser viewer needs a keyframe quickly.
    if (count > 0 && hub.active) sendCaptureCommand({ type: 'keyframe' });
    send(IPC.streamStats, hub.stats(sessions.count));
  });
  log.on('log', (ev) => send(IPC.logEvent, ev));
  settings.on('change', (s) => send(IPC.settingsChanged, s));

  mainWindow = createWindow();
  createTray();
  registerHotkeys();
  if (process.argv.includes('--hidden')) mainWindow.hide();
});

app.on('window-all-closed', () => {
  // Keep running in the tray.
});

app.on('activate', () => showWindow());

app.on('before-quit', () => {
  quitting = true;
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  void sessions.disconnectAll();
  discovery.stop();
  server.stop();
  settings.saveSync();
});
