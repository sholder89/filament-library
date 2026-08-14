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
 * CIE Lab, for asking how far apart two colours look.
 *
 * Distance in plain RGB is nearly useless for that — the channels are a
 * storage format, not a description of vision, and it will happily rank two
 * greens further apart than a green and a grey. Lab is built so that equal
 * steps in it are roughly equal steps to the eye, which is exactly the question
 * being asked of it here.
 */
export function lab(hex) {
  const { r, g, b } = toRgb(hex);

  // sRGB is gamma-encoded; undo that before any of the maths means anything.
  const linear = (v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [R, G, B] = [linear(r), linear(g), linear(b)];

  // Into XYZ, then relative to D65 white.
  const x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const y = (R * 0.2126 + G * 0.7152 + B * 0.0722);
  const z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;

  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : (7.787 * t) + 16 / 116);
  const [fx, fy, fz] = [f(x), f(y), f(z)];

  return { L: (116 * fy) - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

/** How different two colours look. Under about 2.3, most people can't tell. */
export function colorDistance(hexA, hexB) {
  const p = lab(hexA);
  const q = lab(hexB);
  return Math.hypot(p.L - q.L, p.a - q.a, p.b - q.b);
}

/**
 * Hue in degrees, plus how colourful and how light it is.
 *
 * Hue is what a rainbow is ordered by; the other two are what says a colour
 * doesn't belong in one. Black, white and grey have a hue — whichever rounding
 * error they landed on — and sorting them into the reds because of it would be
 * worse than admitting they aren't part of the spectrum.
 */
export function hsl(hex) {
  const { r, g, b } = toRgb(hex);
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const span = max - min;
  const l = (max + min) / 2;

  let h = 0;
  if (span) {
    if (max === R) h = ((G - B) / span + (G < B ? 6 : 0)) * 60;
    else if (max === G) h = ((B - R) / span + 2) * 60;
    else h = ((R - G) / span + 4) * 60;
  }

  const s = span === 0 ? 0 : span / (1 - Math.abs(2 * l - 1));
  return { h, s, l };
}

/**
 * Extra artwork for a finish, layered around the wound filament.
 *
 * Each effect may return any of:
 *
 *   defs         markup for <defs>
 *   under        inside the winding mask, beneath the colour fill
 *   body         inside the winding mask, above the winding lines
 *   outer        outside the mask entirely — for glows that spill past the rim
 *   fillOpacity  opacity of the colour fill itself, so a finish can be see-through
 *
 * Everything except `outer` is clipped to the winding, so effects never bleed
 * onto the flange or the hub.
 */

/**
 * Sparkle positions on a golden-angle spiral.
 *
 * Even coverage without a random number generator, which matters because the
 * graphic re-renders constantly — random points would make a spool shimmer
 * differently every time the grid repainted.
 */
function sparkles(count, inner, outer) {
  const GOLDEN = 2.399963229728653;
  const out = [];
  for (let i = 0; i < count; i++) {
    const r = inner + (outer - inner) * Math.sqrt((i + 0.5) / count);
    const a = i * GOLDEN;
    out.push({
      x: (100 + r * Math.cos(a)).toFixed(1),
      y: (100 + r * Math.sin(a)).toFixed(1),
      size: (0.9 + (i % 4) * 0.55).toFixed(2),
      delay: ((i * 0.29) % 2.6).toFixed(2),
    });
  }
  return out;
}

const EFFECTS = {
  /*
   * Silk is the one finish people buy for how it looks, so it gets three
   * layers rather than one wash of white: a broad diagonal gloss, a dark band
   * on its far side to give the bright side something to be brighter than, and
   * a narrow specular streak that slides with the page and the phone.
   *
   * The streak is positioned from --sheen, a single number on the root element
   * that everything on screen shares — see the sheen block in app.js.
   */
  silk: ({ id }) => ({
    defs: `
      <linearGradient id="${id}sk" x1="0" y1="0" x2=".85" y2="1">
        <stop offset="0%"   stop-color="#fff" stop-opacity="0"/>
        <stop offset="24%"  stop-color="#fff" stop-opacity=".26"/>
        <stop offset="43%"  stop-color="#fff" stop-opacity=".88"/>
        <stop offset="53%"  stop-color="#fff" stop-opacity=".72"/>
        <stop offset="70%"  stop-color="#fff" stop-opacity=".14"/>
        <stop offset="86%"  stop-color="#000" stop-opacity=".22"/>
        <stop offset="100%" stop-color="#000" stop-opacity=".05"/>
      </linearGradient>
      <linearGradient id="${id}skm" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%"   stop-color="#fff" stop-opacity="0"/>
        <stop offset="38%"  stop-color="#fff" stop-opacity=".55"/>
        <stop offset="50%"  stop-color="#fff" stop-opacity=".95"/>
        <stop offset="62%"  stop-color="#fff" stop-opacity=".55"/>
        <stop offset="100%" stop-color="#fff" stop-opacity="0"/>
      </linearGradient>`,
    body: `
      <circle cx="100" cy="100" r="90" fill="url(#${id}sk)"/>
      <g class="silk-tilt">
        <g class="silk-sheen">
          <rect x="62" y="-48" width="46" height="296" fill="url(#${id}skm)"
                transform="rotate(15 100 100)"/>
        </g>
      </g>`,
  }),

  /** Brushed banding plus a highlight that sweeps across, so it reads as metal. */
  metallic: ({ id }) => ({
    defs: `
      <linearGradient id="${id}mt" x1="0" y1="0" x2="1" y2="0.6">
        <stop offset="0%"   stop-color="#fff" stop-opacity=".05"/>
        <stop offset="26%"  stop-color="#fff" stop-opacity=".55"/>
        <stop offset="42%"  stop-color="#000" stop-opacity=".28"/>
        <stop offset="60%"  stop-color="#fff" stop-opacity=".45"/>
        <stop offset="78%"  stop-color="#000" stop-opacity=".22"/>
        <stop offset="100%" stop-color="#fff" stop-opacity=".35"/>
      </linearGradient>
      <linearGradient id="${id}sh" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%"   stop-color="#fff" stop-opacity="0"/>
        <stop offset="45%"  stop-color="#fff" stop-opacity=".75"/>
        <stop offset="55%"  stop-color="#fff" stop-opacity=".75"/>
        <stop offset="100%" stop-color="#fff" stop-opacity="0"/>
      </linearGradient>`,
    body: `
      <circle cx="100" cy="100" r="90" fill="url(#${id}mt)"/>
      <g class="sheen"><rect x="-70" y="-40" width="52" height="280"
         fill="url(#${id}sh)" transform="rotate(18 100 100)"/></g>`,
  }),

  matte: () => ({
    // Flattens the gloss instead of adding to it.
    body: `<circle cx="100" cy="100" r="90" fill="#000" opacity=".07"/>`,
  }),

  /**
   * Translucency is the hard one to signal, because "slightly see-through" reads
   * as "slightly wrong colour" at card size. So it's shown the way image editors
   * show transparency: a checker grid behind the filament, visible through it,
   * plus a glass highlight over the top. Unmistakable at a glance.
   */
  translucent: ({ id }) => ({
    defs: `
      <pattern id="${id}ck" width="12" height="12" patternUnits="userSpaceOnUse">
        <rect width="12" height="12" fill="#ffffff"/>
        <rect width="6" height="6" fill="#c3ccd9"/>
        <rect x="6" y="6" width="6" height="6" fill="#c3ccd9"/>
      </pattern>
      <linearGradient id="${id}gl" x1="0.1" y1="0" x2="0.7" y2="1">
        <stop offset="0%"   stop-color="#fff" stop-opacity=".85"/>
        <stop offset="34%"  stop-color="#fff" stop-opacity=".12"/>
        <stop offset="70%"  stop-color="#fff" stop-opacity="0"/>
        <stop offset="100%" stop-color="#fff" stop-opacity=".35"/>
      </linearGradient>`,
    under: `<circle cx="100" cy="100" r="90" fill="url(#${id}ck)"/>`,
    fillOpacity: 0.52,
    body: `
      <circle cx="100" cy="100" r="90" fill="url(#${id}gl)"/>
      <path d="M62 46a72 72 0 0 0-16 34" fill="none" stroke="#fff"
            stroke-opacity=".75" stroke-width="7" stroke-linecap="round"/>`,
  }),

  wood: ({ deep, light }) => ({
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

  /** Blends every colour on the spool across the winding. */
  gradient: ({ id, colors, color }) => {
    const stops = (colors.length > 1 ? colors : [shade(color, 0.55), color, shade(color, -0.5)]);
    return {
      defs: `<linearGradient id="${id}gr" x1="0" y1="0" x2="1" y2="1">
               ${stops.map((c, i) => `<stop offset="${(i / (stops.length - 1)).toFixed(3)}" stop-color="${c}"/>`).join('')}
             </linearGradient>`,
      body: `<circle cx="100" cy="100" r="90" fill="url(#${id}gr)" opacity="${colors.length > 1 ? 1 : 0.9}"/>`,
    };
  },

  /** Hard split into wedges, one per colour. */
  dual: ({ colors, color }) => {
    const tones = colors.length > 1 ? colors : [color, shade(color, -0.45)];
    const step = 360 / tones.length;
    return {
      body: tones.slice(1).map((c, i) => {
        const from = -90 + step * (i + 1);
        const to = from + step;
        const rad = (d) => (d * Math.PI) / 180;
        const x1 = 100 + 95 * Math.cos(rad(from));
        const y1 = 100 + 95 * Math.sin(rad(from));
        const x2 = 100 + 95 * Math.cos(rad(to));
        const y2 = 100 + 95 * Math.sin(rad(to));
        const large = step > 180 ? 1 : 0;
        return `<path d="M100 100 L${x1.toFixed(1)} ${y1.toFixed(1)} A95 95 0 ${large} 1 ${x2.toFixed(1)} ${y2.toFixed(1)} Z" fill="${c}"/>`;
      }).join(''),
    };
  },

  /** A halo that spills past the rim and breathes, the way it looks in the dark. */
  glow: ({ id }) => ({
    defs: `
      <radialGradient id="${id}gh" cx="50%" cy="50%" r="50%">
        <stop offset="0%"   stop-color="#c6ff7a" stop-opacity=".9"/>
        <stop offset="80%"  stop-color="#b4fa63" stop-opacity=".85"/>
        <stop offset="88%"  stop-color="#a8f55c" stop-opacity=".5"/>
        <stop offset="100%" stop-color="#8de23c" stop-opacity="0"/>
      </radialGradient>
      <radialGradient id="${id}gi" cx="50%" cy="50%" r="50%">
        <stop offset="50%"  stop-color="#dcff9e" stop-opacity="0"/>
        <stop offset="100%" stop-color="#dcff9e" stop-opacity=".8"/>
      </radialGradient>`,
    // Sits in the margin the viewBox leaves outside the flange; drawn before
    // the rim so only the part beyond the spool is visible.
    outer: `<circle class="glow-halo" cx="100" cy="100" r="114" fill="url(#${id}gh)"/>`,
    body: `<circle cx="100" cy="100" r="90" fill="url(#${id}gi)"/>`,
  }),

  /** Dense flecks, twinkling out of phase. */
  glitter: ({ id, wound, hub }) => ({
    defs: `<radialGradient id="${id}gs" cx="50%" cy="50%" r="50%">
             <stop offset="0%" stop-color="#fff" stop-opacity="1"/>
             <stop offset="100%" stop-color="#fff" stop-opacity="0"/>
           </radialGradient>`,
    body: `<circle cx="100" cy="100" r="90" fill="#fff" opacity=".07"/>`
      + sparkles(34, hub + 3, wound - 2).map((s) => `
        <circle class="sparkle" cx="${s.x}" cy="${s.y}" r="${s.size}"
                fill="#fff" style="animation-delay:${s.delay}s"/>`).join(''),
  }),
};

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
/*
 * A spool can have more than one finish, and they aren't all the same kind of
 * thing. A pattern decides where the colour goes; a surface is what sits on top
 * of it. Silk Tricolor Gradient is one of each, and drawing only the first one
 * found — which is what this used to do — threw away half of what was on the
 * label.
 *
 * At most one pattern, since two would fight over the same pixels, and any
 * number of surfaces, which merely stack.
 */
const PATTERNS = ['gradient', 'dual', 'marble', 'wood'];

const MATCHERS = [
  ['gradient',    (k) => k.includes('gradient') || k.includes('rainbow')],
  ['dual',        (k) => k.includes('dual') || k.includes('two')],
  ['marble',      (k) => k.includes('marble')],
  ['wood',        (k) => k.includes('wood')],
  ['silk',        (k) => k.includes('silk')],
  ['matte',       (k) => k.includes('matte')],
  ['glitter',     (k) => k.includes('glitter') || k.includes('sparkle')],
  ['translucent', (k) => k.includes('translucent') || k.includes('transparent') || k.includes('clear')],
  ['glow',        (k) => k.includes('glow')],
  ['carbon',      (k) => k.includes('carbon') || k.includes('cf')],
  ['metallic',    (k) => k.includes('metal')],
];

/** Every effect named in the finish, pattern first so surfaces layer over it. */
export function effectsFor(finish) {
  const key = String(finish || '').trim().toLowerCase();
  if (!key) return [];

  const found = MATCHERS.filter(([, test]) => test(key)).map(([name]) => name);
  const pattern = found.find((n) => PATTERNS.includes(n));
  return [...(pattern ? [pattern] : []), ...found.filter((n) => !PATTERNS.includes(n))];
}

/** The one that defines the look, for anything that can only show a single hint. */
export const effectFor = (finish) => effectsFor(finish)[0] ?? '';

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

  // Every tone on the spool, for the finishes that blend or split colors.
  const colors = [filament.color_hex, filament.color_hex2, filament.color_hex3]
    .filter((c) => /^#[0-9a-fA-F]{6}$/.test(String(c ?? '')));

  // Each layer contributes to the same handful of slots, so they're collected
  // in order and concatenated. fillOpacity is the exception — it's one number,
  // so the last layer that asks for one wins.
  const layers = (hasFilament ? effectsFor(filament.finish) : [])
    .map((key) => EFFECTS[key]?.({ id: `${id}${key}`, color, colors, deep, light, wound, hub: HUB }))
    .filter(Boolean);

  const effect = {
    defs:  layers.map((l) => l.defs ?? '').join(''),
    outer: layers.map((l) => l.outer ?? '').join(''),
    under: layers.map((l) => l.under ?? '').join(''),
    body:  layers.map((l) => l.body ?? '').join(''),
    fillOpacity: layers.reduce((acc, l) => (l.fillOpacity != null ? l.fillOpacity : acc), null),
  };

  const label = title
    ? `<title>${escapeXML([filament.brand, filament.material, filament.color_name, filament.finish]
        .filter(Boolean).join(' ') || 'Filament spool')}</title>`
    : '';

  return `
<svg class="spool-wrap" viewBox="-16 -16 232 232" xmlns="http://www.w3.org/2000/svg" role="img" aria-hidden="${title ? 'false' : 'true'}" style="width:100%;height:auto;display:block">
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

  <!-- glow and anything else that reaches past the rim -->
  ${effect.outer ?? ''}

  <!-- empty space behind the winding -->
  <circle cx="100" cy="100" r="${RIM - 9}" fill="var(--spool-void, rgba(0,0,0,.30))"/>

  ${hasFilament ? `
  <!-- wound filament -->
  <g mask="url(#${id}m)">
    ${effect.under ?? ''}
    <circle cx="100" cy="100" r="${wound.toFixed(1)}" fill="url(#${woundFill})"${
      effect.fillOpacity != null ? ` opacity="${effect.fillOpacity}"` : ''}/>
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
