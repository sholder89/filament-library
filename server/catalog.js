/**
 * Pre-filled reference data: brands, material types and common colors.
 *
 * This is seed/reference data only — the UI lets you type anything that isn't
 * in here, and whatever you type is remembered (see /api/catalog, which merges
 * these lists with the distinct values already present in your inventory).
 */

export const BRANDS = [
  'Sunlu',
  'Bambu Lab',
  'Creality',
  'Overture',
  'Hatchbox',
  'eSun',
  'Polymaker',
  'Prusament',
  'Elegoo',
  'Anycubic',
  'Inland',
  'Jayo',
  'Eryone',
  'Duramic 3D',
  'Amolen',
  'Atomic Filament',
  'MatterHackers',
  'Protopasta',
  'Fillamentum',
  'ColorFabb',
  '3DXTech',
  'Kingroon',
  'Voxelab',
  'Geeetech',
  'Tinmorry',
  'Flashforge',
  'AnkerMake',
  'Priline',
  'GizmoDorks',
  'Spectrum',
  'Devil Design',
  'Extrudr',
  'FormFutura',
  'NinjaTek',
  'Filamentum',
  'IIID Max',
  'Numakers',
  'Ziro',
  'TTYT3D',
  'Comgrow',
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
  { name: 'PEEK',       nozzle: 400, bed: 130, family: 'Other', enclosure: true,  dry: true  },
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
  { name: 'Rainbow',      hex: '#FF6B6B' },
];

/** Spool sizes in grams — the weights filament actually ships in. */
export const SPOOL_WEIGHTS = [250, 500, 750, 1000, 2000, 3000, 5000];

export const DIAMETERS = [1.75, 2.85, 3.0];
