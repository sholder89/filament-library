import { Router } from 'express';
import { db } from '../db.js';
import { BRANDS, MATERIALS, COLORS, SPOOL_WEIGHTS, DIAMETERS } from '../catalog.js';

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
    spool_weights: SPOOL_WEIGHTS,
    diameters: DIAMETERS,
    locations: used('location'),
  });
});
