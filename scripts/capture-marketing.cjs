const { chromium } = require('playwright');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { mkdirSync } = require('node:fs');

(async () => {
  const root = join(__dirname, '..');
  const version = require('../package.json').version;
  const compact = process.argv.includes('--compact');
  const inspect = process.argv.includes('--inspect');
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--allow-file-access-from-files', ...(inspect ? ['--remote-debugging-port=9223'] : [])] });
  try {
    const page = await browser.newPage({ viewport: { width: compact ? 375 : 820, height: compact ? 720 : 760 }, deviceScaleFactor: 2, colorScheme: 'dark' });
    page.on('pageerror', error => console.error(error.message));
    await page.addInitScript((version) => {
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
        capture: { start: async () => {}, stop: async () => {}, pause: async () => {}, stats: async () => stats, status: async () => ({ active: false, paused: false, config: null }), onCommand: subscribe, onStats: subscribe, onMirrorTap: subscribe, onCastMirrorTap: subscribe, sendData: noop, sendMeta: noop, sendState: noop, sendMirrorFrame: noop, sendMirrorAudio: noop, sendCastMirrorFrame: noop, sendCastMirrorUnavailable: noop, sendCastMirrorAudio: noop, sendCastMirrorEncoder: noop },
        sessions: { list: async () => [], onChange: subscribe, connect: async () => {}, disconnect: async () => {}, mediaControl: async () => {} },
        pairing: { onPrompt: subscribe, start: async () => {}, finish: async () => {}, cancel: async () => {} },
        settings: { get: async () => settings, set: async patch => Object.assign(settings, patch), onChange: subscribe },
        receiver: { info: async () => ({ url: 'http://192.0.2.1:47000/', remoteUrl: 'http://192.0.2.1:47000/remote', code: '123456', port: 47000, addresses: ['192.0.2.1'] }) },
        media: { pick: async () => null },
        app: { version: async () => version, distribution: async () => 'store', logs: async () => [], onLog: subscribe, openExternal: async () => {}, quit: async () => {}, exportDiagnostics: async () => true, minimize: async () => {}, close: async () => {} },
        region: { result: noop },
      };
    }, version);
    await page.goto(pathToFileURL(join(root, 'out/renderer/index.html')).href);
    await page.waitForSelector('.app');
    const output = join(root, compact ? 'test-results/compact' : 'site/assets');
    mkdirSync(output, { recursive: true });
    await page.getByText('Presentation display', { exact: true }).waitFor();
    const checkWidth = async () => {
      if (!compact) return;
      const overflow = await page.evaluate(() => Array.from(document.querySelectorAll('.app, .subview, .toolbar, .footer'))
        .filter(element => element.scrollWidth > element.clientWidth + 1).map(element => ({ class: element.className, width: element.clientWidth, content: element.scrollWidth })));
      if (overflow.length) throw new Error(`Compact layout overflow: ${JSON.stringify(overflow)}`);
    };
    await checkWidth();
    await page.screenshot({ path: join(output, 'app-overview.png') });
    await page.click('.footer button[title="Settings"]');
    await page.getByText('Casting quality', { exact: true }).waitFor();
    await checkWidth();
    await page.screenshot({ path: join(output, 'app-settings.png') });
    await page.click('.footer button[title="Diagnostics"]');
    await page.getByRole('button', { name: 'Export support bundle' }).waitFor();
    await checkWidth();
    await page.screenshot({ path: join(output, 'app-diagnostics.png') });
    console.log('Saved three real-renderer screenshots using sample data only.');
    if (inspect) { console.log('Sample renderer available on debugging port 9223. Close the browser when inspection is finished.'); await new Promise(resolve => browser.once('disconnected', resolve)); }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
