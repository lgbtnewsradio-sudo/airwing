import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let app: ElectronApplication;
let page: Page;
let baseUrl = '';

test.beforeAll(async () => {
  const userData = mkdtempSync(join(tmpdir(), 'airwing-e2e-'));
  app = await electron.launch({
    args: [join(process.cwd(), 'out/main/index.js'), '--show', `--user-data-dir=${userData}`],
    env: { ...process.env, AIRWING_DEBUG: '1', AIRWING_E2E: '1' },
  });
  page = await app.firstWindow();
  await page.waitForSelector('.app', { timeout: 30000 });
  const info = await page.evaluate(() => window.airwing.receiver.info());
  baseUrl = `http://127.0.0.1:${info.port}`;
});

test.afterAll(async () => {
  await app?.close();
});

test('main window renders devices, sources and settings', async () => {
  await expect(page.locator('.brand .name')).toHaveText('AirWing');
  await expect(page.locator('.tab.active')).toHaveText('Mirror');
  await page.waitForSelector('.source', { timeout: 20000 });
  const sources = await page.locator('.source').count();
  expect(sources).toBeGreaterThan(0);
  const info = await page.evaluate(() => window.airwing.receiver.info());
  expect(info.port).toBeGreaterThan(0);
  baseUrl = `http://127.0.0.1:${info.port}`;
  const health = await (await fetch(baseUrl + '/healthz')).json();
  expect(health.ok).toBe(true);
  await page.screenshot({ path: 'test-results/main-window.png' });
  await page.click('button.tab:has-text("Settings")');
  await expect(page.locator('h3', { hasText: 'Keyboard shortcuts' })).toBeVisible();
  await page.click('button.tab:has-text("Browser")');
  await expect(page.locator('.url-row code').first()).toContainText(`:${info.port}`);
  await page.click('button.tab:has-text("Mirror")');
});

test('starts a real screen capture, encodes H.264 and serves HLS + WebSocket viewers', async () => {
  test.setTimeout(120000);
  await page.click('.linklike');
  await expect
    .poll(async () => (await page.evaluate(() => window.airwing.capture.stats())).active, { timeout: 30000 })
    .toBe(true);
  await expect
    .poll(async () => (await page.evaluate(() => window.airwing.capture.stats())).fps, { timeout: 30000, message: 'encoder should produce frames' })
    .toBeGreaterThan(0);
  const stats = await page.evaluate(() => window.airwing.capture.stats());
  expect(stats.encoder?.videoCodec).toMatch(/^avc1\./);
  expect(stats.encoder?.width).toBeGreaterThan(0);
  console.log('encoder', JSON.stringify(stats.encoder), 'fps', stats.fps, 'kbps', stats.kbps);

  // HLS becomes ready after a couple of segments.
  await expect.poll(async () => (await fetch(baseUrl + '/hls/live.m3u8')).status, { timeout: 30000 }).toBe(200);
  const playlist = await (await fetch(baseUrl + '/hls/live.m3u8')).text();
  expect(playlist).toContain('#EXT-X-MAP:URI="init.mp4"');
  const init = Buffer.from(await (await fetch(baseUrl + '/hls/init.mp4')).arrayBuffer());
  expect(init.subarray(4, 8).toString()).toBe('ftyp');
  expect(init.includes('avcC')).toBe(true);
  const segName = /seg-\d+\.m4s/.exec(playlist)![0];
  const seg = Buffer.from(await (await fetch(`${baseUrl}/hls/${segName}`)).arrayBuffer());
  expect(seg.subarray(4, 8).toString()).toBe('moof');
  expect(seg.length).toBeGreaterThan(1000);
  const info = await (await fetch(baseUrl + '/api/info')).json();
  expect(info.streaming).toBe(true);
  expect(info.codecs).toMatch(/avc1/);
  console.log('stream info', JSON.stringify(info));

  // Open the browser receiver in a second Electron window and check it decodes video.
  const viewerPromise = app.waitForEvent('window');
  await app.evaluate(({ BrowserWindow }, url) => {
    const w = new BrowserWindow({ width: 960, height: 540, show: true, webPreferences: { autoplayPolicy: 'no-user-gesture-required' } });
    void w.loadURL(url);
  }, baseUrl + '/');
  const viewer = await viewerPromise;
  await viewer.waitForLoadState('domcontentloaded');
  await expect
    .poll(
      async () =>
        viewer.evaluate(() => {
          const v = document.getElementById('video') as HTMLVideoElement;
          return { t: v.currentTime, w: v.videoWidth, ready: v.readyState };
        }),
      { timeout: 30000, message: 'viewer should decode frames' },
    )
    .toMatchObject({ w: expect.any(Number) });
  await expect.poll(async () => viewer.evaluate(() => (document.getElementById('video') as HTMLVideoElement).videoWidth), { timeout: 30000 }).toBeGreaterThan(0);
  await expect.poll(async () => viewer.evaluate(() => (document.getElementById('video') as HTMLVideoElement).currentTime), { timeout: 30000 }).toBeGreaterThan(0.2);
  const dims = await viewer.evaluate(() => {
    const v = document.getElementById('video') as HTMLVideoElement;
    return { w: v.videoWidth, h: v.videoHeight, t: v.currentTime };
  });
  console.log('viewer decoding', JSON.stringify(dims));
  await viewer.screenshot({ path: 'test-results/browser-receiver.png' });
  await expect.poll(async () => (await page.evaluate(() => window.airwing.capture.stats())).viewers, { timeout: 10000 }).toBeGreaterThanOrEqual(1);
  await page.screenshot({ path: 'test-results/main-window-streaming.png' });

  // Pause / resume keeps the stream alive.
  await page.click('.panel-header button:has-text("Pause")');
  await expect.poll(async () => (await page.evaluate(() => window.airwing.capture.stats())).paused, { timeout: 10000 }).toBe(true);
  await page.click('.panel-header button:has-text("Resume")');
  await expect.poll(async () => (await page.evaluate(() => window.airwing.capture.stats())).paused, { timeout: 10000 }).toBe(false);

  await viewer.close();
  await page.click('.panel-header button:has-text("Stop")');
  await expect.poll(async () => (await page.evaluate(() => window.airwing.capture.stats())).active, { timeout: 15000 }).toBe(false);
  expect((await fetch(baseUrl + '/hls/live.m3u8')).status).toBe(404);
});

test('audio-only capture produces an AAC/Opus stream', async () => {
  test.setTimeout(60000);
  await page.click('.segmented button:has-text("Audio only")');
  await page.click('.linklike');
  const result = await expect
    .poll(async () => (await page.evaluate(() => window.airwing.capture.stats())), { timeout: 30000 })
    .toMatchObject({ active: true });
  const stats = await page.evaluate(() => window.airwing.capture.stats());
  console.log('audio-only encoder', JSON.stringify(stats.encoder));
  await expect.poll(async () => (await fetch(baseUrl + '/api/info')).json().then((i) => i.audioOnly), { timeout: 20000 }).toBe(true);
  const info = await (await fetch(baseUrl + '/api/info')).json();
  expect(info.mime).toMatch(/^audio\/mp4/);
  await page.click('.panel-header button:has-text("Stop")');
  await expect.poll(async () => (await page.evaluate(() => window.airwing.capture.stats())).active, { timeout: 15000 }).toBe(false);
  await page.click('.segmented button:has-text("Entire display")');
  void result;
});
