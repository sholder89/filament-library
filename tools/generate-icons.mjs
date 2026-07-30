/**
 * Generates the PWA icons — a filament spool on the app's dark background.
 *
 * Written as a plain PNG encoder (zlib is built into Node) so the project needs
 * no image dependency and the icons can be regenerated with:
 *
 *   node tools/generate-icons.mjs
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
mkdirSync(OUT_DIR, { recursive: true });

// ── Minimal PNG writer ───────────────────────────────────────────────────────

const CRC_TABLE = Int32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** rgba: Uint8Array of size*size*4 */
function encodePNG(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: RGBA
  // 10–12: compression, filter, interlace — all 0

  // One filter byte (0 = None) per scanline.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, rowStart + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── The artwork ──────────────────────────────────────────────────────────────

const rgb = (hex) => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

const BG    = rgb('#0d0f13');
const RIM   = rgb('#6d7684');
const VOID  = rgb('#1a1f28');
const HUB   = rgb('#454d5c');
const BORE  = rgb('#0d0f13');
const COIL  = rgb('#5b8cff');
const COIL_D = rgb('#3a63c9');

const mix = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/** Color of the spool at normalized radius u (1.0 = outer edge of the flange). */
function bandColor(u, angleShade) {
  if (u < 0.20) return BORE;
  if (u < 0.46) return mix(HUB, BORE, 0.25 * angleShade);
  if (u < 0.86) {
    // Concentric winding lines, plus a soft top-left highlight.
    const line = 0.5 + 0.5 * Math.cos((u - 0.46) / 0.40 * Math.PI * 2 * 9);
    const base = mix(COIL, COIL_D, line * 0.45);
    return mix(base, [255, 255, 255], Math.max(0, angleShade) * 0.18);
  }
  if (u < 0.905) return VOID;
  return mix(RIM, BG, (1 - Math.max(0, Math.min(1, angleShade))) * 0.35);
}

function drawIcon(size, { inset = 0.90, background = BG } = {}) {
  const SS = 3;                       // supersampling factor for smooth edges
  const rgba = new Uint8Array(size * size * 4);
  const c = size / 2;
  const R = (size / 2) * inset;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS - c;
          const py = y + (sy + 0.5) / SS - c;
          const u = Math.hypot(px, py) / R;

          let sample;
          if (u > 1) {
            sample = background;
          } else {
            // -1 (bottom-right) .. 1 (top-left): fakes a light source.
            const angleShade = (-px - py) / (Math.SQRT2 * R) * 2;
            sample = bandColor(u, Math.max(-1, Math.min(1, angleShade)));
          }
          r += sample[0]; g += sample[1]; b += sample[2];
        }
      }

      const n = SS * SS;
      const i = (y * size + x) * 4;
      rgba[i]     = Math.round(r / n);
      rgba[i + 1] = Math.round(g / n);
      rgba[i + 2] = Math.round(b / n);
      rgba[i + 3] = 255;
    }
  }

  return encodePNG(size, rgba);
}

const targets = [
  ['icon-192.png',          192, { inset: 0.88 }],
  ['icon-512.png',          512, { inset: 0.88 }],
  ['icon-180.png',          180, { inset: 0.88 }],   // apple-touch-icon
  // Maskable icons get cropped to a circle on some launchers — keep the art
  // inside the 80% safe zone.
  ['icon-maskable-512.png', 512, { inset: 0.66 }],
];

for (const [name, size, opts] of targets) {
  writeFileSync(join(OUT_DIR, name), drawIcon(size, opts));
  console.log(`wrote icons/${name} (${size}×${size})`);
}
