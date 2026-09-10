// Diagnostic: launch the built app, start capture, dump per-track timestamps and viewer MSE state.
const { _electron: electron } = require('playwright');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

function boxes(buf, start = 0, end = buf.length) {
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    const size = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    if (size < 8) break;
    out.push({ type, start: p, size, payload: buf.subarray(p + 8, p + size) });
    p += size;
  }
  return out;
}

function fragInfo(seg) {
  const out = [];
  for (const b of boxes(seg)) {
    if (b.type !== 'moof') continue;
    const traf = boxes(b.payload).find((x) => x.type === 'traf');
    const tfhd = boxes(traf.payload).find((x) => x.type === 'tfhd');
    const tfdt = boxes(traf.payload).find((x) => x.type === 'tfdt');
    const trun = boxes(traf.payload).find((x) => x.type === 'trun');
    out.push({ track: tfhd.payload.readUInt32BE(4), bmdt: Number(tfdt.payload.readBigUInt64BE(4)), dur: trun.payload.readUInt32BE(12), size: trun.payload.readUInt32BE(16), flags: trun.payload.readUInt32BE(20).toString(16) });
  }
  return out;
}

(async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'airwing-diag-'));
  const app = await electron.launch({ args: [path.join(process.cwd(), 'out/main/index.js'), '--show', '--user-data-dir=' + userData], env: { ...process.env, AIRWING_DEBUG: '1' } });
  const page = await app.firstWindow();
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[main-renderer]', m.text()); });
  await page.waitForSelector('.source', { timeout: 30000 });
  const info = await page.evaluate(() => window.airwing.receiver.info());
  const base = 'http://127.0.0.1:' + info.port;
  await page.click('button:has-text("Start mirroring")');
  const t0 = Date.now();
  while ((await fetch(base + '/hls/live.m3u8')).status !== 200 && Date.now() - t0 < 30000) await new Promise((r) => setTimeout(r, 300));
  const stats = await page.evaluate(() => window.airwing.capture.stats());
  console.log('stats', JSON.stringify(stats));
  const playlist = await (await fetch(base + '/hls/live.m3u8')).text();
  console.log(playlist);
  const segs = [...playlist.matchAll(/seg-(\d+)\.m4s/g)].map((m) => m[1]);
  for (const s of segs.slice(0, 2)) {
    const seg = Buffer.from(await (await fetch(base + '/hls/seg-' + s + '.m4s')).arrayBuffer());
    const fr = fragInfo(seg);
    const v = fr.filter((f) => f.track === 1);
    const a = fr.filter((f) => f.track === 2);
    console.log('seg ' + s + ': ' + seg.length + ' bytes, ' + v.length + ' video frags (bmdt ' + (v[0] && v[0].bmdt) + '..' + (v[v.length - 1] && v[v.length - 1].bmdt) + ' = ' + (v[0] ? (v[0].bmdt / 90000).toFixed(3) : '?') + 's), ' + a.length + ' audio frags (bmdt ' + (a[0] && a[0].bmdt) + '..' + (a[a.length - 1] && a[a.length - 1].bmdt) + ' = ' + (a[0] ? (a[0].bmdt / 48000).toFixed(3) : '?') + 's)');
    console.log('  first video', JSON.stringify(v[0]), 'first audio', JSON.stringify(a[0]));
  }
  const viewerPromise = app.waitForEvent('window');
  await app.evaluate(({ BrowserWindow }, url) => {
    const w = new BrowserWindow({ width: 800, height: 450, show: true, webPreferences: { autoplayPolicy: 'no-user-gesture-required' } });
    w.loadURL(url);
  }, base + '/');
  const viewer = await viewerPromise;
  viewer.on('console', (m) => console.log('[viewer]', m.text()));
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const st = await viewer.evaluate(() => {
      const aw = window.__aw;
      const v = aw.video;
      const sb = aw.sb;
      const ranges = [];
      try {
        for (let i = 0; sb && i < sb.buffered.length; i++) ranges.push([sb.buffered.start(i).toFixed(3), sb.buffered.end(i).toFixed(3)]);
      } catch (e) {}
      const vr = [];
      try {
        for (let i = 0; i < v.buffered.length; i++) vr.push([v.buffered.start(i).toFixed(3), v.buffered.end(i).toFixed(3)]);
      } catch (e) {}
      return { t: v.currentTime.toFixed(3), ready: v.readyState, paused: v.paused, err: v.error && v.error.message, w: v.videoWidth, sbRanges: ranges, videoRanges: vr, queue: aw.queue.length, started: aw.started, gesture: aw.needsGesture, msState: aw.ms && aw.ms.readyState, updating: sb && sb.updating };
    });
    console.log('viewer', JSON.stringify(st));
  }
  await viewer.screenshot({ path: 'test-results/diag-viewer.png' });
  await app.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
