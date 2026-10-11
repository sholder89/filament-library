import { readFileSync } from 'node:fs';
import { timingSafeEqual, createHash } from 'node:crypto';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { STATUSES, SORTS } from './routes/filaments.js';
import { KINDS } from './routes/locations.js';
import { VALID_SIZES } from './routes/print.js';

/**
 * MCP endpoint, so AI assistants on the LAN can read and update the inventory.
 *
 * Every tool goes through the app's own REST API over loopback rather than
 * touching the database. Validation, the history, undo and the live updates
 * the kiosk listens to then behave exactly as they do for the web UI, and no
 * rule lives in two places.
 *
 * Stateless: each POST builds a fresh server and transport and answers with
 * plain JSON. Reads plus safe writes only; deleting, importing and the Vision
 * key settings are deliberately not here.
 */

const SLUG = 'filament-library';
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const INSTRUCTIONS = [
  'Filament Library tracks 3D-printer filament spools.',
  'Each filament record is one physical spool with brand, material, color, a status (new = sealed,',
  'opened, empty = used up), the percentage left of its spool_weight_g, and a location, which is the',
  'name of a storage place or printer from filament_list_locations; a spool in a printer is "loaded".',
  'Use filament_list with filters to find spools and their ids before changing them; every change is',
  'logged in filament_history and can be reverted with filament_undo.',
].join(' ');

const HOST = process.env.HOST;
const LOOPBACK = !HOST || HOST === '0.0.0.0' || HOST === '::' ? '127.0.0.1' : HOST;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// ── Talking to the app's own API ────────────────────────────────────────────

class ApiError extends Error {}

/** Calls this app's REST API on the port the MCP request itself arrived on. */
function client(port) {
  return async function api(method, path, { query, body } = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    }
    const url = `http://${LOOPBACK}:${port}${path}${qs.size ? `?${qs}` : ''}`;
    const res = await fetch(url, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
    if (!res.ok) throw new ApiError(data?.error || `${method} ${path} failed with ${res.status}`);
    return data;
  };
}

/** structuredContent has to be an object, so lists travel wrapped. */
function ok(data) {
  const structured = Array.isArray(data) ? { items: data } : data;
  return { content: [{ type: 'text', text: JSON.stringify(structured) }], structuredContent: structured };
}

/** The REST error message, handed back for the model to correct itself with. */
async function run(fn) {
  try {
    return ok(await fn());
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: err.message }] };
  }
}

function page(items, limit) {
  return { total: items.length, items: items.slice(0, limit ?? DEFAULT_LIMIT) };
}

const omit = (obj, keys) => Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)));

// ── Shared schema pieces ────────────────────────────────────────────────────

const limit = z.number().int().min(1).max(MAX_LIMIT).optional()
  .describe(`How many to return, default ${DEFAULT_LIMIT}, at most ${MAX_LIMIT}. "total" says how many matched.`);
const filamentId = z.string().min(1)
  .describe('The spool\'s 8-character id, from filament_list or filament_get.');
const hexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/);

