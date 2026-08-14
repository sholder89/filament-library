/**
 * Builds every PWA icon size from two source images.
 *
 * Put your artwork in tools/icon-src/ as:
 *   icon-dark.png    — the one to show on dark backgrounds
 *   icon-light.png   — the one to show on light backgrounds
 *
 * Square, ideally 1024×1024. Anything square works; this resamples.
 *
 *   node tools/build-icons.mjs
 *
 * pngjs is a devDependency, so this runs on your machine, not in the container —
 * the generated PNGs are committed.
 */

import { PNG } from 'pngjs';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = join(ROOT, 'tools', 'icon-src');
const OUT_DIR = join(ROOT, 'public', 'icons');

/**
 * Box-filter downscale. Averaging every source pixel that falls inside a
 * destination pixel avoids the aliasing you get from nearest-neighbour, which
 * is very visible on the fine highlights in this artwork.
 */
function resize(src, size) {
  const out = new PNG({ width: size, height: size });
  const xRatio = src.width / size;
  const yRatio = src.height / size;

  for (let y = 0; y < size; y++) {
    const y0 = Math.floor(y * yRatio);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * yRatio));
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor(x * xRatio);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * xRatio));

      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = y0; sy < y1 && sy < src.height; sy++) {
        for (let sx = x0; sx < x1 && sx < src.width; sx++) {
          const i = (src.width * sy + sx) << 2;
          const alpha = src.data[i + 3] / 255;
          // Premultiply so transparent edges don't drag color toward black.
          r += src.data[i] * alpha;
          g += src.data[i + 1] * alpha;
          b += src.data[i + 2] * alpha;
          a += src.data[i + 3];
          n++;
        }
      }

      const j = (size * y + x) << 2;
      const meanAlpha = a / n / 255;
      out.data[j]     = meanAlpha ? Math.round(r / n / meanAlpha) : 0;
      out.data[j + 1] = meanAlpha ? Math.round(g / n / meanAlpha) : 0;
      out.data[j + 2] = meanAlpha ? Math.round(b / n / meanAlpha) : 0;
      out.data[j + 3] = Math.round(a / n);
    }
  }
  return out;
}

/** Paints the image onto an opaque canvas — maskable icons can't be transparent. */
function flatten(img, background) {
  const out = new PNG({ width: img.width, height: img.height });
  for (let i = 0; i < img.data.length; i += 4) {
    const alpha = img.data[i + 3] / 255;
    out.data[i]     = Math.round(img.data[i] * alpha + background[0] * (1 - alpha));
    out.data[i + 1] = Math.round(img.data[i + 1] * alpha + background[1] * (1 - alpha));
    out.data[i + 2] = Math.round(img.data[i + 2] * alpha + background[2] * (1 - alpha));
    out.data[i + 3] = 255;
  }
  return out;
}

/**
 * Maskable icons get cropped to a circle by some launchers, so the artwork has
 * to sit inside the middle 80%. These sources already fill their square, so we
 * shrink them onto a padded canvas rather than letting the corners be cut off.
 */
function padForMaskable(img, size, background) {
  const inner = Math.round(size * 0.78);
  const small = resize(img, inner);
  const out = new PNG({ width: size, height: size });
  const offset = Math.round((size - inner) / 2);

  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = background[0];
    out.data[i + 1] = background[1];
    out.data[i + 2] = background[2];
    out.data[i + 3] = 255;
  }
  for (let y = 0; y < inner; y++) {
    for (let x = 0; x < inner; x++) {
      const s = (inner * y + x) << 2;
      const d = (size * (y + offset) + (x + offset)) << 2;
      const alpha = small.data[s + 3] / 255;
      out.data[d]     = Math.round(small.data[s] * alpha + background[0] * (1 - alpha));
      out.data[d + 1] = Math.round(small.data[s + 1] * alpha + background[1] * (1 - alpha));
      out.data[d + 2] = Math.round(small.data[s + 2] * alpha + background[2] * (1 - alpha));
      out.data[d + 3] = 255;
    }
  }
  return out;
}

