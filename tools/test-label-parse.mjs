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
