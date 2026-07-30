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
          // Premultiply so transparent edges don't drag colour toward black.
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

/** Average colour of the four corners — the artwork's background. */
function cornerColor(img) {
  const at = (x, y) => {
    const i = (img.width * y + x) << 2;
    return [img.data[i], img.data[i + 1], img.data[i + 2]];
  };
  const pts = [at(4, 4), at(img.width - 5, 4), at(4, img.height - 5), at(img.width - 5, img.height - 5)];
  return [0, 1, 2].map((c) => Math.round(pts.reduce((s, p) => s + p[c], 0) / pts.length));
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
  const bg = cornerColor(src);
  console.log(`${file} → ${src.width}×${src.height}, background rgb(${bg.join(',')})`);

  for (const size of [192, 512]) write(`icon-${key}-${size}.png`, flatten(resize(src, size), bg));
  write(`icon-${key}-180.png`, flatten(resize(src, 180), bg));       // apple-touch-icon
  write(`icon-maskable-${key}-512.png`, padForMaskable(src, 512, bg));
}

// The dark-background artwork is the default: it's what iOS pins to the home
// screen, which has no light/dark icon switching.
const dark = PNG.sync.read(readFileSync(join(SRC_DIR, 'icon-dark.png')));
const darkBg = cornerColor(dark);
console.log('\ndefault (home screen) icons from icon-dark.png:');
for (const size of [192, 512]) write(`icon-${size}.png`, flatten(resize(dark, size), darkBg));
write('icon-180.png', flatten(resize(dark, 180), darkBg));
write('icon-maskable-512.png', padForMaskable(dark, 512, darkBg));

console.log('\nDone.');
