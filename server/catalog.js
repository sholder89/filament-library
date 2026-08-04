/**
 * Pre-filled reference data: brands, material types and common colors.
 *
 * This is seed/reference data only — the UI lets you type anything that isn't
 * in here, and whatever you type is remembered (see /api/catalog, which merges
 * these lists with the distinct values already present in your inventory).
 */

import { GENERATED_BRANDS } from './catalog-generated.js';

/**
 * Brands the generated list doesn't carry. Anything added here should be a real
 * manufacturer that filamentcolors.xyz hasn't catalogued yet.
 */
const EXTRA_BRANDS = [
  'Fiberon',
  'Flashforge',
  'GizmoDorks',
  'Priline',
];

/**
 * Names shown first in the picker. The rest are still there and still
 * type-ahead, but three hundred alphabetised brands with Sunlu somewhere in the
 * middle is not a list anyone wants to scroll on a phone.
 *
 * Brands you already own are promoted above even these — see /api/catalog.
 */
const POPULAR_BRANDS = [
  'Bambu Lab', 'Sunlu', 'Creality', 'Elegoo', 'Overture', 'eSun', 'Polymaker',
  'Prusament', 'Hatchbox', 'Anycubic', 'Inland', '3D-Fuel', 'Siraya Tech',
  'Fiberon', 'Jayo', 'Eryone', 'Duramic 3D', 'Protopasta', 'Fillamentum',
  'ColorFabb', 'MatterHackers', 'Atomic Filament',
];