/**
 * The artwork's background color.
 *
 * Sampled at the midpoint of each edge rather than at the corners: this icon
 * style has rounded corners with transparent pixels outside them, so corner
 * samples read as fully transparent black and every flattened icon came out
 * with black corners instead of the artwork's own color.
 */
/**
 * A color taken from inside the artwork, for the icons that must be opaque.
 *
 * Works inward from the edge until it finds solid pixels: this artwork is a
 * rounded shape on full transparency, so anything sampled near the border is
 * empty. Getting that wrong is what put white corners on every icon.
 */
function backgroundColor(img) {
  const at = (x, y) => {
    const i = (img.width * Math.round(y) + Math.round(x)) << 2;
    return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
  };
  const midX = img.width / 2;
  const midY = img.height / 2;

  for (const inset of [0.12, 0.2, 0.28, 0.36]) {
    const dx = img.width * inset;
    const dy = img.height * inset;
    const samples = [
      at(midX, dy), at(midX, img.height - 1 - dy), at(dx, midY), at(img.width - 1 - dx, midY),
    ].filter((p) => p[3] > 240);
    if (samples.length >= 2) {
      return [0, 1, 2].map((c) => Math.round(samples.reduce((s, p) => s + p[c], 0) / samples.length));
    }
  }

  // Nothing solid anywhere near the edges — average whatever is opaque.
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 3] < 240) continue;
    r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; n++;
  }
  return n ? [r / n, g / n, b / n].map(Math.round) : [13, 15, 19];
}

const write = (name, png) => {
  writeFileSync(join(OUT_DIR, name), PNG.sync.write(png));
  console.log(`  icons/${name}  ${png.width}×${png.height}`);
};

// ── Build ────────────────────────────────────────────────────────────────────

mkdirSync(OUT_DIR, { recursive: true });

const variants = [
  { key: 'dark',  file: 'icon-dark.png' },
  { key: 'light', file: 'icon-light.png' },
];

const missing = variants.filter((v) => !existsSync(join(SRC_DIR, v.file)));
if (missing.length) {
  console.error(`Missing source artwork in tools/icon-src/:\n${missing.map((v) => '  ' + v.file).join('\n')}`);
  console.error('\nDrop square PNGs there (1024×1024 ideal) and run this again.');
  process.exit(1);
}

for (const { key, file } of variants) {
  const src = PNG.sync.read(readFileSync(join(SRC_DIR, file)));
  const bg = backgroundColor(src);
  console.log(`${file} → ${src.width}×${src.height}, background rgb(${bg.join(',')})`);

  /*
   * Transparency is kept where it helps and dropped only where the platform
   * can't cope with it:
   *
   *   favicon / manifest  transparent, so the rounded artwork sits on the tab
   *                       or launcher background instead of in a white box
   *   apple-touch-icon    opaque — iOS composites alpha against black, which on
   *                       this artwork reads as a blacked-out or missing icon
   *   maskable            opaque and padded, since launchers crop it to a circle
   */
  for (const size of [192, 512]) write(`icon-${key}-${size}.png`, resize(src, size));
  write(`icon-${key}-180.png`, flatten(resize(src, 180), bg));
  write(`icon-maskable-${key}-512.png`, padForMaskable(src, 512, bg));
}

// The dark-background artwork is the default: it's what iOS pins to the home
// screen, which has no light/dark icon switching.
const dark = PNG.sync.read(readFileSync(join(SRC_DIR, 'icon-dark.png')));
const darkBg = backgroundColor(dark);
console.log(`\ndefault icons from icon-dark.png, opaque fill rgb(${darkBg.join(',')}):`);
for (const size of [192, 512]) write(`icon-${size}.png`, resize(dark, size));

// iOS picks the closest match by size and won't scale one up gracefully, so
// give it every size it actually asks for — all opaque.
for (const size of [120, 152, 167, 180]) {
  write(`apple-touch-icon-${size}.png`, flatten(resize(dark, size), darkBg));
}
write('icon-180.png', flatten(resize(dark, 180), darkBg));
write('icon-maskable-512.png', padForMaskable(dark, 512, backgroundColor(dark, 0.22)));

console.log('\nDone.');
