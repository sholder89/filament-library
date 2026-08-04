import { Router } from 'express';
import { db } from '../db.js';
import { BRANDS, MATERIALS, COLORS, COLOR_NAMES, FINISHES, SPOOL_WEIGHTS, SPOOL_TARES, DIAMETERS } from '../catalog.js';

export const router = Router();

/** Distinct values already used in the inventory, so custom entries stick around. */
function used(column) {
  return db
    .prepare(`SELECT DISTINCT ${column} AS v FROM filaments WHERE ${column} != '' ORDER BY v COLLATE NOCASE`)
    .all()
    .map((r) => r.v);
}

const mergeNames = (seed, existing) => {
  const seen = new Map(seed.map((n) => [n.toLowerCase(), n]));
  for (const n of existing) if (!seen.has(n.toLowerCase())) seen.set(n.toLowerCase(), n);
  return [...seen.values()];
};

router.get('/', (_req, res) => {
  const seedMaterials = MATERIALS.map((m) => m.name);
  const extraMaterials = used('material').filter(
    (m) => !seedMaterials.some((s) => s.toLowerCase() === m.toLowerCase()),
  );

  res.json({
    // Brands you've actually bought float to the top of the picker.
    brands: mergeNames(BRANDS, used('brand')).sort((a, b) => a.localeCompare(b)),
    owned_brands: used('brand'),
    materials: [
      ...MATERIALS,
      ...extraMaterials.map((name) => ({ name, nozzle: null, bed: null, family: 'Other', enclosure: false, dry: false })),
    ],
    colors: COLORS,
    // Full name -> hex lookup: drives typeahead and the live swatch.
    color_names: COLOR_NAMES,
    finishes: [
      ...FINISHES,
      // Anything typed in before a finish was removed from the seed list.
      ...used('finish')
        .filter((f) => !FINISHES.some((s) => s.name.toLowerCase() === f.toLowerCase()))
        .map((name) => ({ name, effect: '', blurb: '' })),
    ],
    spool_weights: SPOOL_WEIGHTS,
    // Typical empty-spool weights, plus the ones actually measured here — your
    // own numbers are the reliable ones, so they're offered first and labelled.
    spool_tares: SPOOL_TARES,
    measured_tares: db.prepare(`
      SELECT brand, empty_spool_g AS grams, COUNT(*) AS spools
      FROM filaments
      WHERE empty_spool_g IS NOT NULL AND brand != ''
      GROUP BY brand, empty_spool_g
      ORDER BY brand COLLATE NOCASE, spools DESC
    `).all(),
    diameters: DIAMETERS,
    locations: used('location'),
  });
});