const byName = (a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' });

/** Case-insensitive dedupe that keeps the first spelling it saw. */
function unique(names) {
  const seen = new Map();
  for (const name of names) {
    const key = name.toLowerCase();
    if (!seen.has(key)) seen.set(key, name);
  }
  return [...seen.values()];
}

const ALL_BRANDS = unique([...GENERATED_BRANDS, ...EXTRA_BRANDS]).sort(byName);
const popular = new Set(POPULAR_BRANDS.map((b) => b.toLowerCase()));

export const BRANDS = [
  ...unique(POPULAR_BRANDS).filter((b) => ALL_BRANDS.some((a) => a.toLowerCase() === b.toLowerCase())),
  ...ALL_BRANDS.filter((b) => !popular.has(b.toLowerCase())),
];

/**
 * Material types. Temps are typical starting points from vendor datasheets —
 * they pre-fill the add form so you don't have to look them up, and stay
 * editable per spool.
 */
export const MATERIALS = [
  { name: 'PLA',        nozzle: 210, bed: 60,  family: 'PLA',   enclosure: false, dry: false },
  { name: 'PLA+',       nozzle: 215, bed: 60,  family: 'PLA',   enclosure: false, dry: false },
  { name: 'PLA Silk',   nozzle: 215, bed: 60,  family: 'PLA',   enclosure: false, dry: false },
  { name: 'PLA Matte',  nozzle: 210, bed: 60,  family: 'PLA',   enclosure: false, dry: false },
  { name: 'PLA-CF',     nozzle: 225, bed: 60,  family: 'PLA',   enclosure: false, dry: true  },
  { name: 'PLA Glow',   nozzle: 215, bed: 60,  family: 'PLA',   enclosure: false, dry: false },
  { name: 'PLA Wood',   nozzle: 205, bed: 60,  family: 'PLA',   enclosure: false, dry: true  },
  { name: 'PLA Metal',  nozzle: 215, bed: 60,  family: 'PLA',   enclosure: false, dry: true  },
  { name: 'PETG',       nozzle: 240, bed: 80,  family: 'PETG',  enclosure: false, dry: true  },
  { name: 'PETG-CF',    nozzle: 250, bed: 80,  family: 'PETG',  enclosure: false, dry: true  },
  { name: 'PCTG',       nozzle: 250, bed: 80,  family: 'PETG',  enclosure: false, dry: true  },
  { name: 'ABS',        nozzle: 250, bed: 100, family: 'ABS',   enclosure: true,  dry: true  },
  { name: 'ASA',        nozzle: 255, bed: 100, family: 'ABS',   enclosure: true,  dry: true  },
  { name: 'TPU 95A',    nozzle: 225, bed: 45,  family: 'TPU',   enclosure: false, dry: true  },
  { name: 'TPU 85A',    nozzle: 225, bed: 45,  family: 'TPU',   enclosure: false, dry: true  },
  { name: 'TPE',        nozzle: 225, bed: 45,  family: 'TPU',   enclosure: false, dry: true  },
  { name: 'Nylon (PA)', nozzle: 260, bed: 80,  family: 'Nylon', enclosure: true,  dry: true  },
  { name: 'PA-CF',      nozzle: 270, bed: 80,  family: 'Nylon', enclosure: true,  dry: true  },
  { name: 'PC',         nozzle: 270, bed: 110, family: 'Other', enclosure: true,  dry: true  },
  { name: 'PC-CF',      nozzle: 280, bed: 110, family: 'Other', enclosure: true,  dry: true  },
  { name: 'PVA',        nozzle: 215, bed: 60,  family: 'Other', enclosure: false, dry: true  },
  { name: 'HIPS',       nozzle: 240, bed: 100, family: 'Other', enclosure: true,  dry: true  },
  { name: 'PP',         nozzle: 250, bed: 90,  family: 'Other', enclosure: true,  dry: true  },
  { name: 'PP-CF',      nozzle: 255, bed: 90,  family: 'Other', enclosure: true,  dry: true  },
  { name: 'PEEK',       nozzle: 400, bed: 130, family: 'Other', enclosure: true,  dry: true  },

  // High-flow grades, sold alongside the standard ones and printed hotter.
  { name: 'PLA HF',     nozzle: 220, bed: 60,  family: 'PLA',   enclosure: false, dry: false },
  { name: 'PETG HF',    nozzle: 245, bed: 80,  family: 'PETG',  enclosure: false, dry: true  },

  // Foaming/lightweight grades. They expand as they print, so the temperature
  // is what sets the density — these are mid-range starting points.
  { name: 'PLA Aero',   nozzle: 230, bed: 60,  family: 'PLA',   enclosure: false, dry: true  },
  { name: 'TPU Air',    nozzle: 235, bed: 45,  family: 'TPU',   enclosure: false, dry: true  },

  { name: 'TPU 98A',    nozzle: 230, bed: 45,  family: 'TPU',   enclosure: false, dry: true  },
  { name: 'ASA-CF',     nozzle: 260, bed: 100, family: 'ABS',   enclosure: true,  dry: true  },
  { name: 'PET',        nozzle: 250, bed: 80,  family: 'PETG',  enclosure: false, dry: true  },
  { name: 'PVB',        nozzle: 215, bed: 70,  family: 'Other', enclosure: false, dry: true  },

  // Engineering grades. All want a hot chamber and a very dry spool.
  { name: 'PA6-CF',     nozzle: 275, bed: 80,  family: 'Nylon', enclosure: true,  dry: true  },
  { name: 'PA12-CF',    nozzle: 265, bed: 80,  family: 'Nylon', enclosure: true,  dry: true  },
  { name: 'PPA-CF',     nozzle: 300, bed: 100, family: 'Other', enclosure: true,  dry: true  },
  { name: 'PPS-CF',     nozzle: 320, bed: 120, family: 'Other', enclosure: true,  dry: true  },
];

/**
 * Special finishes. These are orthogonal to the material — you can have silk
 * PLA or glitter PETG — so they're tracked separately rather than as more
 * entries in MATERIALS.
 *
 * `effect` names the treatment the spool graphic applies; several finishes share
 * one (glow and glitter both sparkle, for instance, but glow also halos).
 */
export const FINISHES = [
  { name: 'Silk',          effect: 'silk',        blurb: 'High-gloss sheen' },
  { name: 'Matte',         effect: 'matte',       blurb: 'Flat, no shine' },
  { name: 'Glitter',       effect: 'glitter',     blurb: 'Sparkle flecks' },
  { name: 'Translucent',   effect: 'translucent', blurb: 'Light passes through' },
  { name: 'Marble',        effect: 'marble',      blurb: 'Swirled two-tone' },
  { name: 'Wood',          effect: 'wood',        blurb: 'Wood-fill grain' },
  { name: 'Glow in the dark', effect: 'glow',     blurb: 'Phosphorescent' },
  { name: 'Carbon fiber',  effect: 'carbon',      blurb: 'CF-reinforced speckle' },
  { name: 'Metallic',      effect: 'metallic',    blurb: 'Metal-flake shimmer' },
  { name: 'Gradient',      effect: 'gradient',    blurb: 'Color shifts along the spool' },
  { name: 'Dual color',    effect: 'dual',        blurb: 'Two-tone co-extrusion' },
];

/** Common spool colors — the picker offers these as swatches, plus a free hex input. */
export const COLORS = [
  { name: 'Black',        hex: '#1A1A1A' },
  { name: 'White',        hex: '#F5F5F5' },
  { name: 'Gray',         hex: '#808080' },
  { name: 'Light Gray',   hex: '#C0C0C0' },
  { name: 'Silver',       hex: '#B8BCC0' },
  { name: 'Red',          hex: '#D32029' },
  { name: 'Dark Red',     hex: '#8B1A1A' },
  { name: 'Orange',       hex: '#F5761A' },
  { name: 'Yellow',       hex: '#F5C518' },
  { name: 'Gold',         hex: '#D4AF37' },
  { name: 'Lime',         hex: '#9ACD32' },
  { name: 'Green',        hex: '#2E9E4F' },
  { name: 'Dark Green',   hex: '#1B5E20' },
  { name: 'Mint',         hex: '#7FD8B0' },
  { name: 'Cyan',         hex: '#22B8CF' },
  { name: 'Sky Blue',     hex: '#4DA3E8' },
  { name: 'Blue',         hex: '#1E5FBF' },
  { name: 'Navy',         hex: '#16305B' },
  { name: 'Purple',       hex: '#7B3FBF' },
  { name: 'Violet',       hex: '#9B6BD8' },
  { name: 'Magenta',      hex: '#C2298A' },
  { name: 'Pink',         hex: '#E86AA6' },
  { name: 'Brown',        hex: '#6B4423' },
  { name: 'Beige',        hex: '#D9C7A3' },
  { name: 'Natural',      hex: '#E8E2D5' },
  { name: 'Transparent',  hex: '#D8E8EE' },
  { name: 'Glow Green',   hex: '#B8F27A' },
  { name: 'Copper',       hex: '#B87333' },
  { name: 'Bronze',       hex: '#9C7A3C' },
  // Multi-color stock: the hex is only a fallback — the spool graphic paints a
  // hue sweep for anything named rainbow.
  { name: 'Rainbow',      hex: '#FF6B6B', rainbow: true },
];

/**
 * Name → hex lookup, used to fill the swatch as you type a color name.
 *
 * Built from the W3C/CSS named colors — a public specification, so there's no
 * third-party data licensing to worry about — plus names that turn up on
 * filament spools but aren't CSS colors. Longer names like "Galaxy Black" still
 * resolve because the client falls back to matching a known color word inside
 * the string.
 */
const CSS_COLORS = {
  'Alice Blue': '#F0F8FF', 'Antique White': '#FAEBD7', Aqua: '#00FFFF', Aquamarine: '#7FFFD4',
  Azure: '#F0FFFF', Beige: '#F5F5DC', Bisque: '#FFE4C4', Black: '#000000',
  'Blanched Almond': '#FFEBCD', Blue: '#0000FF', 'Blue Violet': '#8A2BE2', Brown: '#A52A2A',
  Burlywood: '#DEB887', 'Cadet Blue': '#5F9EA0', Chartreuse: '#7FFF00', Chocolate: '#D2691E',
  Coral: '#FF7F50', 'Cornflower Blue': '#6495ED', Cornsilk: '#FFF8DC', Crimson: '#DC143C',
  Cyan: '#00FFFF', 'Dark Blue': '#00008B', 'Dark Cyan': '#008B8B', 'Dark Goldenrod': '#B8860B',
  'Dark Gray': '#A9A9A9', 'Dark Green': '#006400', 'Dark Khaki': '#BDB76B', 'Dark Magenta': '#8B008B',
  'Dark Olive Green': '#556B2F', 'Dark Orange': '#FF8C00', 'Dark Orchid': '#9932CC', 'Dark Red': '#8B0000',
  'Dark Salmon': '#E9967A', 'Dark Sea Green': '#8FBC8F', 'Dark Slate Blue': '#483D8B',
  'Dark Slate Gray': '#2F4F4F', 'Dark Turquoise': '#00CED1', 'Dark Violet': '#9400D3',
  'Deep Pink': '#FF1493', 'Deep Sky Blue': '#00BFFF', 'Dim Gray': '#696969', 'Dodger Blue': '#1E90FF',
  Firebrick: '#B22222', 'Floral White': '#FFFAF0', 'Forest Green': '#228B22', Fuchsia: '#FF00FF',
  Gainsboro: '#DCDCDC', 'Ghost White': '#F8F8FF', Gold: '#FFD700', Goldenrod: '#DAA520',
  Gray: '#808080', Green: '#008000', 'Green Yellow': '#ADFF2F', Honeydew: '#F0FFF0',
  'Hot Pink': '#FF69B4', 'Indian Red': '#CD5C5C', Indigo: '#4B0082', Ivory: '#FFFFF0',
  Khaki: '#F0E68C', Lavender: '#E6E6FA', 'Lavender Blush': '#FFF0F5', 'Lawn Green': '#7CFC00',
  'Lemon Chiffon': '#FFFACD', 'Light Blue': '#ADD8E6', 'Light Coral': '#F08080', 'Light Cyan': '#E0FFFF',
  'Light Goldenrod': '#FAFAD2', 'Light Gray': '#D3D3D3', 'Light Green': '#90EE90', 'Light Pink': '#FFB6C1',
  'Light Salmon': '#FFA07A', 'Light Sea Green': '#20B2AA', 'Light Sky Blue': '#87CEFA',
  'Light Slate Gray': '#778899', 'Light Steel Blue': '#B0C4DE', 'Light Yellow': '#FFFFE0',
  Lime: '#00FF00', 'Lime Green': '#32CD32', Linen: '#FAF0E6', Magenta: '#FF00FF',
  Maroon: '#800000', 'Medium Aquamarine': '#66CDAA', 'Medium Blue': '#0000CD', 'Medium Orchid': '#BA55D3',
  'Medium Purple': '#9370DB', 'Medium Sea Green': '#3CB371', 'Medium Slate Blue': '#7B68EE',
  'Medium Spring Green': '#00FA9A', 'Medium Turquoise': '#48D1CC', 'Medium Violet Red': '#C71585',
  'Midnight Blue': '#191970', 'Mint Cream': '#F5FFFA', 'Misty Rose': '#FFE4E1', Moccasin: '#FFE4B5',
  'Navajo White': '#FFDEAD', Navy: '#000080', 'Old Lace': '#FDF5E6', Olive: '#808000',
  'Olive Drab': '#6B8E23', Orange: '#FFA500', 'Orange Red': '#FF4500', Orchid: '#DA70D6',
  'Pale Goldenrod': '#EEE8AA', 'Pale Green': '#98FB98', 'Pale Turquoise': '#AFEEEE',
  'Pale Violet Red': '#DB7093', 'Papaya Whip': '#FFEFD5', 'Peach Puff': '#FFDAB9', Peru: '#CD853F',
  Pink: '#FFC0CB', Plum: '#DDA0DD', 'Powder Blue': '#B0E0E6', Purple: '#800080',
  'Rebecca Purple': '#663399', Red: '#FF0000', 'Rosy Brown': '#BC8F8F', 'Royal Blue': '#4169E1',
  'Saddle Brown': '#8B4513', Salmon: '#FA8072', 'Sandy Brown': '#F4A460', 'Sea Green': '#2E8B57',
  Seashell: '#FFF5EE', Sienna: '#A0522D', Silver: '#C0C0C0', 'Sky Blue': '#87CEEB',
  'Slate Blue': '#6A5ACD', 'Slate Gray': '#708090', Snow: '#FFFAFA', 'Spring Green': '#00FF7F',
  'Steel Blue': '#4682B4', Tan: '#D2B48C', Teal: '#008080', Thistle: '#D8BFD8',
  Tomato: '#FF6347', Turquoise: '#40E0D0', Violet: '#EE82EE', Wheat: '#F5DEB3',
  White: '#FFFFFF', 'White Smoke': '#F5F5F5', Yellow: '#FFFF00', 'Yellow Green': '#9ACD32',
};

/** Names that turn up on spools but that CSS has never heard of. */
const FILAMENT_COLORS = {
  Natural: '#E8E2D5', Transparent: '#D8E8EE', Clear: '#DCECF2', Translucent: '#DDEAEF',
  Bronze: '#9C7A3C', Copper: '#B87333', Brass: '#B5A642', Gunmetal: '#4C5866',
  Charcoal: '#36454F', Graphite: '#41474D', Slate: '#5A6570', Ash: '#B2BEB5',
  'Matte Black': '#1A1A1A', 'Jet Black': '#0B0B0B', 'Galaxy Black': '#1B1B22',
  'Galaxy Blue': '#22305C', 'Galaxy Purple': '#3B2A5A', 'Space Gray': '#4A4E54',
  'Glow Green': '#B8F27A', 'Glow Blue': '#8FD8F2', 'Peak Green': '#00A170',
  'Bambu Green': '#00AE42', 'Prusa Orange': '#FA6831', 'Marble White': '#EDEAE4',
  'Wood Brown': '#9C7248', Birch: '#D9C7A3', Walnut: '#5C4033', Oak: '#C3A278',
  Terracotta: '#C86A4A', Sand: '#DCCBA6', Cream: '#F3EAD3',
  Burgundy: '#7B2233', Wine: '#6E2639', Mustard: '#D5A021', Mint: '#7FD8B0',
  Sage: '#9CAF88', Rust: '#B7410E', Bubblegum: '#F5A9C8',
  'Neon Green': '#39FF14', 'Neon Pink': '#FF6EC7', 'Neon Orange': '#FF6700',
  'Neon Yellow': '#FFFF33', 'Silk Gold': '#D4AF37', 'Silk Silver': '#C8CDD3',
  'Silk Copper': '#C07C3D', Rainbow: '#FF6B6B',
};

export const COLOR_NAMES = { ...CSS_COLORS, ...FILAMENT_COLORS };

/** Spool sizes in grams — the weights filament actually ships in. */
export const SPOOL_WEIGHTS = [250, 500, 750, 1000, 2000, 3000, 5000];

import { SPOOL_TARES as GENERATED_TARES } from './spool-tares.js';

/**
 * Configurations the crowdsourced database doesn't carry, from Printara3D and
 * Start3D. Additions only — the generator handles the cardboard arithmetic
 * itself now, including Bambu's, so there's nothing here to override.
 *
 * A refill has no spool at all, which is why the figure that ends up mattering
 * for one is whatever you wound it onto: the per-spool override, not this table.
 */
const EXTRA_TARES = [
  { brand: 'Bambu Lab', grams: 250, capacity: 1000, material: null, note: 'Reusable spool' },
  { brand: 'Bambu Lab', grams: 215, capacity: 1000, material: null, note: 'Refill cardboard core only' },

  /*
   * Sunlu revise their spool between production runs — people online talk about
   * a "version 3" — so the crowdsourced figures of 130–155 g are not wrong so
   * much as old. Every one of those records cites the same photo, captioned
   * "Sunlu Generational Differences", which rather gives the game away.
   *
   * This entry is a current spool on a kitchen scale: 186 g bare, 222 g with
   * the cardboard, and the cardboard counts because it's on the spool when you
   * weigh a part-used roll. It agrees with Printara3D's 220 g and disagrees
   * with the crowd, and a measurement beats a consensus of guesses.
   */
  { brand: 'Sunlu', grams: 222, capacity: 1000, material: null, weighed: true, note: 'Weighed: 186 g bare, 222 g with the cardboard. Older spools were lighter' },
];

export const SPOOL_TARES = [...GENERATED_TARES, ...EXTRA_TARES];

export const DIAMETERS = [1.75, 2.85, 3.0];
