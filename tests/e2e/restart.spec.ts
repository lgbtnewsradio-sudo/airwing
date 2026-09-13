import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Regression tests for two dead ends found by exploratory testing:
 *  - after Stop, re-picking the source you already had did nothing, because capture only
 *    followed a *change* of source;
 *  - after Stop, picking a receiver waited ~15 s on a capture nobody restarted and then
 *    failed with "the capture did not start".
 */

let app: ElectronApplication;
let page: Page;

const stats = () => page.evaluate(() => window.airwing.capture.stats());

async function waitForActive(want: boolean, timeoutMs = 20000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if ((await stats()).active === want) return true;
    await page.waitForTimeout(250);
  }
  return false;
}

test.beforeAll(async () => {
  const userData = mkdtempSync(join(tmpdir(), 'airwing-restart-'));
  app = await electron.launch({
    args: [join(process.cwd(), 'out/main/index.js'), '--show', `--user-data-dir=${userData}`],
    env: { ...process.env, AIRWING_DEBUG: '1' },
  });
  page = await app.firstWindow();
  await page.waitForSelector('.app', { timeout: 30000 });
  expect(await waitForActive(true, 30000)).toBe(true);
});

test.afterAll(async () => {
  await app?.close();
});

test('re-picking the source already selected restarts capture after Stop', async () => {
  test.setTimeout(90000);
  await page.click('.toolbar button[title="Stop"]');
  expect(await waitForActive(false)).toBe(true);

  // Click the row that is already selected; the selection does not change.
  await page.locator('.list .row.selected').first().click();
  expect(await waitForActive(true)).toBe(true);
});

test('picking a receiver while stopped starts capture instead of timing out', async () => {
  test.setTimeout(90000);
  await page.click('.toolbar button[title="Stop"]');
  expect(await waitForActive(false)).toBe(true);

  // A receiver that will never answer: the connection fails, but capture must still come
  // back promptly rather than the UI sitting on a 15 s timeout.
  await page.evaluate(() => window.airwing.devices.addManual({ host: '127.0.0.1', port: 59999, kind: 'cast', name: 'Unreachable Probe' }));
  const row = page.locator('.row.receiver', { hasText: 'Unreachable Probe' });
  await expect(row).toBeVisible();
  const started = Date.now();
  await row.locator('.row-main').click();
  expect(await waitForActive(true, 12000)).toBe(true);
  expect(Date.now() - started).toBeLessThan(12000);

  await page.evaluate(async () => {
    for (const d of await window.airwing.devices.list()) if (d.manual) await window.airwing.devices.removeManual(d.id);
  });
});
