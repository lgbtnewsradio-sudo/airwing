import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let application: ElectronApplication;
let page: Page;
const userData = mkdtempSync(join(tmpdir(), 'airwing-release-'));
test.beforeAll(async () => {
  writeFileSync(join(userData, 'credentials.json'), JSON.stringify({ 'mock-only': 'synthetic-pairing-secret' }));
  application = await electron.launch({ args: [join(process.cwd(), 'out/main/index.js'), '--show',
    `--user-data-dir=${userData}`], env: { ...process.env, AIRWING_E2E: '1' } });
  page = await application.firstWindow(); await page.waitForSelector('.app');
});
test.afterAll(async () => { await application?.close(); });

test('Windows-protected storage migrates legacy keys at startup', async () => {
  expect(await application.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable())).toBe(true);
  const file = readFileSync(join(userData, 'credentials.json'), 'utf8');
  expect(file).not.toContain('synthetic-pairing-secret'); expect(JSON.parse(file).version).toBe(2);
  const restored = await application.evaluate(({ safeStorage }, encoded) => safeStorage.decryptString(Buffer.from(encoded, 'base64')), JSON.parse(file).entries['mock-only']);
  expect(restored).toBe('synthetic-pairing-secret');
});

test('quality and privacy controls persist without overlapping diagnostics', async () => {
  await page.click('.footer button[title="Settings"]');
  await page.getByLabel('Preset (applies next time you start)').selectOption('quality');
  await expect.poll(() => page.evaluate(() => window.airwing.settings.get().then((s) => s.stream.quality))).toBe('high');
  await page.getByLabel('Automatically adjust Cast bitrate to connection health').uncheck();
  await expect.poll(() => page.evaluate(() => window.airwing.settings.get().then((s) => s.stream.adaptiveCast))).toBe(false);
  await page.getByLabel('Require a code for browser viewers').check();
  await page.click('.footer button[title="Diagnostics"]');
  await expect(page.getByRole('button', { name: 'Export support bundle' })).toBeVisible();
  await page.evaluate(() => window.airwing.capture.stop());
  await application.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('log:event', { ts: Date.now(), level: 'info', scope: 'castmirror:192.168.123.123-with-a-long-scope', message: 'A'.repeat(300) });
  });
  const geometry = await page.locator('.log-line').last().evaluate((row) => {
    const scope = row.querySelector('.scope')!.getBoundingClientRect();
    const message = row.querySelector('.msg')!.getBoundingClientRect();
    return { scopeRight: scope.right, messageLeft: message.left, rowWidth: row.clientWidth, scrollWidth: row.scrollWidth };
  });
  expect(geometry.scopeRight).toBeLessThanOrEqual(geometry.messageLeft);
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.rowWidth + 1);
  await page.screenshot({ path: 'test-results/release-diagnostics.png' });
});

test('support export writes redacted diagnostics locally', async () => {
  const destination = join(mkdtempSync(join(tmpdir(), 'airwing-support-')), 'support.json');
  const info = await page.evaluate(() => window.airwing.receiver.info());
  const token = new URL(info.remoteUrl).searchParams.get('token');
  await application.evaluate(({ dialog }, filePath) => {
    const original = dialog.showSaveDialog;
    (globalThis as any).__restoreSaveDialog = () => { dialog.showSaveDialog = original; };
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, destination);
  try {
    expect(await page.evaluate(() => window.airwing.app.exportDiagnostics())).toBe(true);
    const json = readFileSync(destination, 'utf8');
    expect(JSON.parse(json).version).toBe('1.2.0');
    if (token) expect(json).not.toContain(token);
    expect(JSON.parse(json).settings.stream.sourceId).toBe('[redacted]');
  } finally { await application.evaluate(() => (globalThis as any).__restoreSaveDialog()); }
});

test('Electron encodes and decodes synthetic Opus audio', async () => {
  const result = await page.evaluate(async () => {
    const chunks: EncodedAudioChunk[] = [];
    let decoderConfig: AudioDecoderConfig | undefined;
    const config: AudioEncoderConfig = { codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: 160000, opus: { frameDuration: 20000, format: 'opus' } };
    const supported = await AudioEncoder.isConfigSupported(config);
    if (!supported.supported) throw new Error('Opus encoder unavailable');
    let error = '';
    const encoder = new AudioEncoder({ output: (chunk, metadata) => { chunks.push(chunk); decoderConfig ??= metadata?.decoderConfig; }, error: (e) => { error = e.message; } });
    encoder.configure(config);
    for (let i = 0; i < 10; i++) {
      const data = new Float32Array(1920);
      for (let sample = 0; sample < 960; sample++) data[sample] = data[sample + 960] = 0.1 * Math.sin(2 * Math.PI * 440 * (i * 960 + sample) / 48000);
      const frame = new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: 960, numberOfChannels: 2, timestamp: i * 20000, data });
      encoder.encode(frame); frame.close();
    }
    await encoder.flush(); encoder.close();
    let decoded = 0;
    const decoder = new AudioDecoder({ output: (data) => { decoded += data.numberOfFrames; data.close(); }, error: (e) => { error = e.message; } });
    decoder.configure(decoderConfig ?? { codec: 'opus', sampleRate: 48000, numberOfChannels: 2 });
    for (const chunk of chunks) decoder.decode(chunk);
    await decoder.flush(); decoder.close();
    return { chunks: chunks.length, decoded, error };
  });
  expect(result.error).toBe(''); expect(result.chunks).toBeGreaterThan(0); expect(result.decoded).toBeGreaterThanOrEqual(9600);
});

test('active Cast tap produces 720p VP8 and a valid audio configuration', async () => {
  await page.evaluate(async () => {
    const settings = await window.airwing.settings.get();
    await window.airwing.capture.start({ ...settings.stream, sourceKind: 'screen', castAudio: true, adaptiveCast: true });
  });
  await expect.poll(() => page.evaluate(() => window.airwing.capture.stats().then((s) => s.fps)), { timeout: 20000 }).toBeGreaterThan(0);
  await application.evaluate(({ ipcMain, BrowserWindow }) => {
    const state = { video: 0, audio: 0, info: null as unknown };
    (globalThis as any).__castTest = state;
    ipcMain.on('castMirror:frame', () => state.video++);
    ipcMain.on('castMirror:audio', () => state.audio++);
    ipcMain.on('castMirror:encoder', (_event, info) => { state.info = info; });
    BrowserWindow.getAllWindows()[0].webContents.send('castMirror:tap', true);
  });
  await expect.poll(() => application.evaluate(() => (globalThis as any).__castTest.video), { timeout: 10000 }).toBeGreaterThan(0);
  const state = await application.evaluate(() => (globalThis as any).__castTest);
  expect(state.info.width).toBeGreaterThan(0); expect(state.info.height).toBeLessThanOrEqual(720); expect(state.info.fps).toBeLessThanOrEqual(30);
  expect(state.info.audioRequested).toBe(true);
  if (state.info.audio) {
    expect(state.info.audio.sampleRate).toBe(48000);
    await expect.poll(() => application.evaluate(() => (globalThis as any).__castTest.audio), { timeout: 10000 }).toBeGreaterThan(0);
  }
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('castMirror:tap', false));
  await page.evaluate(() => window.airwing.capture.stop());
});
