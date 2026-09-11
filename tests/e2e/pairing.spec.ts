import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockAirPlayReceiver } from '../mocks/airplayReceiver';

let app: ElectronApplication;
let page: Page;
const rx = new MockAirPlayReceiver({ allowTransient: false, pin: '1357', name: 'Mock Apple TV' });

test.beforeAll(async () => {
  await rx.start();
  const userData = mkdtempSync(join(tmpdir(), 'airwing-e2e-pair-'));
  app = await electron.launch({
    args: [join(process.cwd(), 'out/main/index.js'), '--show', `--user-data-dir=${userData}`],
    env: { ...process.env, AIRWING_DEBUG: '1' },
  });
  page = await app.firstWindow();
  await page.waitForSelector('.app', { timeout: 30000 });
});

test.afterAll(async () => {
  await app?.close();
  rx.stop();
});

test('pairing dialog recovers from a wrong code and then pairs through the UI', async () => {
  test.setTimeout(90000);
  await page.evaluate((port) => window.airwing.devices.addManual({ host: '127.0.0.1', port, kind: 'airplay', name: 'Mock Apple TV' }), rx.port);
  const device = page.locator('.row.receiver', { hasText: 'Mock Apple TV' });
  await expect(device).toBeVisible();
  // Primary path: clicking the receiver raises the pairing dialog on its own, because the
  // receiver refuses transient pairing and demands an on-screen code.
  await device.locator('.row-main').scrollIntoViewIfNeeded();
  await device.locator('.row-main').click();
  const modal = page.locator('.modal');
  await expect(modal).toBeVisible({ timeout: 30000 });
  await expect(modal.locator('input.pin')).toBeVisible({ timeout: 15000 });
  await modal.locator('input.pin').fill('0000');
  await modal.locator('button.primary', { hasText: 'Pair' }).click();
  await expect(modal.locator('.error')).toContainText('new code', { timeout: 15000 });
  await expect(modal.locator('input.pin')).toHaveValue('');
  await expect(modal.locator('button.primary', { hasText: 'Pair' })).toBeVisible();
  await modal.locator('input.pin').fill('1357');
  await modal.locator('button.primary', { hasText: 'Pair' }).click();
  await expect(modal).toBeHidden({ timeout: 15000 });
  expect(rx.pairedClients.size).toBe(1);
  await expect(device.locator('.row-sub')).toContainText(/Streaming|AirPlay/);
  await page.screenshot({ path: 'test-results/paired-device.png' });
});
