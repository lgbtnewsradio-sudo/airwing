/**
 * Types shared between the Electron main process, the preload bridge and the renderer UI.
 */

export type DeviceKind = 'airplay' | 'cast' | 'web' | 'raop';

export interface Device {
  /** Stable identifier (kind:host:port or the receiver's own id). */
  id: string;
  kind: DeviceKind;
  name: string;
  host: string;
  port: number;
  /** Model string reported by the receiver (e.g. AppleTV5,3, Chromecast Ultra). */
  model?: string;
  /** Raw TXT record properties from mDNS. */
  txt: Record<string, string>;
  /** True when the device was added manually by IP address. */
  manual?: boolean;
  /** Last time this device was seen on the network (ms since epoch). */
  lastSeen: number;
  /** Capability hints derived from TXT records. */
  caps: DeviceCaps;
}

export interface DeviceCaps {
  video: boolean;
  audio: boolean;
  /** Receiver requires a PIN/on-screen code pairing before it accepts streams. */
  pairingRequired: boolean;
  /** Receiver accepts HAP transient pairing (no on-screen PIN). */
  transientPairing: boolean;
  /** We already hold stored credentials for this receiver. */
  paired: boolean;
  /** AirPlay protocol generation. */
  airplayVersion?: 1 | 2;
}

export type SourceKind = 'screen' | 'window' | 'region' | 'audio' | 'media';

export interface CaptureSource {
  id: string;
  kind: 'screen' | 'window';
  name: string;
  thumbnail: string; // data URL
  appIcon?: string; // data URL
  displayId?: string;
  bounds?: Rect;
  isVirtualDisplay?: boolean;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ResolutionPreset = 'native' | '2160p' | '1440p' | '1080p' | '720p' | '480p';
export type FrameRatePreset = 60 | 30 | 24 | 15;
export type QualityPreset = 'auto' | 'best' | 'high' | 'balanced' | 'low';
export type LatencyMode = 'lowest' | 'balanced' | 'quality';

export interface StreamConfig {
  sourceKind: SourceKind;
  sourceId?: string;
  /** For region capture: rectangle in display pixels, relative to the display being captured. */
  region?: Rect;
  displayId?: string;
  resolution: ResolutionPreset;
  frameRate: FrameRatePreset;
  quality: QualityPreset;
  latency: LatencyMode;
  audio: boolean;
  /** Mute local playback while streaming system audio. */
  muteLocal: boolean;
  /** Custom video bitrate in bits per second (overrides quality preset when set). */
  videoBitrate?: number;
  audioBitrate: number;
  /** Media file path when sourceKind === 'media'. */
  mediaPath?: string;
  /** Media playback mode: direct sends the file URL to the receiver, transcode re-encodes it live. */
  mediaMode?: 'direct' | 'transcode' | 'auto';
}

export interface EncoderInfo {
  videoCodec: string;
  audioCodec: string;
  width: number;
  height: number;
  frameRate: number;
  videoBitrate: number;
  audioBitrate: number;
  hardwareAccelerated?: boolean;
}

export type SessionState = 'connecting' | 'pairing' | 'streaming' | 'paused' | 'error' | 'stopped';

export interface SessionInfo {
  id: string;
  device: Device;
  state: SessionState;
  error?: string;
  startedAt: number;
  /** Media transport chosen for this device (hls, mse, cast-media, airplay-url...). */
  transport: string;
  volume?: number;
  /** Playback info for direct media playback (seconds). */
  position?: number;
  duration?: number;
  playing?: boolean;
}

export interface StreamStats {
  active: boolean;
  paused: boolean;
  encoder?: EncoderInfo;
  fps: number;
  kbps: number;
  droppedFrames: number;
  encodedFrames: number;
  uptimeSec: number;
  sinks: number;
  viewers: number;
}

export interface AppSettings {
  stream: StreamConfig;
  recentDevices: string[];
  favoriteDevices: string[];
  manualDevices: { host: string; port?: number; kind: DeviceKind; name?: string }[];
  hotkeys: { toggleMirror: string; togglePause: string; stopAll: string };
  startMinimized: boolean;
  launchAtLogin: boolean;
  showNotifications: boolean;
  serverPort: number;
  /** Bind address for the local stream server. Empty = auto. */
  bindAddress: string;
  /** Require a 6-digit code before a browser receiver can watch. */
  receiverRequireCode: boolean;
  theme: 'system' | 'dark' | 'light';
  deviceName: string;
}

export interface ReceiverInfo {
  url: string;
  remoteUrl: string;
  code: string;
  port: number;
  addresses: string[];
}

export interface PairingPrompt {
  deviceId: string;
  deviceName: string;
  message: string;
}

export interface DisplayInfo {
  id: string;
  label: string;
  bounds: Rect;
  scaleFactor: number;
  primary: boolean;
  internal: boolean;
  isVirtual: boolean;
}

export interface ExtendDesktopInfo {
  virtualDisplays: DisplayInfo[];
  driverInstalled: boolean;
  driverUrl: string;
}

export const IPC = {
  devicesList: 'devices:list',
  devicesChanged: 'devices:changed',
  devicesAddManual: 'devices:addManual',
  devicesRemoveManual: 'devices:removeManual',
  devicesRescan: 'devices:rescan',
  devicesForget: 'devices:forget',
  sourcesList: 'sources:list',
  displaysList: 'displays:list',
  regionSelect: 'region:select',
  streamData: 'stream:data',
  streamMeta: 'stream:meta',
  streamStats: 'stream:stats',
  streamState: 'stream:state',
  captureStart: 'capture:start',
  captureStop: 'capture:stop',
  capturePause: 'capture:pause',
  captureStatus: 'capture:status',
  captureCommand: 'capture:command',
  sessionConnect: 'session:connect',
  sessionDisconnect: 'session:disconnect',
  sessionsList: 'session:list',
  sessionsChanged: 'session:changed',
  sessionMediaControl: 'session:mediaControl',
  pairingStart: 'pairing:start',
  pairingFinish: 'pairing:finish',
  pairingCancel: 'pairing:cancel',
  pairingPrompt: 'pairing:prompt',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  settingsChanged: 'settings:changed',
  receiverInfo: 'receiver:info',
  mediaPick: 'media:pick',
  appVersion: 'app:version',
  appOpenExternal: 'app:openExternal',
  appQuit: 'app:quit',
  logEvent: 'log:event',
  logList: 'log:list',
  windowMinimize: 'window:minimize',
  windowClose: 'window:close',
  extendDesktopInfo: 'extend:info',
  extendDesktopInstall: 'extend:install',
  localAddresses: 'net:addresses',
} as const;

export type MediaControlAction =
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'stop' }
  | { type: 'seek'; position: number }
  | { type: 'volume'; volume: number }
  | { type: 'mute'; muted: boolean };

