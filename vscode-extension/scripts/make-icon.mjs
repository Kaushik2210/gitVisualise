// Draws the Marketplace icon (icon.png, 256x256) with no dependencies: a dark rounded square holding a small architecture graph
// (one entry node fanning out to three components, one of them highlighted). The PNG is committed; run this only to change it.
//
//   node scripts/make-icon.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const N = 256;
const bg = [11, 18, 32], panel = [20, 31, 52], line = [86, 108, 150], accent = [110, 160, 255], hot = [52, 211, 153], ink = [232, 236, 242];
const nodes = [
  { x: 64, y: 128, r: 20, c: accent },
  { x: 190, y: 66, r: 16, c: ink },
  { x: 190, y: 128, r: 16, c: hot },
  { x: 190, y: 190, r: 16, c: ink },
];
const edges = [[0, 1], [0, 2], [0, 3]];

const segDist = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};
const rrDist = (px, py, half, rad) => { // signed distance to a rounded square centred in the image
  const qx = Math.abs(px - N / 2) - (half - rad), qy = Math.abs(py - N / 2) - (half - rad);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rad;
};
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const cover = (d) => Math.max(0, Math.min(1, 0.5 - d)); // anti-aliasing: 1 inside, 0 outside, a one-pixel ramp on the edge

const raw = Buffer.alloc(N * (N * 4 + 1));
for (let y = 0; y < N; y++) {
  raw[y * (N * 4 + 1)] = 0; // filter: none
  for (let x = 0; x < N; x++) {
    const px = x + 0.5, py = y + 0.5;
    let rgb = mix(panel, bg, Math.min(1, Math.hypot(px - 128, py - 128) / 180));
    for (const [a, b] of edges) rgb = mix(rgb, line, cover(segDist(px, py, nodes[a].x, nodes[a].y, nodes[b].x, nodes[b].y) - 3.5));
    for (const n of nodes) {
      rgb = mix(rgb, n.c, cover(Math.hypot(px - n.x, py - n.y) - n.r));
      rgb = mix(rgb, bg, 0.9 * cover(Math.hypot(px - n.x, py - n.y) - n.r * 0.38)); // a hole makes each node read as a "ring"
    }
    const alpha = cover(rrDist(px, py, 124, 44));
    const o = y * (N * 4 + 1) + 1 + x * 4;
    raw[o] = Math.round(rgb[0]); raw[o + 1] = Math.round(rgb[1]); raw[o + 2] = Math.round(rgb[2]); raw[o + 3] = Math.round(alpha * 255);
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'latin1');
  const tail = Buffer.alloc(4); tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
};
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../icon.png');
fs.writeFileSync(out, png);
console.log(`Wrote ${path.relative(process.cwd(), out)} (${png.length} bytes)`);
