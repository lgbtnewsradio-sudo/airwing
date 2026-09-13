// Exploratory behavioural testing of the real AirWing app.
// Drives the UI the way a person would and reports PASS/FAIL per scenario.
// Never clicks a receiver row belonging to a real device on the LAN, and always closes
// the app it launched, even on failure.
const { _electron: electron } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const results = [];
function report(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`);
}

const root = 'C:/Users/miked/airwing';

(async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'airwing-explore-'));
  const app = await electron.launch({
    args: [path.join(root, 'out/main/index.js'), '--show', `--user-data-dir=${userData}`],
    cwd: root,
    env: { ...process.env, AIRWING_DEBUG: '1' },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('.app', { timeout: 30000 });
    const stats = () => page.evaluate(() => window.airwing.capture.stats());
    const status = () => page.evaluate(() => window.airwing.capture.status());
    const waitActive = async (want, ms = 15000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if ((await stats()).active === want) return true;
        await page.waitForTimeout(300);
      }
      return false;
    };
    // Source rows only — the receiver list is a separate `.to-list`.
    const fromRow = (text) => page.locator(`.from-list .row:has-text("${text}")`).first();

    report('auto-start on launch', await waitActive(true, 30000), 'capture active without pressing anything');

    // ---- Stop, then re-pick the source that is already selected.
    await page.click('.toolbar button[title="Stop"]');
    report('toolbar Stop stops capture', await waitActive(false, 12000));
    await page.locator('.from-list .row.selected').first().click();
    report('clicking the already-selected source after Stop restarts capture', await waitActive(true, 12000));

    // ---- Stop, then pick a receiver. Uses a loopback address that answers nothing, so no
    // real device on the network is ever contacted.
    await page.click('.toolbar button[title="Stop"]');
    await waitActive(false, 12000);
    await page.evaluate(() => window.airwing.devices.addManual({ host: '127.0.0.1', port: 59999, kind: 'cast', name: 'Probe Receiver' }));
    await page.waitForTimeout(600);
    const t0 = Date.now();
    await page.locator('.to-list .row.receiver', { hasText: 'Probe Receiver' }).locator('.row-main').click();
    const cameBack = await waitActive(true, 12000);
    report('clicking a receiver while stopped starts capture', cameBack, cameBack ? `after ${((Date.now() - t0) / 1000).toFixed(1)}s` : 'never restarted');

    // ---- Every source kind follows the selection.
    for (const [label, kind] of [
      ['Audio Only', 'audio'],
      ['Display 1', 'screen'],
    ]) {
      await fromRow(label).click();
      const ok = await waitActive(true, 15000);
      const cfg = await status();
      report(`selecting "${label}" starts capture`, ok && cfg.config?.sourceKind === kind, `active=${ok} sourceKind=${cfg.config?.sourceKind}`);
    }

    // ---- Single application capture.
    await fromRow('Application').click();
    await page.waitForTimeout(1200);
    const windowRows = page.locator('.from-list .row');
    const count = await windowRows.count();
    let windowOk = false;
    let windowDetail = 'no windows listed';
    if (count > 0) {
      const name = (await windowRows.first().innerText().catch(() => '')).trim().replace(/\s+/g, ' ');
      await windowRows.first().click();
      const active = await waitActive(true, 15000);
      const cfg = await status();
      windowOk = active && cfg.config?.sourceKind === 'window';
      windowDetail = `picked "${name.slice(0, 32)}" sourceKind=${cfg.config?.sourceKind}`;
    }
    report('single-application capture works', windowOk, windowDetail);

    // ---- Extend Desktop sub-view.
    await fromRow('Display 1').click();
    await waitActive(true, 12000);
    await page.click('.toolbar button[title="Stop"]');
    await waitActive(false, 10000);
    await fromRow('Extend Desktop').click();
    await page.waitForTimeout(1500);
    let extendOk = false;
    let extendDetail = '';
    if (await page.locator('.subview').count()) {
      const display = page.locator('.subview .source').first();
      if (await display.count()) {
        await display.click();
        extendOk = await waitActive(true, 12000);
        extendDetail = extendOk ? 'started capture and returned to the main view' : 'clicking a display in the sub-view did not start capture';
      } else {
        extendOk = true;
        extendDetail = 'no virtual display on this machine (driver not installed) — nothing to click';
        await page.locator('.subview .back').first().click().catch(() => {});
      }
    } else {
      extendDetail = 'Extend Desktop did not open a sub-view';
    }
    report('Extend Desktop sub-view selection starts capture', extendOk, extendDetail);

    // ---- The app can actually be closed once nothing is receiving.
    await page.waitForTimeout(500);
    const closable = await page.evaluate(() => window.airwing.capture.stats().then((s) => s.viewers === 0));
    report('no phantom viewers holding the app open', closable, `viewers=${closable ? 0 : 'non-zero'}`);

    await page.evaluate(async () => {
      for (const d of await window.airwing.devices.list()) if (d.manual) await window.airwing.devices.removeManual(d.id);
    });

    console.log('\n--- summary ---');
    console.log(`${results.filter((r) => r.ok).length}/${results.length} passed`);
    for (const r of results.filter((x) => !x.ok)) console.log(`  FAILED: ${r.name} :: ${r.detail}`);
  } finally {
    // Always tear the app down; a crashed harness previously left one running.
    await app.close().catch(() => {});
  }
})().catch((e) => {
  console.error('HARNESS ERROR', String(e).slice(0, 400));
  process.exit(1);
});
