/**
 * Filament spool graphic.
 *
 * Front-on view: a fixed gray rim and hub, with the wound filament drawn as an
 * annulus in the spool's own color. The wound outer radius tracks how much is
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

/**
 * Extra artwork layered over the wound filament, keyed by finish.
 *
 * Each returns SVG that's drawn inside the winding mask, so effects never spill
 * onto the flange or the hub. `defs` is for anything that has to live in <defs>.
 */
const EFFECTS = {
  silk: ({ id }) => ({
    defs: `<linearGradient id="${id}sk" x1="0" y1="0" x2="1" y2="1">
             <stop offset="0%"   stop-color="#fff" stop-opacity="0"/>
             <stop offset="42%"  stop-color="#fff" stop-opacity=".55"/>
             <stop offset="58%"  stop-color="#fff" stop-opacity=".55"/>
             <stop offset="100%" stop-color="#fff" stop-opacity="0"/>
           </linearGradient>`,
    body: `<circle cx="100" cy="100" r="90" fill="url(#${id}sk)"/>`,
  }),

  metallic: ({ id }) => ({
    defs: `<linearGradient id="${id}mt" x1="0" y1="0" x2="1" y2="0.6">
             <stop offset="0%"   stop-color="#fff" stop-opacity=".05"/>
             <stop offset="30%"  stop-color="#fff" stop-opacity=".5"/>
             <stop offset="45%"  stop-color="#000" stop-opacity=".25"/>
             <stop offset="65%"  stop-color="#fff" stop-opacity=".42"/>
             <stop offset="100%" stop-color="#000" stop-opacity=".2"/>
           </linearGradient>`,
    body: `<circle cx="100" cy="100" r="90" fill="url(#${id}mt)"/>`,
  }),

  matte: () => ({
    // Flattens the gloss instead of adding to it.
    body: `<circle cx="100" cy="100" r="90" fill="#000" opacity=".07"/>`,
  }),

  translucent: ({ id }) => ({
    defs: `<radialGradient id="${id}tl" cx="50%" cy="50%" r="50%">
             <stop offset="0%"   stop-color="#fff" stop-opacity=".55"/>
             <stop offset="70%"  stop-color="#fff" stop-opacity=".12"/>
             <stop offset="100%" stop-color="#fff" stop-opacity="0"/>
           </radialGradient>`,
    body: `<circle cx="100" cy="100" r="90" fill="url(#${id}tl)"/>`,
  }),

  wood: ({ deep, light }) => ({
    // Irregular broken rings read as grain without needing a bitmap texture.
    // Pale wood tones need dark grain; dark ones need light.
    body: [39, 46, 53, 60, 67, 74, 81].map((r, i) => `
      <circle cx="100" cy="100" r="${r}" fill="none"
              stroke="${light > 0.55 ? deep : '#e8d6b8'}"
              stroke-width="${1.8 + (i % 3) * 0.9}" opacity=".7"
              stroke-dasharray="${16 + i * 11} ${6 + i * 4}"
              transform="rotate(${i * 41} 100 100)"/>`).join(''),
  }),

  carbon: ({ id }) => ({
    defs: `<pattern id="${id}cf" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(35)">
             <rect width="7" height="7" fill="none"/>
             <rect width="3.5" height="3.5" fill="#000" opacity=".38"/>
             <rect x="3.5" y="3.5" width="3.5" height="3.5" fill="#000" opacity=".38"/>
           </pattern>`,
    body: `<circle cx="100" cy="100" r="90" fill="url(#${id}cf)"/>`,
  }),

  marble: ({ id, light }) => ({
    defs: `<filter id="${id}mb"><feTurbulence type="fractalNoise" baseFrequency="0.022" numOctaves="3" seed="7"/>
             <feDisplacementMap in="SourceGraphic" scale="26"/></filter>`,
    body: `<g filter="url(#${id}mb)" opacity=".5">
             ${[44, 58, 72, 84].map((r, i) => `
               <circle cx="100" cy="100" r="${r}" fill="none"
                       stroke="${light > 0.6 ? '#000' : '#fff'}"
                       stroke-width="${5 - i * 0.6}" opacity=".55"/>`).join('')}
           </g>`,
  }),

  gradient: ({ id, color }) => ({
    // A real colour shift across the spool, not just a tint at the edges.
    defs: `<linearGradient id="${id}gr" x1="0" y1="0" x2="1" y2="1">
             <stop offset="0%"   stop-color="${shade(color, 0.6)}"  stop-opacity=".95"/>
             <stop offset="35%"  stop-color="${shade(color, 0.2)}"  stop-opacity=".5"/>
             <stop offset="65%"  stop-color="${shade(color, -0.25)}" stop-opacity=".5"/>
             <stop offset="100%" stop-color="${shade(color, -0.55)}" stop-opacity=".95"/>
           </linearGradient>`,
    body: `<circle cx="100" cy="100" r="90" fill="url(#${id}gr)"/>`,
  }),

  dual: ({ color }) => ({
    // Half the winding in a contrasting tone, split down the middle.
    body: `<path d="M100 6 A94 94 0 0 1 100 194 Z" fill="${shade(color, -0.45)}" opacity=".92"/>`,
  }),

  glow: ({ id }) => ({
    defs: `<radialGradient id="${id}gw" cx="50%" cy="50%" r="50%">
             <stop offset="55%"  stop-color="#d9ff9e" stop-opacity="0"/>
             <stop offset="100%" stop-color="#d9ff9e" stop-opacity=".75"/>
           </radialGradient>`,
    body: `<circle cx="100" cy="100" r="90" fill="url(#${id}gw)"/>`,
  }),

  glitter: ({ id }) => ({
    // Positions are fixed rather than random so a spool doesn't reshuffle its
    // sparkles on every re-render.
    body: SPARKLES.map(([x, y, r, delay]) => `
      <circle class="sparkle" cx="${x}" cy="${y}" r="${r}" fill="#fff"
              style="animation-delay:${delay}s"/>`).join('')
      + `<circle cx="100" cy="100" r="90" fill="#fff" opacity=".06"/>`,
  }),
};