/** What a spool is made of and where it is: the fields create and update share. */
const SPOOL_FIELDS = {
  color_name: z.string().optional()
    .describe('Color name as the maker sells it, e.g. "Galaxy Black". filament_catalog_search lists known names.'),
  color_hex: hexColor.optional().describe('Main color as #RRGGBB, used to draw the spool.'),
  color_hex2: hexColor.or(z.literal('')).optional()
    .describe('Second color for dual/tri-color or gradient spools, #RRGGBB; empty string for none.'),
  color_hex3: hexColor.or(z.literal('')).optional().describe('Third color, #RRGGBB; empty string for none.'),
  finish: z.string().optional()
    .describe('Finish names, comma-separated when there are several, e.g. "Silk, Gradient". '
      + 'filament_catalog_search lists the known ones.'),
  diameter: z.number().min(0.1).max(10).optional().describe('Filament diameter in mm, usually 1.75.'),
  location: z.string().optional()
    .describe('Name of a place from filament_list_locations, or an empty string for not put away. '
      + 'A printer\'s name loads the spool into it, and loading a sealed spool marks it opened.'),
  status: z.enum(STATUSES).optional()
    .describe('new = sealed, opened = in use, empty = used up. filament_set_status is the usual way to change it.'),
  remaining_pct: z.number().int().min(0).max(100).optional().describe('Filament left, as a percentage of spool_weight_g.'),
  spool_weight_g: z.number().int().min(1).max(100000).optional()
    .describe('Net filament weight of a full spool in grams, e.g. 1000.'),
  empty_spool_g: z.number().int().min(0).max(100000).nullable().optional()
    .describe('Weight of the empty spool in grams, if weighed; null if not. See filament_list_spool_tares.'),
  nozzle_temp: z.number().int().min(0).max(600).nullable().optional().describe('Nozzle temperature in °C.'),
  bed_temp: z.number().int().min(0).max(300).nullable().optional().describe('Bed temperature in °C.'),
  price: z.number().min(0).max(100000).nullable().optional().describe('Price paid for the spool.'),
  // Plain strings rather than nullable ones, which some clients' schema dialects
  // can't express; the API already reads an empty string as "no date".
  purchased_at: z.string().optional().describe('Date bought, YYYY-MM-DD or an ISO timestamp; empty string to clear.'),
  opened_at: z.string().optional()
    .describe('Date opened, YYYY-MM-DD or an ISO timestamp; empty string to clear. Giving one on create '
      + 'marks the spool opened.'),
  notes: z.string().optional().describe('Free-text notes.'),
};

