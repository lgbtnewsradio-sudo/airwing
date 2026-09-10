/* Generates build/icon.png (256px), resources/icon.png and resources/tray.png (32px) without external deps. */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(width, height, pixels) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    pixels.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Signed distance helpers for a paper-plane / wing silhouette.
function inTriangle(px, py, a, b, c) {
  const s1 = (b[0] - a[0]) * (py - a[1]) - (b[1] - a[1]) * (px - a[0]);
  const s2 = (c[0] - b[0]) * (py - b[1]) - (c[1] - b[1]) * (px - b[0]);
  const s3 = (a[0] - c[0]) * (py - c[1]) - (a[1] - c[1]) * (px - c[0]);
  return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
}

function render(size, { transparentBg = false } = {}) {
  const px = Buffer.alloc(size * size * 4);
  const cx = size / 2, cy = size / 2, r = size * 0.47;
  const ss = 3; // supersampling
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let rr = 0, gg = 0, bb = 0, aa = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const fx = x + (sx + 0.5) / ss, fy = y + (sy + 0.5) / ss;
          const d = Math.hypot(fx - cx, fy - cy);
          let cr = 0, cg = 0, cb = 0, ca = 0;
          if (!transparentBg && d <= r) {
            const t = (fy / size);
            cr = 24 + 20 * (1 - t); cg = 120 + 60 * (1 - t); cb = 210 + 30 * (1 - t); ca = 255;
          }
          // wing shape: two triangles forming a stylised wing / plane, in unit coords
          const u = (fx - cx) / r, v = (fy - cy) / r;
          const big = inTriangle(u, v, [-0.62, 0.08], [0.66, -0.42], [-0.05, 0.36]);
          const tail = inTriangle(u, v, [-0.05, 0.36], [0.66, -0.42], [0.12, 0.58]);
          const fold = inTriangle(u, v, [-0.62, 0.08], [-0.05, 0.36], [-0.02, 0.06]);
          if (big || tail) {
            const shade = fold ? 200 : tail ? 225 : 255;
            cr = shade; cg = shade; cb = shade; ca = 255;
            if (transparentBg) { cr = 255; cg = 255; cb = 255; }
          }
          rr += cr; gg += cg; bb += cb; aa += ca;
        }
      }
      const n = ss * ss;
      const i = (y * size + x) * 4;
      px[i] = Math.round(rr / n); px[i + 1] = Math.round(gg / n); px[i + 2] = Math.round(bb / n); px[i + 3] = Math.round(aa / n);
    }
  }
  return png(size, size, px);
}

const root = path.join(__dirname, '..');
fs.mkdirSync(path.join(root, 'build'), { recursive: true });
fs.mkdirSync(path.join(root, 'resources'), { recursive: true });
fs.writeFileSync(path.join(root, 'build', 'icon.png'), render(256));
fs.writeFileSync(path.join(root, 'resources', 'icon.png'), render(256));
fs.writeFileSync(path.join(root, 'resources', 'tray.png'), render(32));
fs.writeFileSync(path.join(root, 'resources', 'tray@2x.png'), render(64));
console.log('icons written');