const SPARKLES = [
  [72, 62, 2.4, 0], [128, 74, 1.8, 0.7], [60, 118, 2.1, 1.4], [138, 126, 2.6, 0.35],
  [100, 48, 1.9, 1.05], [86, 148, 2.2, 1.75], [124, 152, 1.7, 0.9], [48, 88, 2.3, 1.55],
  [152, 100, 2.0, 0.5], [100, 158, 1.8, 1.2],
];

/**
 * Rainbow and other multi-color filaments can't be described by one hex, so
 * they get their own winding fill rather than a flat color.
 */
export function isRainbow(colorName) {
  return /\b(rainbow|multi[\s-]?colou?r|unicorn)\b/i.test(String(colorName ?? ''));
}

/** Hue sweep from the hub outward — the way real rainbow filament unwinds. */
export const RAINBOW_STOPS = [
  [0.00, '#e53935'], [0.16, '#fb8c00'], [0.32, '#fdd835'], [0.48, '#43a047'],
  [0.64, '#1e88e5'], [0.80, '#5e35b1'], [1.00, '#e53935'],
];

export const RAINBOW_CSS =
  `linear-gradient(135deg, ${RAINBOW_STOPS.map(([o, c]) => `${c} ${Math.round(o * 100)}%`).join(', ')})`;

/** Effect keyword for a finish name, or '' when it's a plain spool. */
export function effectFor(finish) {
  const key = String(finish || '').trim().toLowerCase();
  if (!key) return '';
  if (key.includes('silk')) return 'silk';
  if (key.includes('matte')) return 'matte';
  if (key.includes('glitter') || key.includes('sparkle')) return 'glitter';
  if (key.includes('translucent') || key.includes('transparent') || key.includes('clear')) return 'translucent';
  if (key.includes('marble')) return 'marble';
  if (key.includes('wood')) return 'wood';
  if (key.includes('glow')) return 'glow';
  if (key.includes('carbon') || key.includes('cf')) return 'carbon';
  if (key.includes('metal')) return 'metallic';
  if (key.includes('gradient') || key.includes('rainbow')) return 'gradient';
  if (key.includes('dual') || key.includes('two')) return 'dual';
  return '';
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

  const rainbow = isRainbow(filament.color_name);
  const light = rainbow ? 0.5 : luminance(color);
  // Pale spools need a visible edge; dark ones need a lifted highlight instead.
  const edge = rainbow ? 'rgba(0,0,0,.35)' : (light > 0.72 ? shade(color, -0.28) : shade(color, 0.3));
  const deep = rainbow ? 'rgba(0,0,0,.55)' : shade(color, -0.4);
  // Multi-color stock is painted by a hue sweep rather than the single hex.
  const woundFill = rainbow ? `${id}rb` : `${id}f`;

  // Concentric winding lines, denser toward the hub like real windings.
  let windings = '';
  if (hasFilament) {
    for (let r = HUB + 3.5; r < wound - 1.5; r += 4.6) {
      windings += `<circle cx="100" cy="100" r="${r.toFixed(1)}" fill="none" stroke="${deep}" stroke-width="1" opacity=".28"/>`;
    }
  }

  const effectKey = hasFilament ? effectFor(filament.finish) : '';
  const effect = EFFECTS[effectKey]?.({ id, color, deep, light }) ?? {};

  const label = title
    ? `<title>${escapeXML([filament.brand, filament.material, filament.color_name, filament.finish]
        .filter(Boolean).join(' ') || 'Filament spool')}</title>`
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
    ${rainbow ? `
    <radialGradient id="${id}rb" cx="50%" cy="50%" r="50%">
      ${RAINBOW_STOPS.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join('')}
    </radialGradient>` : ''}
    <mask id="${id}m">
      <rect width="200" height="200" fill="#000"/>
      <circle cx="100" cy="100" r="${wound.toFixed(1)}" fill="#fff"/>
      <circle cx="100" cy="100" r="${HUB}" fill="#000"/>
    </mask>
    ${effect.defs ?? ''}
  </defs>

  <!-- flange rim -->
  <circle cx="100" cy="100" r="${RIM}" fill="none" stroke="url(#${id}r)" stroke-width="9"/>
  <circle cx="100" cy="100" r="${RIM - 4.5}" fill="none" stroke="rgba(0,0,0,.30)" stroke-width="1"/>

  <!-- empty space behind the winding -->
  <circle cx="100" cy="100" r="${RIM - 9}" fill="var(--spool-void, rgba(0,0,0,.30))"/>

  ${hasFilament ? `
  <!-- wound filament -->
  <g mask="url(#${id}m)">
    <circle cx="100" cy="100" r="${wound.toFixed(1)}" fill="url(#${woundFill})"/>
    ${windings}
    ${effect.body ?? ''}
    <circle cx="100" cy="100" r="${wound.toFixed(1)}" fill="url(#${id}g)"/>
  </g>
  <circle cx="100" cy="100" r="${wound.toFixed(1)}" fill="none" stroke="${edge}" stroke-width="1.5" opacity=".85"/>
  ` : ''}

  <!-- hub + center bore -->
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