export const DEFAULT_STREAM_CONFIG: StreamConfig = {
  sourceKind: 'screen',
  resolution: '1080p',
  frameRate: 30,
  quality: 'auto',
  latency: 'balanced',
  audio: true,
  muteLocal: false,
  audioBitrate: 160000,
  mediaMode: 'auto',
};

export const DEFAULT_SETTINGS: AppSettings = {
  stream: DEFAULT_STREAM_CONFIG,
  recentDevices: [],
  favoriteDevices: [],
  manualDevices: [],
  hotkeys: {
    toggleMirror: 'CommandOrControl+Shift+M',
    togglePause: 'CommandOrControl+Shift+P',
    stopAll: 'CommandOrControl+Shift+X',
  },
  startMinimized: false,
  launchAtLogin: false,
  showNotifications: true,
  serverPort: 47000,
  bindAddress: '',
  receiverRequireCode: false,
  theme: 'system',
  deviceName: '',
};

export interface LogEvent {
  ts: number;
  level: 'info' | 'warn' | 'error' | 'debug';
  scope: string;
  message: string;
}

/** Message from renderer capture pipeline describing the stream it is about to produce. */
export interface StreamMeta {
  encoder: EncoderInfo;
  /** MIME codecs string for MSE, e.g. avc1.640028,mp4a.40.2 */
  codecs: string;
  mime: string;
  audioOnly: boolean;
}

/** Commands sent from main to the renderer capture pipeline. */
export type CaptureCommand =
  | { type: 'start'; config: StreamConfig }
  | { type: 'stop' }
  | { type: 'pause'; paused: boolean }
  | { type: 'keyframe' };

export const RECEIVER_MDNS_SERVICE = '_airwing._tcp.local';
