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
      /*
       * Anything typed in before a finish was removed from the seed list. A
       * spool can carry several as one comma-separated value, so the stored
       * strings are split apart first — otherwise "Silk, Gradient" would show
       * up in the filter as a third option alongside Silk and Gradient.
       */
      ...[...new Set(used('finish').flatMap((f) => f.split(',').map((s) => s.trim())))]
        .filter((f) => f && !FINISHES.some((s) => s.name.toLowerCase() === f.toLowerCase()))
        .sort((a, b) => a.localeCompare(b))
        .map((name) => ({ name, effect: '', blurb: '' })),
    ],
    spool_weights: SPOOL_WEIGHTS,
    // Typical empty-spool weights, plus the ones actually measured here — your
    // own numbers are the reliable ones, so they're offered first and labeled.
    spool_tares: SPOOL_TARES,
    // Weights you've saved yourself. Same shape as the reference list so both
    // go through one matcher, differing only in which pool is consulted first.
    my_tares: db.prepare(`
      SELECT * FROM spool_tares
      ORDER BY brand COLLATE NOCASE, variant COLLATE NOCASE
    `).all().map((t) => ({
      id: t.id,
      brand: t.brand,
      variant: t.variant,
      grams: t.grams,
      capacity: t.capacity_g || null,
      material: t.material || null,
      note: t.note,
      // Breaks the tie when a brand has several: the newest is offered first.
      updated_at: t.updated_at,
    })),
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
