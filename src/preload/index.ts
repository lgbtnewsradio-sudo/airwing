import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC,
  type AppSettings,
  type CaptureCommand,
  type CaptureSource,
  type Device,
  type DeviceKind,
  type DisplayInfo,
  type ExtendDesktopInfo,
  type LogEvent,
  type MediaControlAction,
  type PairingPrompt,
  type ReceiverInfo,
  type Rect,
  type SessionInfo,
  type StreamConfig,
  type StreamMeta,
  type StreamStats,
} from '@shared/types';
import type { FragmentInfo } from '@shared/fmp4';

type Unsubscribe = () => void;

function on<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const handler = (_e: unknown, payload: T) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api = {
  devices: {
    list: (): Promise<Device[]> => ipcRenderer.invoke(IPC.devicesList),
    rescan: (): Promise<void> => ipcRenderer.invoke(IPC.devicesRescan),
    addManual: (input: { host: string; port?: number; kind: DeviceKind; name?: string }): Promise<Device> => ipcRenderer.invoke(IPC.devicesAddManual, input),
    removeManual: (id: string): Promise<void> => ipcRenderer.invoke(IPC.devicesRemoveManual, id),
    forget: (id: string): Promise<void> => ipcRenderer.invoke(IPC.devicesForget, id),
    onChange: (cb: (devices: Device[]) => void) => on<Device[]>(IPC.devicesChanged, cb),
  },
  sources: {
    list: (): Promise<CaptureSource[]> => ipcRenderer.invoke(IPC.sourcesList),
    displays: (): Promise<DisplayInfo[]> => ipcRenderer.invoke(IPC.displaysList),
    selectRegion: (displayId?: string): Promise<Rect | null> => ipcRenderer.invoke(IPC.regionSelect, displayId),
    extendInfo: (): Promise<ExtendDesktopInfo> => ipcRenderer.invoke(IPC.extendDesktopInfo),
    extendInstall: (): Promise<void> => ipcRenderer.invoke(IPC.extendDesktopInstall),
  },
  capture: {
    start: (config: StreamConfig): Promise<void> => ipcRenderer.invoke(IPC.captureStart, config),
    stop: (): Promise<void> => ipcRenderer.invoke(IPC.captureStop),
    pause: (paused: boolean): Promise<void> => ipcRenderer.invoke(IPC.capturePause, paused),
    status: (): Promise<{ active: boolean; paused: boolean; config: StreamConfig | null }> => ipcRenderer.invoke(IPC.captureStatus),
    onCommand: (cb: (cmd: CaptureCommand) => void) => on<CaptureCommand>(IPC.captureCommand, cb),
    sendMeta: (meta: StreamMeta) => ipcRenderer.send(IPC.streamMeta, meta),
    sendData: (data: Uint8Array, info: FragmentInfo) => ipcRenderer.send(IPC.streamData, data, info),
    sendState: (state: { active: boolean; paused: boolean; dropped?: number; error?: string; reason?: string }) => ipcRenderer.send(IPC.streamState, state),
    stats: (): Promise<StreamStats> => ipcRenderer.invoke(IPC.streamStats),
    onStats: (cb: (stats: StreamStats) => void) => on<StreamStats>(IPC.streamStats, cb),
  },
  sessions: {
    connect: (deviceId: string, target?: { type: 'live' } | { type: 'file'; path: string }): Promise<SessionInfo> => ipcRenderer.invoke(IPC.sessionConnect, deviceId, target),
    disconnect: (deviceId: string): Promise<void> => ipcRenderer.invoke(IPC.sessionDisconnect, deviceId),
    list: (): Promise<SessionInfo[]> => ipcRenderer.invoke(IPC.sessionsList),
    mediaControl: (deviceId: string, action: MediaControlAction): Promise<void> => ipcRenderer.invoke(IPC.sessionMediaControl, deviceId, action),
    onChange: (cb: (sessions: SessionInfo[]) => void) => on<SessionInfo[]>(IPC.sessionsChanged, cb),
  },
  pairing: {
    start: (deviceId: string): Promise<void> => ipcRenderer.invoke(IPC.pairingStart, deviceId),
    finish: (deviceId: string, pin: string): Promise<void> => ipcRenderer.invoke(IPC.pairingFinish, deviceId, pin),
    cancel: (deviceId: string): Promise<void> => ipcRenderer.invoke(IPC.pairingCancel, deviceId),
    onPrompt: (cb: (prompt: PairingPrompt) => void) => on<PairingPrompt>(IPC.pairingPrompt, cb),
  },
  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.settingsGet),
    set: (patch: Partial<AppSettings>): Promise<AppSettings> => ipcRenderer.invoke(IPC.settingsSet, patch),
    onChange: (cb: (s: AppSettings) => void) => on<AppSettings>(IPC.settingsChanged, cb),
  },
  receiver: {
    info: (): Promise<ReceiverInfo> => ipcRenderer.invoke(IPC.receiverInfo),
  },
  media: {
    pick: (): Promise<{ path: string; name: string; mime: string; size: number; url: string } | null> => ipcRenderer.invoke(IPC.mediaPick),
  },
  app: {
    version: (): Promise<string> => ipcRenderer.invoke(IPC.appVersion),
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke(IPC.appOpenExternal, url),
    quit: (): Promise<void> => ipcRenderer.invoke(IPC.appQuit),
    logs: (): Promise<LogEvent[]> => ipcRenderer.invoke(IPC.logList),
    onLog: (cb: (ev: LogEvent) => void) => on<LogEvent>(IPC.logEvent, cb),
    minimize: (): Promise<void> => ipcRenderer.invoke(IPC.windowMinimize),
    close: (): Promise<void> => ipcRenderer.invoke(IPC.windowClose),
  },
  region: {
    result: (rect: Rect | null) => ipcRenderer.send('region:result', rect),
  },
};

export type AirWingApi = typeof api;

contextBridge.exposeInMainWorld('airwing', api);