const READ = { readOnlyHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

// ── Tools ───────────────────────────────────────────────────────────────────

function buildServer(api) {
  const server = new McpServer({ name: SLUG, version: VERSION }, { instructions: INSTRUCTIONS });

  // Reads

  server.registerTool('filament_list', {
    title: 'List filament spools',
    description: 'Finds spools, returning { total, items } with each spool\'s id, brand, material, color, '
      + 'status, remaining_pct (% of spool_weight_g grams), location and dates. Spools in a printer come '
      + 'first. Used-up spools are left out unless status includes "empty" or include_empty is true. '
      + 'Use this to find the id any write tool needs.',
    inputSchema: {
      q: z.string().optional()
        .describe('Search words matched across brand, material, color, finish, location and notes; every '
          + 'word must match. Commas separate alternatives ("sunlu red, elegoo blue"), a leading minus '
          + 'excludes ("red -silk"), and an exact 8-character id matches that spool.'),
      status: z.string().optional()
        .describe(`Comma-separated statuses to include: ${STATUSES.join(', ')} (new = sealed, empty = used up).`),
      brand: z.string().optional().describe('Comma-separated exact brand names.'),
      material: z.string().optional().describe('Comma-separated exact material names, e.g. "PLA,PETG".'),
      finish: z.string().optional().describe('Comma-separated finishes; a spool matches if it has any of them.'),
      location: z.string().optional()
        .describe('Comma-separated location names; "__none__" matches spools with no location.'),
      low: z.boolean().optional().describe('Only opened spools at 25% or less.'),
      include_empty: z.boolean().optional().describe('Also include used-up spools.'),
      sort: z.enum(Object.keys(SORTS)).optional().describe('Order after loaded spools; default newest.'),
      limit,
    },
    annotations: READ,
  }, ({ low, include_empty, limit: n, ...query }) => run(async () => page(
    await api('GET', '/api/filaments', {
      query: { ...query, low: low ? '1' : undefined, include_empty: include_empty ? '1' : undefined },
    }), n)));

  server.registerTool('filament_get', {
    title: 'Get one spool',
    description: 'Returns every field of one spool by id: brand, material, colors, finish, status, '
      + 'remaining_pct, spool_weight_g and empty_spool_g in grams, temperatures in °C, location, and '
      + 'purchased/opened/finished dates (ISO).',
    inputSchema: { id: filamentId },
    annotations: READ,
  }, ({ id }) => run(() => api('GET', `/api/filaments/${encodeURIComponent(id)}`)));

  server.registerTool('filament_history', {
    title: 'Spool history',
    description: 'The change log of one spool, newest first, as { total, items }: each event has "at" '
      + '(ISO timestamp of the save), kind, and the field with its from and to values. Changes saved '
      + 'together share one "at"; pass it to filament_undo to revert that save.',
    inputSchema: { id: filamentId, limit },
    annotations: READ,
  }, ({ id, limit: n }) => run(async () => page(
    (await api('GET', `/api/filaments/${encodeURIComponent(id)}/events`)).events, n)));

  server.registerTool('filament_stats', {
    title: 'Inventory totals',
    description: 'Totals for the whole inventory: spools by status (new = sealed, opened, empty = used up), '
      + 'total, active_grams (filament left on spools not used up, in grams), low (opened spools at 25% or '
      + 'less), and how many distinct brands and materials are in use.',
    inputSchema: {},
    annotations: READ,
  }, () => run(() => api('GET', '/api/filaments/stats')));

  server.registerTool('filament_list_locations', {
    title: 'List locations',
    description: 'The places a spool can be, as { total, items }: each has an id (for '
      + 'filament_update_location), name (what a spool\'s location field holds), kind (printer or '
      + 'storage), a short printer code like H2S, and how many spools are there. Printers come first.',
    inputSchema: { limit },
    annotations: READ,
  }, ({ limit: n }) => run(async () => page((await api('GET', '/api/locations')).locations, n)));

  server.registerTool('filament_catalog_search', {
    title: 'Search the catalog',
    description: 'Known brand, material, color, finish, spool size and diameter names, so new spools use '
      + 'the same spelling as the rest of the library. Materials include typical nozzle and bed '
      + 'temperatures in °C. owned_brands are brands already in the library. With no arguments, returns '
      + 'every section except color_names and spool_tares, which are long; ask for those by section or q.',
    inputSchema: {
      q: z.string().optional().describe('Only entries whose name (or brand) contains this text, case-insensitive.'),
      section: z.enum(['brands', 'owned_brands', 'materials', 'colors', 'color_names', 'finishes',
        'spool_weights', 'diameters', 'spool_tares']).optional()
        .describe('Return just this section. color_names maps every named color to its hex; spool_tares '
          + 'is reference empty-spool weights in grams by brand.'),
    },
    annotations: READ,
  }, ({ q, section }) => run(async () => {
    const all = await api('GET', '/api/catalog');
    const needle = (q ?? '').trim().toLowerCase();
    const hit = (v) => !needle || String(v).toLowerCase().includes(needle);
    const sections = {
      brands: all.brands.filter(hit),
      owned_brands: all.owned_brands.filter(hit),
      materials: all.materials.filter((m) => hit(m.name)),
      colors: all.colors.filter((c) => hit(c.name)),
      color_names: Object.fromEntries(Object.entries(all.color_names).filter(([name]) => hit(name))),
      // effect is a drawing hint for the spool picture; the name and blurb are what mean something.
      finishes: all.finishes.filter((f) => hit(f.name)).map((f) => omit(f, ['effect'])),
      spool_weights: all.spool_weights,
      diameters: all.diameters,
      spool_tares: all.spool_tares.filter((t) => hit(t.brand)),
    };
    if (section) return { [section]: sections[section] };
    return needle ? sections : omit(sections, ['color_names', 'spool_tares']);
  }));

  server.registerTool('filament_list_spool_tares', {
    title: 'List weighed empty spools',
    description: 'Empty-spool weights weighed here, as { total, items }: brand, variant, material and '
      + 'capacity_g it applies to (0 / empty = any), and grams. Subtract this from a scale reading to get '
      + 'the filament left; filament_catalog_search section spool_tares has reference weights for more brands.',
    inputSchema: { limit },
    annotations: READ,
  }, ({ limit: n }) => run(async () => page((await api('GET', '/api/tares')).tares, n)));

  server.registerTool('filament_print_status', {
    title: 'Label printing status',
    description: 'Whether QR label printing is set up: mode is "relay", "direct" or "off" (off means '
      + 'filament_print_label will fail). Also the pinned label size, if any, and whether labels carry text.',
    inputSchema: {},
    annotations: READ,
  }, () => run(async () => omit(await api('GET', '/api/print/status'), ['target'])));

  // Writes

  server.registerTool('filament_create', {
    title: 'Add a spool',
    description: 'Adds one or more identical spools (quantity) and returns them. Brand and material are '
      + 'required; everything else has a default (sealed, 100% of 1000 g, 1.75 mm). Check '
      + 'filament_catalog_search for the usual spelling of the brand, material, color and finish first. '
      + 'To add another of a spool already in the library, filament_duplicate is simpler.',
    inputSchema: {
      brand: z.string().min(1).describe('Maker, e.g. "Sunlu".'),
      material: z.string().min(1).describe('Material type, e.g. "PLA", "PETG", "TPU 95A".'),
      ...SPOOL_FIELDS,
      quantity: z.number().int().min(1).max(20).optional().describe('How many identical spools to add, default 1.'),
    },
    annotations: { ...WRITE, idempotentHint: false },
  }, (body) => run(async () => {
    const made = await api('POST', '/api/filaments', { body });
    return { created: Array.isArray(made) ? made : [made] };
  }));

  server.registerTool('filament_update', {
    title: 'Edit a spool',
    description: 'Changes only the fields given on one spool (find its id with filament_list) and returns '
      + 'the updated spool. Use it to move a spool (location), record what\'s left (remaining_pct) or '
      + 'correct details. Revert with filament_undo.',
    inputSchema: {
      id: filamentId,
      brand: z.string().min(1).optional().describe('Maker, e.g. "Sunlu".'),
      material: z.string().min(1).optional().describe('Material type, e.g. "PLA".'),
      ...SPOOL_FIELDS,
    },
    annotations: { ...WRITE, idempotentHint: true },
  }, ({ id, ...body }) => run(() => {
    if (!Object.keys(body).length) throw new ApiError('Give at least one field to change.');
    return api('PATCH', `/api/filaments/${encodeURIComponent(id)}`, { body });
  }));

  server.registerTool('filament_set_status', {
    title: 'Open, finish or reseal a spool',
    description: 'Moves one spool (find its id with filament_list) through its life and returns it. '
      + 'open: the seal is broken and it\'s in use (stamps opened_at). empty: it\'s used up (0% left, '
      + 'taken out of the printer). restore: a spool marked used up by mistake goes back to opened. '
      + 'unopen: it was never actually opened, back to sealed and 100%. Revert with filament_undo.',
    inputSchema: {
      id: filamentId,
      action: z.enum(['open', 'empty', 'restore', 'unopen']).describe('What happened to the spool.'),
    },
    annotations: { ...WRITE, idempotentHint: true },
  }, ({ id, action }) => run(() => api('POST', `/api/filaments/${encodeURIComponent(id)}/${action}`)));

  server.registerTool('filament_undo', {
    title: 'Undo a change',
    description: 'Reverts one save on a spool and removes it from the history, returning the spool as it is '
      + 'now. With no "at" it reverts the most recent change; to revert an earlier one, pass its "at" from '
      + 'filament_history. Adding a spool cannot be undone this way.',
    inputSchema: {
      id: filamentId,
      at: z.string().optional().describe('The "at" timestamp of the save to revert, from filament_history.'),
    },
    annotations: { ...WRITE, idempotentHint: false },
  }, ({ id, at }) => run(async () => {
    const path = `/api/filaments/${encodeURIComponent(id)}`;
    let when = at;
    if (!when) {
      const { events } = await api('GET', `${path}/events`);
      if (!events.length) throw new ApiError('That spool has no changes to undo.');
      when = events[0].at;
    }
    return api('POST', `${path}/undo`, { body: { at: when } });
  }));

  server.registerTool('filament_duplicate', {
    title: 'Add another of the same spool',
    description: '"I bought another of these": copies a spool\'s brand, material, color, finish, size and '
      + 'location into new sealed, full spools and returns them. Purchase date and price are not copied. '
      + 'Find the source id with filament_list.',
    inputSchema: {
      id: filamentId,
      quantity: z.number().int().min(1).max(20).optional().describe('How many copies, default 1.'),
    },
    annotations: { ...WRITE, idempotentHint: false },
  }, ({ id, quantity }) => run(async () => {
    const made = await api('POST', `/api/filaments/${encodeURIComponent(id)}/duplicate`, { body: { quantity } });
    return { created: Array.isArray(made) ? made : [made] };
  }));

  server.registerTool('filament_create_location', {
    title: 'Add a location',
    description: 'Adds a place spools can be, a printer or a storage spot, and returns it with its id. '
      + 'Check filament_list_locations first: names must be unique.',
    inputSchema: {
      name: z.string().min(1).max(40).describe('Name as it should appear, e.g. "Dry box 2" or "Bambu H2S".'),
      kind: z.enum(KINDS).optional().describe('printer or storage, default storage. Spools in a printer count as loaded.'),
      code: z.string().regex(/^[A-Za-z0-9]{0,4}$/).optional()
        .describe('Short code of up to 4 letters or numbers shown for printers, e.g. H2S or A1M.'),
      icon: z.string().optional()
        .describe('Icon key, e.g. printer, box, shelf, drawer; an unknown key shows a box.'),
    },
    annotations: { ...WRITE, idempotentHint: false },
  }, (body) => run(() => api('POST', '/api/locations', { body })));

  server.registerTool('filament_update_location', {
    title: 'Edit a location',
    description: 'Changes the fields given on one location (id from filament_list_locations) and returns it. '
      + 'Renaming moves every spool there to the new name.',
    inputSchema: {
      id: z.number().int().describe('The location\'s id from filament_list_locations.'),
      name: z.string().min(1).max(40).optional().describe('New name.'),
      kind: z.enum(KINDS).optional().describe('printer or storage.'),
      code: z.string().regex(/^[A-Za-z0-9]{0,4}$/).optional()
        .describe('Short code of up to 4 letters or numbers, or an empty string to clear it.'),
      icon: z.string().optional().describe('Icon key, e.g. printer, box, shelf, drawer.'),
    },
    annotations: { ...WRITE, idempotentHint: true },
  }, ({ id, ...body }) => run(() => api('PATCH', `/api/locations/${id}`, { body })));

  server.registerTool('filament_print_label', {
    title: 'Print a QR label',
    description: 'Prints a physical QR label for one spool (id from filament_list) on the label printer. '
      + 'Only use this when the user asked for a label: every call prints. filament_print_status says '
      + 'whether printing is set up.',
    inputSchema: {
      id: filamentId,
      size: z.enum(VALID_SIZES).optional()
        .describe('Label size in inches (or 50mm-round). Leave out to use the size loaded in the printer.'),
      copies: z.number().int().min(1).max(5).optional().describe('How many labels, default 1.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, ({ id, size, copies }) => run(() => api('POST', `/api/print/${encodeURIComponent(id)}`, {
    body: { size, copies },
  })));

  return server;
}

// ── Endpoint ────────────────────────────────────────────────────────────────

const ALLOWED_ORIGINS = (process.env.MCP_ALLOWED_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const TOKEN = process.env.MCP_TOKEN || '';
const digest = (s) => createHash('sha256').update(s).digest();

/**
 * MCP clients don't send Origin; browsers do. Refusing unknown origins stops a
 * web page from driving this API through the browser of someone on the LAN.
 */
function mcpGuard(req, res, next) {
  const origin = req.get('origin');
  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    return res.status(403).json({ error: 'Origin not allowed.' });
  }
  if (TOKEN) {
    const given = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!timingSafeEqual(digest(given), digest(TOKEN))) {
      return res.status(401).json({ error: 'Missing or wrong bearer token.' });
    }
  }
  next();
}

export function mountMcp(app) {
  if (/^(false|0|no|off)$/i.test(process.env.MCP_ENABLED ?? '')) return;

  app.post('/mcp', mcpGuard, express.json({ limit: '1mb' }), async (req, res) => {
    const server = buildServer(client(req.socket.localPort));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('MCP request failed:', err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
      }
    }
  });

  const notAllowed = (_req, res) => res.status(405).set('Allow', 'POST').json({ error: 'Use POST.' });
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);
}
