/**
 * A rough preview of the sticker that will come out of the printer.
 *
 * Deliberately a re-implementation rather than a call to the label printer's own
 * /preview endpoint: that lives on the Windows client, which isn't in the path
 * at all when printing through the relay. So this mirrors the geometry from
 * printer.py's _render_qr_code instead — same 4% padding, the same
 * w > h * 1.5 landscape test, QR at 45% width on landscape, and a 22% caption
 * band on portrait.
 *
 * Text sizing is approximated, not measured. The real renderer grows the font
 * until it fills the space; here we estimate from character count, which is
 * close enough to judge whether a name will fit.
 */

import { escapeXML as esc } from './spool.js';

export function parseSize(size) {
  const m = /^([\d.]+)x([\d.]+)$/.exec(String(size || '2x1'));
  const w = m ? parseFloat(m[1]) : 2;
  const h = m ? parseFloat(m[2]) : 1;
  return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? [w, h] : [2, 1];
}

/** Caption the server will send: brand on top, type and color beneath. */
export function captionLines(f) {
  const detail = [f.material, f.color_name].filter(Boolean).join(' - ');
  return [f.brand, detail].filter(Boolean);
}

export function labelPreviewHTML(filament, { size = '2x1', showText = true, qrSrc = '' } = {}) {
  const [w, h] = parseSize(size);
  const landscape = w > h * 1.5;
  const pad = 0.04 * Math.min(w, h);

  // Everything is expressed in cqw — 1% of the preview's width. Because the box
  // has a fixed aspect ratio, that works as a unit on both axes.
  const u = (inches) => `${(inches / w * 100).toFixed(3)}cqw`;

  const lines = showText ? captionLines(filament) : [];
  let qr, textBox = null;

  if (!showText) {
    const qrIn = Math.min(w - pad * 2, h - pad * 2);
    qr = { size: qrIn, left: (w - qrIn) / 2, top: (h - qrIn) / 2 };
  } else if (landscape) {
    const qrIn = Math.min(h - pad * 2, w * 0.45);
    qr = { size: qrIn, left: pad, top: (h - qrIn) / 2 };
    const x = pad + qrIn + pad;
    textBox = { left: x, top: pad, width: w - x - pad, height: h - pad * 2, align: 'left', center: true };
  } else {
    const captionH = Math.max(h * 0.22, 0.18);
    const qrIn = Math.min(w - pad * 2, h - captionH - pad * 2);
    qr = { size: qrIn, left: (w - qrIn) / 2, top: pad };
    textBox = {
      left: pad, top: pad + qrIn + pad / 2, width: w - pad * 2,
      height: captionH - pad, align: 'center', center: false,
    };
  }

  let textHTML = '';
  if (textBox && lines.length) {
    // Estimate a size that fits: bounded by the width the longest line needs
    // and by the height available per line.
    const longest = Math.max(...lines.map((l) => l.length), 1);
    const byWidth = textBox.width / (longest * 0.52);
    const byHeight = (textBox.height / lines.length) * 0.72;
    const fontIn = Math.max(0.05, Math.min(byWidth, byHeight));

    const rows = lines
      .map((line, i) => `<span class="lp-line${i === 0 ? ' lp-brand' : ''}">${esc(line)}</span>`)
      .join('');

    textHTML = `
      <div class="lp-text" style="
        left:${u(textBox.left)};top:${u(textBox.top)};
        width:${u(textBox.width)};height:${u(textBox.height)};
        font-size:${u(fontIn)};text-align:${textBox.align};
        justify-content:${textBox.center ? 'center' : 'flex-start'};
        align-items:${textBox.align === 'center' ? 'center' : 'flex-start'};
      ">${rows}</div>`;
  }

  return `
    <div class="label-preview" style="aspect-ratio:${w} / ${h}" role="img"
         aria-label="Preview of the ${esc(size)} inch label for ${esc(captionLines(filament).join(', ') || 'this spool')}">
      <img class="lp-qr" src="${esc(qrSrc)}" alt=""
           style="left:${u(qr.left)};top:${u(qr.top)};width:${u(qr.size)};height:${u(qr.size)}">
      ${textHTML}
    </div>`;
}
