/**
 * Filament spool graphic.
 *
 * Front-on view: a fixed grey rim and hub, with the wound filament drawn as an
 * annulus in the spool's own colour. The wound outer radius tracks how much is
 * left, so a nearly-empty spool visibly reads as one — the gap between the
 * winding and the rim is the missing filament.
 */

let uid = 0;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function toRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  const n = parseInt(m ? m[1] : '808080', 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

const toHex = ({ r, g, b }) =>
  '#' + [r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');

/** amount > 0 lightens toward white, < 0 darkens toward black. */
function shade(hex, amount) {
  const { r, g, b } = toRgb(hex);
  const t = amount > 0 ? 255 : 0;
  const p = Math.abs(amount);
  return toHex({ r: r + (t - r) * p, g: g + (t - g) * p, b: b + (t - b) * p });
}

/** Perceived brightness 0–1, used to keep pale spools from vanishing. */
export function luminance(hex) {
  const { r, g, b } = toRgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

export function spoolSVG(filament, { title = true } = {}) {
  const color = /^#[0-9a-fA-F]{6}$/.test(filament.color_hex || '') ? filament.color_hex : '#808080';
  const status = filament.status || 'new';
  const pct = status === 'empty' ? 0 : clamp(Number(filament.remaining_pct ?? 100), 0, 100);

  const id = `sp${++uid}`;
  const HUB = 36;          // outer edge of the cardboard/plastic hub
  const MAX = 84;          // a full spool's outer winding radius
  const RIM = 94;          // flange outer edge
  const wound = HUB + (MAX - HUB) * (pct / 100);
  const hasFilament = pct > 0.5;

  const light = luminance(color);
  // Pale spools need a visible edge; dark ones need a lifted highlight instead.
  const edge = light > 0.72 ? shade(color, -0.28) : shade(color, 0.3);
  const deep = shade(color, -0.4);

  // Concentric winding lines, denser toward the hub like real windings.
  let windings = '';
  if (hasFilament) {
    for (let r = HUB + 3.5; r < wound - 1.5; r += 4.6) {
      windings += `<circle cx="100" cy="100" r="${r.toFixed(1)}" fill="none" stroke="${deep}" stroke-width="1" opacity=".28"/>`;
    }
  }

  const label = title
    ? `<title>${escapeXML([filament.brand, filament.material, filament.color_name].filter(Boolean).join(' ') || 'Filament spool')}</title>`
    : '';

  return `
<svg class="spool-wrap" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg" role="img" aria-hidden="${title ? 'false' : 'true'}" style="width:100%;height:auto;display:block">
  ${label}
  <defs>
    <radialGradient id="${id}f" cx="38%" cy="30%" r="78%">
      <stop offset="0%"   stop-color="${shade(color, 0.22)}"/>
      <stop offset="58%"  stop-color="${color}"/>
      <stop offset="100%" stop-color="${shade(color, -0.24)}"/>
    </radialGradient>
    <linearGradient id="${id}r" x1="0" y1="0" x2="0.35" y2="1">
      <stop offset="0%"   stop-color="var(--spool-rim-hi, #6d7684)"/>
      <stop offset="100%" stop-color="var(--spool-rim-lo, #3a4150)"/>
    </linearGradient>
    <radialGradient id="${id}g" cx="34%" cy="24%" r="52%">
      <stop offset="0%"   stop-color="#fff" stop-opacity=".26"/>
      <stop offset="100%" stop-color="#fff" stop-opacity="0"/>
    </radialGradient>
    <mask id="${id}m">
      <rect width="200" height="200" fill="#000"/>
      <circle cx="100" cy="100" r="${wound.toFixed(1)}" fill="#fff"/>
      <circle cx="100" cy="100" r="${HUB}" fill="#000"/>
    </mask>
  </defs>

  <!-- flange rim -->
  <circle cx="100" cy="100" r="${RIM}" fill="none" stroke="url(#${id}r)" stroke-width="9"/>
  <circle cx="100" cy="100" r="${RIM - 4.5}" fill="none" stroke="rgba(0,0,0,.30)" stroke-width="1"/>

  <!-- empty space behind the winding -->
  <circle cx="100" cy="100" r="${RIM - 9}" fill="var(--spool-void, rgba(0,0,0,.30))"/>

  ${hasFilament ? `
  <!-- wound filament -->
  <g mask="url(#${id}m)">
    <circle cx="100" cy="100" r="${wound.toFixed(1)}" fill="url(#${id}f)"/>
    ${windings}
    <circle cx="100" cy="100" r="${wound.toFixed(1)}" fill="url(#${id}g)"/>
  </g>
  <circle cx="100" cy="100" r="${wound.toFixed(1)}" fill="none" stroke="${edge}" stroke-width="1.5" opacity=".85"/>
  ` : ''}

  <!-- hub + centre bore -->
  <circle cx="100" cy="100" r="${HUB}" fill="var(--spool-hub, #454d5c)"/>
  <circle cx="100" cy="100" r="${HUB}" fill="none" stroke="rgba(0,0,0,.35)" stroke-width="1.5"/>
  <circle cx="100" cy="100" r="15" fill="var(--spool-bore, #10141c)"/>
  <circle cx="100" cy="100" r="15" fill="none" stroke="rgba(255,255,255,.10)" stroke-width="1"/>

  <!-- specular sweep across the flange -->
  <path d="M100 12a88 88 0 0 0-62 150l10-10A74 74 0 0 1 100 26Z" fill="#fff" opacity=".07"/>
</svg>`;
}

export function escapeXML(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
