const { chromium } = require('playwright');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { mkdirSync } = require('node:fs');

(async () => {
  const root = join(__dirname, '..');
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--allow-file-access-from-files'] });
  try {
    const page = await browser.newPage({ viewport: { width: 820, height: 760 }, deviceScaleFactor: 2, colorScheme: 'dark' });
    page.on('pageerror', error => console.error(error.message));
    await page.addInitScript(() => {
      const noop = () => {};
      const subscribe = () => noop;
      const stream = { sourceKind: 'media', resolution: '1080p', frameRate: 30, quality: 'auto', latency: 'balanced', adaptiveCast: true, castAudio: true, audio: true, muteLocal: false, audioBitrate: 160000, mediaMode: 'auto' };
      const settings = { stream, recentDevices: [], favoriteDevices: ['demo-apple'], manualDevices: [], hotkeys: { toggleMirror: 'CommandOrControl+Shift+M', togglePause: 'CommandOrControl+Shift+P', stopAll: 'CommandOrControl+Shift+X' }, startMinimized: false, launchAtLogin: false, showNotifications: true, serverPort: 47000, bindAddress: '', receiverRequireCode: true, theme: 'dark', deviceName: 'AirWing on this PC' };
      const devices = [
        { id: 'demo-apple', kind: 'airplay', name: 'Living room Apple TV', model: 'AppleTV6,2', host: '192.0.2.10', port: 7000, txt: {}, lastSeen: Date.now(), caps: { video: true, audio: true, pairingRequired: true, transientPairing: true, paired: true, airplayVersion: 2 } },
        { id: 'demo-cast', kind: 'cast', name: 'Presentation display', model: 'Google Cast', host: '192.0.2.11', port: 8009, txt: {}, lastSeen: Date.now(), caps: { video: true, audio: true, pairingRequired: false, transientPairing: false, paired: true } },
      ];
      const stats = { active: false, paused: false, fps: 0, kbps: 0, droppedFrames: 0, encodedFrames: 0, uptimeSec: 0, sinks: 0, viewers: 0 };
      window.airwing = {
        devices: { list: async () => devices, onChange: subscribe, rescan: async () => {}, addManual: async () => devices[0], removeManual: async () => {}, forget: async () => {} },
        sources: { list: async () => [{ id: 'screen:demo', kind: 'screen', name: 'Display 1', size: { width: 1920, height: 1080 } }], displays: async () => [], selectRegion: async () => null, extendInfo: async () => ({ virtualDisplays: [], driverInstalled: false, driverUrl: '' }) },
        capture: { start: async () => {}, stop: async () => {}, pause: async () => {}, stats: async () => stats, status: async () => ({ active: false, paused: false, config: null }), onCommand: subscribe, onStats: subscribe, onMirrorTap: subscribe, onCastMirrorTap: subscribe, sendData: noop, sendMeta: noop, sendState: noop, sendMirrorFrame: noop, sendCastMirrorFrame: noop, sendCastMirrorUnavailable: noop, sendCastMirrorAudio: noop, sendCastMirrorEncoder: noop },
        sessions: { list: async () => [], onChange: subscribe, connect: async () => {}, disconnect: async () => {}, mediaControl: async () => {} },
        pairing: { onPrompt: subscribe, start: async () => {}, finish: async () => {}, cancel: async () => {} },
        settings: { get: async () => settings, set: async patch => Object.assign(settings, patch), onChange: subscribe },
        receiver: { info: async () => ({ url: 'http://192.0.2.1:47000/', remoteUrl: 'http://192.0.2.1:47000/remote', code: '123456', port: 47000, addresses: ['192.0.2.1'] }) },
        media: { pick: async () => null },
        app: { version: async () => '1.2.0', distribution: async () => 'store', logs: async () => [], onLog: subscribe, openExternal: async () => {}, quit: async () => {}, exportDiagnostics: async () => true, minimize: async () => {}, close: async () => {} },
        region: { result: noop },
      };
    });
    await page.goto(pathToFileURL(join(root, 'out/renderer/index.html')).href);
    await page.waitForSelector('.app');
    const output = join(root, 'site/assets');
    mkdirSync(output, { recursive: true });
    await page.getByText('Presentation display', { exact: true }).waitFor();
    await page.screenshot({ path: join(output, 'app-overview.png') });
    await page.click('.footer button[title="Settings"]');
    await page.getByText('Casting quality', { exact: true }).waitFor();
    await page.screenshot({ path: join(output, 'app-settings.png') });
    await page.click('.footer button[title="Diagnostics"]');
    await page.getByRole('button', { name: 'Export support bundle' }).waitFor();
    await page.screenshot({ path: join(output, 'app-diagnostics.png') });
    console.log('Saved three real-renderer screenshots using sample data only.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
