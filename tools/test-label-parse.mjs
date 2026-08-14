/**
 * Checks the label parser against text transcribed from real spool labels.
 *
 * These fixtures are what an OCR engine sees: every line on the label, in
 * roughly reading order, including the noise (barcodes, part numbers, other
 * languages, safety marks). If the parser can pull clean fields out of these,
 * the only remaining unknown is OCR accuracy itself.
 *
 *   node tools/test-label-parse.mjs
 */

import { parseLabel } from '../server/label-parse.js';

const CASES = [
  {
    name: 'Creality retail box (brand, material and color on one line)',
    text: `3D printing filament
Filamento para impresión 3D
X004ZI1YVN
Creality PETG (Clear Wine Red)
NEW
Made in China
3D プリンターフィラメント
3D 프린팅 필라멘트
3D打印线材`,
    expect: { brand: 'Creality', material: 'PETG', color_name: 'Clear Wine Red' },
  },
  {
    name: 'Creality spec table (bilingual, product code not brand name)',
    text: `Product Name
产品名称
CR-PETG
Color
颜色
Transparent
Burgundy Red
透明酒红色
Diameter
直径
1.75mm
N.W.
重量
1.0kg
Print Temp
打印温度
230-250℃
CC525500276
Made in China
RoHS`,
    expect: {
      brand: 'Creality', material: 'PETG', color_name: 'Transparent Burgundy Red',
      diameter: 1.75, spool_weight_g: 1000, nozzle_temp: 230,
    },
  },
  {
    name: '3D-Fuel spool (product line prefix, blank temp fields)',
    text: `3D-FUEL
FUELING YOUR CREATIVITY
Pro PCTG
Toolbox Red
Hot End: °C
Heated Bed: °C
Speed: mm/s
Made in North Dakota, USA
S/N: 32GXHFsB
1.75 mm
1 kg`,
    expect: {
      brand: '3D-Fuel', material: 'PCTG', color_name: 'Toolbox Red',
      diameter: 1.75, spool_weight_g: 1000,
    },
    absent: ['nozzle_temp', 'bed_temp'],
  },
  {
    name: 'Creality spool, printed on plastic (no color anywhere)',
    text: `CREALITY
BETTER FILAMENT PLAN
CR-PETG
Diameter: 1.75MM
Net Weight: 1KG
Extruder Temp:
230°C-250°C`,
    expect: {
      brand: 'Creality', material: 'PETG',
      diameter: 1.75, spool_weight_g: 1000, nozzle_temp: 230,
    },
    absent: ['color_name'],
  },
  {
    name: 'Unbranded spool (no brand anywhere, color glued to the weight)',
    text: `1.75MM PLA+ 3D FILAMENT
LIGHT BLUE-1KG(N.W)
Print Temp: 210-230°C
6 922572 219137
EAN
8 40249 11913 8
UPC
RoHS`,
    expect: {
      material: 'PLA+', color_name: 'Light Blue',
      diameter: 1.75, spool_weight_g: 1000, nozzle_temp: 210,
    },
    absent: ['brand'],
  },

  {
    name: 'Tri-color silk (two finishes, three tones from the color name)',
    text: [
      'COLOURBING',
      'PLA Silk Tricolor Gradient Filament',
      'Color: Purple Orange Teal',
      '1.75mm  1KG',
    ].join('\n'),
    expect: {
      brand: 'Colourbing',
      material: 'PLA Silk',
      color_name: 'Purple Orange Teal',
      color_hex: '#800080',
      color_hex2: '#FFA500',
      color_hex3: '#008080',
      finish: 'Gradient, Silk',
      diameter: 1.75,
      spool_weight_g: 1000,
    },
  },

  {
    name: 'Colourbing spool tag (colors divided by slashes)',
    text: [
      'Tricolor filament Silk PLA+ 1.75mm',
      'Color:Sky Blue/Rose Red/Light Green',
      'N.W.:250g',
      'Print Temp:200-220°C',
      'Bed Temp:0-60°C',
      'Lot:H0515PR6D',
    ].join('\n'),
    expect: {
      material: 'PLA+',
      color_name: 'Sky Blue/Rose Red/Light Green',
      color_hex: '#87CEEB',
      color_hex2: '#FF0000',
      color_hex3: '#90EE90',
      finish: 'Silk, Gradient',
      diameter: 1.75,
      spool_weight_g: 250,
      nozzle_temp: 200,
      bed_temp: 60,
    },
  },

  {
    // Printed "Turquoiso". Guessing beats dropping the color: the cost of
    // being wrong is a slightly-off shade, and it plainly meant to be a color.
    name: 'Colourbing spool tag with a misspelled color',
    text: [
      'Tricolor filament Silk PLA+ 1.75mm',
      'Color:Turquoiso/Coral/Gold',
      'N.W:250g',
      'Print Temp:200-220°C',
      'Bed Temp:0-60°C',
    ].join('\n'),
    expect: {
      material: 'PLA+',
      color_name: 'Turquoiso/Coral/Gold',
      color_hex: '#40E0D0',
      color_hex2: '#FF7F50',
      color_hex3: '#FFD700',
      finish: 'Silk, Gradient',
      spool_weight_g: 250,
    },
  },

  {
    // The camera crops to the viewfinder, so "Tricolor" up in the heading is
    // often not in the photograph — the three colors have to speak for
    // themselves, including the halves the vocabulary doesn't know ("Rose").
    name: 'Run-together color names on a tightly framed swatch',
    text: 'SkyBlue RoseRed LightGreen',
    expect: {
      color_name: 'Sky Blue Rose Red Light Green',
      color_hex: '#87CEEB',
      color_hex2: '#FF0000',
      color_hex3: '#90EE90',
    },
  },

  {
    name: 'A color with a poetic name is one color, not its ingredients',
    text: 'Elegoo PLA\nColor: Snow Mountain Blue\n1.75mm 1KG',
    expect: { brand: 'Elegoo', color_name: 'Snow Mountain Blue' },
    // "Snow" and "Blue" are both known colors; "Mountain" is what says this is
    // a name rather than a list, and nothing extra should be invented from it.
    absent: ['color_hex2', 'color_hex3', 'finish'],
  },
];

let failures = 0;

for (const c of CASES) {
  const got = parseLabel(c.text);
  const problems = [];

  for (const [field, want] of Object.entries(c.expect)) {
    if (got[field] !== want) problems.push(`${field}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got[field])}`);
  }
  for (const field of c.absent ?? []) {
    if (got[field] !== undefined) problems.push(`${field}: expected nothing, got ${JSON.stringify(got[field])}`);
  }

  console.log(`${problems.length ? 'FAIL' : 'PASS'}  ${c.name}`);
  console.log(`      ${JSON.stringify(got)}`);
  for (const p of problems) console.log(`      -> ${p}`);
  if (problems.length) failures++;
}

console.log();
console.log(failures ? `${failures} of ${CASES.length} labels failed.` : `All ${CASES.length} labels parsed correctly.`);
process.exit(failures ? 1 : 0);
