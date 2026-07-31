import { spoolSVG, escapeXML as esc, luminance, RAINBOW_CSS, isRainbow, effectFor } from './spool.js';
import { labelPreviewHTML } from './label.js';
import { QrScanner, cameraBlockedReason, filamentIdFrom } from './scan.js';

// ── State ────────────────────────────────────────────────────────────────────

const state = {
  filaments: [],
  catalog: { brands: [], materials: [], colors: [], locations: [] },
  print: { mode: 'off' },
  editingId: null,
  filters: { status: 'active', brand: [], material: [], finish: [], q: '', sort: 'newest' },
  // Group keys the user has fanned open; everything else stays stacked.
  expandedGroups: new Set(),
  // Section headings the user has folded away in a grouped view.
  collapsedSections: new Set(),
  view: 'medium',
};

const $ = (sel) => document.querySelector(sel);
const el = {
  stats: $('#stats'),
  grid: $('#grid'),
  statusFilter: $('#statusFilter'),
  search: $('#search'),
  brandFilterBtn: $('#brandFilterBtn'),
  materialFilterBtn: $('#materialFilterBtn'),
  sortBy: $('#sortBy'),
  clearFilters: $('#clearFilters'),
  picker: $('#picker'),
  scanner: $('#scanner'),
  detail: $('#detail'),
  detailBody: $('#detailBody'),
  editor: $('#editor'),
  editorForm: $('#editorForm'),
  editorTitle: $('#editorTitle'),
  editorError: $('#editorError'),
  saveBtn: $('#saveBtn'),
  toast: $('#toast'),
};

// ── Helpers ──────────────────────────────────────────────────────────────────

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(message, isError = false) {
  el.toast.textContent = message;
  el.toast.classList.toggle('err', isError);
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), 3200);
}

const STATUS_LABEL = { new: 'Sealed', opened: 'Opened', empty: 'Used up' };

const nameOf = (f) => [f.brand, f.material].filter(Boolean).join(' ');

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function ago(iso) {
  if (!iso) return '';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 31) return `${days} days ago`;
  const months = Math.round(days / 30.44);
  if (months < 24) return `${months} month${months === 1 ? '' : 's'} ago`;
  return `${Math.round(days / 365.25)} years ago`;
}

// The filter popover isn't a <dialog> — it's dismissed by closePicker instead.
const SHEETS = [el.detail, el.editor, el.scanner];

/** Locks background scrolling while a sheet is up — iOS ignores <dialog>'s own lock. */
function openSheet(dialog) {
  document.body.style.overflow = 'hidden';
  dialog.showModal();
}

/**
 * Unlocking is done here rather than purely from the dialog's `close` event:
 * that event doesn't fire in every engine, and a missed one leaves the page
 * permanently unscrollable. The listener below stays as a backstop for closes
 * that bypass this function.
 */
function closeSheet(dialog) {
  // Single choke point, so the camera is always released no matter which
  // affordance dismissed the sheet — button, backdrop tap or Esc.
  if (dialog === el.scanner) stopScanner();
  dialog.close();
  releaseScrollLock();
}

function releaseScrollLock() {
  if (!SHEETS.some((d) => d.open) && !pickerKind) document.body.style.overflow = '';
}

for (const dialog of SHEETS) {
  dialog.addEventListener('close', releaseScrollLock);
  // Tapping the backdrop dismisses.
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) closeSheet(dialog);
  });
}

// ── Load ─────────────────────────────────────────────────────────────────────

async function loadCatalog() {
  state.catalog = await api('/api/catalog');
  // Every known name is offered for typeahead, not just the swatch shortlist.
  fillDatalist('colorList', Object.keys(state.catalog.color_names ?? {}).sort());
  fillDatalist('locationList', state.catalog.locations);
  fillDatalist('weightList', state.catalog.spool_weights.map(String));
  fillFinishSelect();
  syncFilterButtons();
  renderSwatches();
}

function fillFinishSelect() {
  const select = form.elements.finish;
  const current = select.value;
  select.innerHTML = '<option value="">Standard — no special finish</option>'
    + (state.catalog.finishes ?? []).map((f) =>
      `<option value="${esc(f.name)}">${esc(f.name)}</option>`).join('');
  select.value = current;
}

// ── Brand / type pickers ─────────────────────────────────────────────────────

const CUSTOM = '__custom__';

/**
 * A <select> of known values paired with a text input for anything new.
 *
 * The select owns `required` so an unmade choice complains on a control the
 * browser can focus; the text input only becomes required once "Something
 * else" is picked. A hidden required field fails validation silently, which is
 * exactly the trap this avoids.
 */
function buildPicker({ select, input, groups, value, placeholder, onPick }) {
  const seen = new Set();
  let html = `<option value="" disabled${value ? '' : ' selected'}>${esc(placeholder)}</option>`;

  for (const [label, items] of groups) {
    const fresh = items.filter((i) => i && !seen.has(i.toLowerCase()));
    if (!fresh.length) continue;
    html += `<optgroup label="${esc(label)}">`;
    for (const item of fresh) {
      seen.add(item.toLowerCase());
      html += `<option value="${esc(item)}">${esc(item)}</option>`;
    }
    html += '</optgroup>';
  }

  // An existing spool may use a name no longer in the catalog — keep it
  // selectable so editing doesn't silently rewrite it.
  if (value && !seen.has(value.toLowerCase())) {
    html += `<optgroup label="Current"><option value="${esc(value)}">${esc(value)}</option></optgroup>`;
    seen.add(value.toLowerCase());
  }

  html += `<option value="${CUSTOM}">＋ Something else…</option>`;

  select.innerHTML = html;
  select.value = value || '';
  input.value = value || '';
  input.hidden = true;
  input.required = false;

  if (!select.dataset.wired) {
    select.dataset.wired = '1';
    select.addEventListener('change', () => {
      if (select.value === CUSTOM) {
        input.hidden = false;
        input.required = true;
        input.value = '';
        input.focus();
      } else {
        input.hidden = true;
        input.required = false;
        input.value = select.value;
      }
      onPick?.(input.value);
      syncPreview();
    });
    input.addEventListener('input', () => {
      onPick?.(input.value);
      syncPreview();
    });
  }
}

function refreshBrandPicker(value = '') {
  const owned = state.catalog.owned_brands ?? [];
  const rest = (state.catalog.brands ?? []).filter(
    (b) => !owned.some((o) => o.toLowerCase() === b.toLowerCase()),
  );
  buildPicker({
    select: $('#f_brand_pick'),
    input: form.elements.brand,
    groups: [['Brands you own', owned], ['Common brands', rest]],
    value,
    placeholder: 'Choose a brand…',
  });
}

function refreshMaterialPicker(value = '') {
  const materials = state.catalog.materials ?? [];
  const owned = [...new Set(state.filaments.map((f) => f.material))].filter(Boolean).sort();
  const byFamily = new Map();
  for (const m of materials) {
    if (owned.some((o) => o.toLowerCase() === m.name.toLowerCase())) continue;
    if (!byFamily.has(m.family)) byFamily.set(m.family, []);
    byFamily.get(m.family).push(m.name);
  }
  buildPicker({
    select: $('#f_material_pick'),
    input: form.elements.material,
    groups: [['Types you use', owned], ...byFamily.entries()],
    value,
    placeholder: 'Choose a type…',
    onPick: applyMaterialDefaults,
  });
}

function fillDatalist(id, values) {
  document.getElementById(id).innerHTML = values.map((v) => `<option value="${esc(v)}">`).join('');
}

// ── Remembering how you left the view ────────────────────────────────────────

const FILTERS_KEY = 'filters';

/**
 * The search box is deliberately excluded — a query is a momentary action, and
 * finding the library still filtered by something you typed days ago would look
 * like data had gone missing.
 */
function saveFilters() {
  const { status, brand, material, finish, sort } = state.filters;
  try {
    localStorage.setItem(FILTERS_KEY, JSON.stringify({ status, brand, material, finish, sort }));
  } catch { /* private mode, or storage full — not worth failing over */ }
}

function loadSavedFilters() {
  // Stored separately from the filters, so it has to be read before any of the
  // early returns below.
  const view = localStorage.getItem('view');
  if (VIEWS.includes(view)) state.view = view;

  let saved;
  try {
    saved = JSON.parse(localStorage.getItem(FILTERS_KEY) || 'null');
  } catch { return; }
  if (!saved || typeof saved !== 'object') return;

  const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  if (['active', 'new', 'opened', 'empty'].includes(saved.status)) state.filters.status = saved.status;
  if ([...el.sortBy.options].some((o) => o.value === saved.sort)) state.filters.sort = saved.sort;
  state.filters.brand = list(saved.brand);
  state.filters.material = list(saved.material);
  state.filters.finish = list(saved.finish);
}

/**
 * Drops selections for values the library no longer contains — otherwise
 * deleting the last Sunlu spool leaves you staring at an empty grid with no
 * obvious cause.
 */
function pruneFilters() {
  const all = state.allFilaments ?? [];
  if (!all.length) return;
  let changed = false;

  for (const [kind, field] of [['brand', 'brand'], ['material', 'material'], ['finish', 'finish']]) {
    const present = new Set(all.map((f) => f[field]).filter(Boolean));
    const kept = state.filters[kind].filter((v) => present.has(v));
    if (kept.length !== state.filters[kind].length) {
      state.filters[kind] = kept;
      changed = true;
    }
  }
  if (changed) { syncFilterButtons(); saveFilters(); }
}

/** Pushes restored filters back onto the controls that display them. */
function applyFiltersToUI() {
  el.sortBy.value = state.filters.sort;
  for (const b of el.statusFilter.children) {
    b.classList.toggle('on', b.dataset.status === state.filters.status);
  }
  syncFilterButtons();
  applyView();
}

// ── Card density ─────────────────────────────────────────────────────────────

const VIEWS = ['small', 'medium', 'large', 'list'];

function applyView() {
  el.grid.className = `grid view-${state.view}`;
  for (const b of $('#viewSwitch').children) {
    b.classList.toggle('on', b.dataset.view === state.view);
    b.setAttribute('aria-pressed', String(b.dataset.view === state.view));
  }
}

$('#viewSwitch').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-view]');
  if (!btn || btn.dataset.view === state.view) return;
  state.view = btn.dataset.view;
  try { localStorage.setItem('view', state.view); } catch { /* private mode */ }
  applyView();
  renderGrid();
});

// ── Multi-select filters ─────────────────────────────────────────────────────

/**
 * Options come from the inventory itself rather than the seed catalog — there's
 * no point offering to filter by a brand you don't own. Counts are computed
 * across the whole library so a filtered-out option still shows what it holds.
 */
const FILTER_KINDS = {
  brand:    { btn: 'brandFilterBtn',    noun: 'brands',   title: 'Filter by brand' },
  material: { btn: 'materialFilterBtn', noun: 'types',    title: 'Filter by type' },
  finish:   { btn: 'finishFilterBtn',   noun: 'finishes', title: 'Filter by finish' },
};

function tally(field) {
  const counts = new Map();
  for (const f of state.allFilaments ?? []) {
    if (!f[field]) continue;
    counts.set(f[field], (counts.get(f[field]) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([value, count]) => ({ value, count }));
}

const filterBtn = (kind) => document.getElementById(FILTER_KINDS[kind].btn);

function filterLabel(kind, selected) {
  const { noun } = FILTER_KINDS[kind];
  if (!selected.length) return `All ${noun}`;
  if (selected.length === 1) return selected[0];
  return `${selected.length} ${noun}`;
}

function syncFilterButtons() {
  for (const kind of Object.keys(FILTER_KINDS)) {
    const btn = filterBtn(kind);
    const selected = state.filters[kind];
    btn.querySelector('span').textContent = filterLabel(kind, selected);
    btn.classList.toggle('on', selected.length > 0);
  }
}

let pickerKind = null;

/**
 * Anchored dropdown on desktop, bottom sheet on narrow screens.
 *
 * The popover is physically moved into the active filter's wrapper so the
 * desktop positioning is just `position: absolute` against it — no coordinate
 * maths to keep in sync with scrolling or resizing.
 */
function openPicker(kind) {
  if (pickerKind === kind) return closePicker();
  closePicker();

  pickerKind = kind;
  $('#pickerTitle').textContent = FILTER_KINDS[kind].title;
  renderPickerOptions();

  const btn = filterBtn(kind);
  btn.closest('.filter-wrap').appendChild(el.picker);
  el.picker.hidden = false;
  el.picker.classList.remove('align-right');
  btn.setAttribute('aria-expanded', 'true');

  const wide = matchMedia('(min-width: 720px)').matches;
  $('#pickerScrim').hidden = wide;
  if (!wide) document.body.style.overflow = 'hidden';

  // Flip the dropdown when it would spill past the right edge.
  if (wide) {
    const box = el.picker.getBoundingClientRect();
    if (box.right > innerWidth - 8) el.picker.classList.add('align-right');
  }
}

function closePicker() {
  if (!pickerKind) return;
  filterBtn(pickerKind).setAttribute('aria-expanded', 'false');
  pickerKind = null;
  el.picker.hidden = true;
  $('#pickerScrim').hidden = true;
  releaseScrollLock();
}

function renderPickerOptions() {
  const options = tally(pickerKind);
  const selected = state.filters[pickerKind];
  const hint = $('#pickerHint');

  if (!options.length) {
    hint.textContent = 'Nothing in the library to filter by yet.';
    $('#pickerOptions').innerHTML = '';
    return;
  }
  hint.textContent = selected.length
    ? `${selected.length} selected — spools matching any of them are shown.`
    : 'Pick as many as you like.';

  $('#pickerOptions').innerHTML = options.map(({ value, count }) => `
    <button type="button" class="option-row" data-value="${esc(value)}"
            aria-pressed="${selected.includes(value)}">
      <span class="tick"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 13 4 4L19 7" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
      <span>${esc(value)}</span>
      <span class="count">${count}</span>
    </button>
  `).join('');
}

$('#pickerOptions').addEventListener('click', (e) => {
  const row = e.target.closest('.option-row');
  if (!row || !pickerKind) return;
  const value = row.dataset.value;
  const selected = state.filters[pickerKind];
  const at = selected.indexOf(value);
  if (at === -1) selected.push(value); else selected.splice(at, 1);
  renderPickerOptions();
  syncFilterButtons();
  saveFilters();
  loadFilaments();
});

$('#pickerClear').addEventListener('click', () => {
  if (!pickerKind) return;
  state.filters[pickerKind] = [];
  renderPickerOptions();
  syncFilterButtons();
  saveFilters();
  loadFilaments();
});

el.picker.addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) closePicker();
});
$('#pickerScrim').addEventListener('click', closePicker);

for (const kind of Object.keys(FILTER_KINDS)) {
  filterBtn(kind).addEventListener('click', () => openPicker(kind));
}

// Click-anywhere-else dismissal. The filter buttons handle their own toggling,
// so they're excluded rather than double-handled.
document.addEventListener('click', (e) => {
  if (!pickerKind) return;
  if (e.target.closest('#picker') || e.target.closest('.filter-btn')) return;
  closePicker();
});

addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && pickerKind) closePicker();
});

async function loadStats() {
  const s = await api('/api/filaments/stats');
  el.stats.innerHTML = `
    ${statCard('is-new', s.new, 'Sealed')}
    ${statCard('is-opened', s.opened, 'Opened')}
    ${statCard('', (s.active_grams / 1000).toFixed(1) + ' kg', 'On hand')}
    ${statCard('', s.empty, 'Used up')}
  `;
}

const statCard = (cls, value, label) =>
  `<div class="stat ${cls}"><b>${esc(value)}</b><span>${esc(label)}</span></div>`;

async function loadFilaments() {
  const p = new URLSearchParams();
  const { status, brand, material, finish, q, sort } = state.filters;
  if (status !== 'active') p.set('status', status);
  // The API takes these comma-separated and matches any of them.
  if (brand.length) p.set('brand', brand.join(','));
  if (material.length) p.set('material', material.join(','));
  if (finish.length) p.set('finish', finish.join(','));
  if (q) p.set('q', q);
  p.set('sort', sort);

  state.filaments = await api(`/api/filaments?${p}`);
  renderGrid();

  const active = brand.length || material.length || finish.length || q || status !== 'active';
  el.clearFilters.hidden = !active;
}

/** Unfiltered copy, so the filter sheets can list and count every option. */
async function loadAll() {
  state.allFilaments = await api('/api/filaments?include_empty=1&sort=brand');
}

let lastRefreshAt = 0;

async function refresh() {
  // The unfiltered list comes first so stale selections can be dropped before
  // they're used to query, rather than flashing an empty grid.
  await loadAll();
  pruneFilters();
  await loadFilaments();
  await Promise.all([loadStats(), loadCatalog()]);
  lastRefreshAt = Date.now();
}

/**
 * Re-reads the library when the app comes back to the foreground.
 *
 * An installed PWA isn't reloaded when you switch back to it — iOS resumes the
 * same page, so without this it keeps showing whatever was in memory when you
 * left, and edits made on another device never appear.
 */
async function refreshOnResume({ force = false } = {}) {
  if (!force && Date.now() - lastRefreshAt < 1500) return;
  try {
    await refresh();
    // Keep an open spool page in step too, unless something there is being
    // edited right now — re-rendering would yank the control out from under it.
    const openId = el.detail.open && el.detailBody.dataset.id;
    const busy = document.activeElement?.closest?.('#detail .remaining');
    if (openId && !busy) await showDetail(openId);
  } catch { /* offline: keep showing the last known state */ }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshOnResume();
});
addEventListener('pageshow', (e) => { if (e.persisted) refreshOnResume({ force: true }); });
addEventListener('online', () => refreshOnResume({ force: true }));
addEventListener('focus', () => refreshOnResume());

// ── Grid ─────────────────────────────────────────────────────────────────────

function renderGrid() {
  if (!state.filaments.length) {
    el.grid.innerHTML = `
      <div class="empty-state">
        ${spoolSVG({ color_hex: '#4a5262', remaining_pct: 0, status: 'empty' }, { title: false })
          .replace('style="width:100%;height:auto;display:block"', 'style="width:84px;height:84px;margin:0 auto 14px"')}
        <h3>Nothing here yet</h3>
        <p>${state.filters.q || state.filters.brand || state.filters.material || state.filters.status !== 'active'
          ? 'No spools match these filters.'
          : 'Tap <strong>Add</strong> to put your first spool in the library.'}</p>
      </div>`;
    return;
  }

  const spec = SECTIONS[state.filters.sort];
  if (!spec) {
    el.grid.innerHTML = groupFilaments(state.filaments).map(renderGroup).join('');
    return;
  }
  el.grid.innerHTML = sectionsOf(state.filaments, spec).map((s) => renderSection(s, spec)).join('');
}

/**
 * Base material for grouping: PLA+, PLA Silk and PLA-CF all belong under PLA,
 * PETG HF under PETG, TPU 95A under TPU. The card still shows the exact
 * variant — this only decides which heading it sits beneath.
 *
 * Longest-first so PETG wins over PET and PCTG over PC, and a boundary check so
 * an unrelated name that merely starts with those letters isn't swallowed.
 */
const BASE_TYPES = ['NYLON', 'PEEK', 'PETG', 'PCTG', 'HIPS', 'PLA', 'ABS', 'ASA', 'TPU', 'TPE', 'PVA', 'PC', 'PP', 'PA'];
const BASE_LABEL = { PA: 'Nylon', NYLON: 'Nylon' };

export function baseMaterial(name) {
  const raw = String(name ?? '').trim();
  if (!raw) return 'Not set';
  const upper = raw.toUpperCase();

  for (const base of BASE_TYPES) {
    if (!upper.startsWith(base)) continue;
    const next = upper[base.length];
    // Only a real boundary counts: "PLA+", "PLA-CF", "PLA Silk", "TPU 95A".
    if (next === undefined || /[\s+\-(0-9]/.test(next)) return BASE_LABEL[base] ?? base;
  }
  return raw;
}

/**
 * Sorting by an attribute also groups by it — scrolling a flat A–Z list past
 * forty spools to see what PETG you own isn't much use. Date orders stay flat,
 * since a heading per timestamp would be noise.
 */
const SECTIONS = {
  brand:    { label: (f) => f.brand?.trim() || 'Not set' },
  material: { label: (f) => baseMaterial(f.material) },
  color:    { label: (f) => f.color_name?.trim() || 'Not set', swatch: true },
};

function sectionsOf(filaments, spec) {
  const byLabel = new Map();
  for (const f of filaments) {
    const label = spec.label(f);
    if (!byLabel.has(label)) byLabel.set(label, { label, items: [], hex: f.color_hex });
    byLabel.get(label).items.push(f);
  }

  // Sorted rather than left in encounter order: variants of one base type can
  // arrive far apart (PA-CF sorts nowhere near "Nylon (PA)") and merge into a
  // heading that would otherwise sit in a surprising place.
  return [...byLabel.values()].sort((a, b) => {
    if (a.label === 'Not set') return 1;
    if (b.label === 'Not set') return -1;
    return a.label.localeCompare(b.label);
  });
}

function renderSection(section, spec) {
  const collapsed = state.collapsedSections.has(section.label);
  const swatch = spec.swatch
    ? `<span class="section-swatch" style="background:${
        isRainbow(section.label) ? RAINBOW_CSS : esc(section.hex || '#808080')}"></span>`
    : '';

  return `
    <button class="section-head${collapsed ? ' is-collapsed' : ''}"
            data-section="${esc(section.label)}" aria-expanded="${!collapsed}">
      <svg class="section-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      ${swatch}
      <span class="section-name">${esc(section.label)}</span>
      <span class="section-count">${section.items.length}</span>
    </button>
    ${collapsed ? '' : groupFilaments(section.items).map(renderGroup).join('')}`;
}

/**
 * Collapses interchangeable spools into one entry. Anything that would make you
 * pick one over another — a different color, or one already opened — keeps them
 * apart, so a stack is always "any of these will do".
 */
function groupFilaments(filaments) {
  const groups = new Map();
  for (const f of filaments) {
    // The key rides in a data- attribute, so it has to survive HTML parsing —
    // a NUL separator gets rewritten to U+FFFD and would never match again.
    // Percent-encoding keeps it ASCII and makes "|" safe as a separator, since
    // encodeURIComponent escapes any "|" inside the values themselves.
    const key = [f.brand, f.material, f.color_name, f.color_hex, f.status, f.spool_weight_g]
      .map((v) => encodeURIComponent(String(v ?? '').toLowerCase())).join('|');
    if (!groups.has(key)) groups.set(key, { key, items: [] });
    groups.get(key).items.push(f);
  }
  return [...groups.values()];
}

/**
 * One markup shape for every view. Which parts are visible is decided in CSS by
 * the class on the grid, so the grouping and stacking code below doesn't need to
 * know or care which density is active.
 */
function cardHTML(f) {
  const detail = [f.color_name || '—', f.finish].filter(Boolean).join(' · ');
  const grams = Math.round(f.spool_weight_g * f.remaining_pct / 100);
  const sub = [f.brand, f.color_name].filter(Boolean).join(' · ');

  return `
  <button class="card ${f.status === 'empty' ? 'is-empty' : ''}" data-id="${esc(f.id)}">
    <span class="badge ${esc(f.status)}">${esc(STATUS_LABEL[f.status])}</span>
    <div class="card-spool">
      ${spoolSVG(f)}
      <span class="card-overlay">
        <b>${esc(f.material)}</b>
        <span>${esc(sub)}</span>
      </span>
    </div>
    <div class="card-text">
      <span class="card-brand">${esc(f.brand)}</span>
      <span class="card-title">${esc(f.material)}</span>
      <span class="card-color">${esc(detail)}</span>
      <div class="card-extra">
        ${f.status === 'empty'
          ? `<span class="card-meta">Used up ${esc(fmtDate(f.finished_at))}</span>`
          : `<span class="card-bar"><i style="width:${f.remaining_pct}%"></i></span>
             <span class="card-meta">${f.remaining_pct}% left · ${grams} g</span>`}
        ${f.location ? `<span class="card-meta">${esc(f.location)}</span>` : ''}
      </div>
    </div>
  </button>`;
}

function renderGroup(group) {
  const [first] = group.items;
  const count = group.items.length;
  if (count === 1) return cardHTML(first);

  if (state.expandedGroups.has(group.key)) {
    return `
      <div class="group-header">
        <span>${count} × ${esc([first.brand, first.material, first.color_name].filter(Boolean).join(' '))}</span>
        <button type="button" data-collapse="${esc(group.key)}">Stack them back up</button>
      </div>
      ${group.items.map(cardHTML).join('')}`;
  }

  return `
    <div class="stack" data-expand="${esc(group.key)}">
      <span class="stack-layer l2"></span>
      <span class="stack-layer l1"></span>
      <span class="stack-count">×${count}</span>
      ${cardHTML(first)}
    </div>`;
}

el.grid.addEventListener('click', (e) => {
  const section = e.target.closest('[data-section]');
  if (section) {
    const label = section.dataset.section;
    if (state.collapsedSections.has(label)) state.collapsedSections.delete(label);
    else state.collapsedSections.add(label);
    renderGrid();
    return;
  }

  const collapse = e.target.closest('[data-collapse]');
  if (collapse) {
    state.expandedGroups.delete(collapse.dataset.collapse);
    renderGrid();
    return;
  }

  // A tap on a stack fans it out rather than opening a spool — which one you
  // got would otherwise be arbitrary.
  const stack = e.target.closest('[data-expand]');
  if (stack) {
    state.expandedGroups.add(stack.dataset.expand);
    renderGrid();
    return;
  }

  const card = e.target.closest('.card');
  if (card) showDetail(card.dataset.id, true);
});

// ── Detail ───────────────────────────────────────────────────────────────────

async function showDetail(id, push = false) {
  let f;
  try {
    f = await api(`/api/filaments/${encodeURIComponent(id)}`);
  } catch (err) {
    toast(err.message, true);
    return;
  }

  const spec = (label, value) => value == null || value === '' || value === '—'
    ? ''
    : `<div class="spec"><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`;

  const remainingG = Math.round(f.spool_weight_g * f.remaining_pct / 100);

  const statusAction = {
    new: `<button class="btn primary span2" data-act="open">
            <svg viewBox="0 0 24 24"><path d="M4 8h16v12H4zM4 8l2-4h12l2 4M12 8v12" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>
            Mark as opened</button>`,
    opened: `<button class="btn warn span2" data-act="empty">
            <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 12h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
            Mark as used up</button>`,
    empty: `<button class="btn primary span2" data-act="restore">
            <svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 1 0 2.5-5.8M4 4v4h4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            Put back in the library</button>`,
  }[f.status];

  const printable = state.print.mode !== 'off';

  el.detailBody.innerHTML = `
    <div class="sheet-head">
      <h2>${esc(nameOf(f))}</h2>
      <button type="button" class="icon-btn" data-close aria-label="Close">
        <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </button>
    </div>

    <div class="detail-hero">
      <div id="detailSpool">${spoolSVG(f)}</div>
      <div>
        <div class="detail-sub">${esc(f.color_name || 'No color set')}</div>
        <div class="chips">
          <span class="chip">${esc(STATUS_LABEL[f.status])}</span>
          ${f.finish ? `<span class="chip">${esc(f.finish)}</span>` : ''}
          ${f.status !== 'empty' ? `<span class="chip" id="remainingChip">${f.remaining_pct}% left · ~${remainingG} g</span>` : ''}
          <span class="chip">${esc(f.diameter)} mm</span>
          ${f.location ? `<span class="chip">${esc(f.location)}</span>` : ''}
        </div>
      </div>
    </div>

    <div class="action-grid">
      ${statusAction}
      <button class="btn" data-act="edit">
        <svg viewBox="0 0 24 24"><path d="M4 20h4L20 8l-4-4L4 16z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>
        Edit</button>
      <button class="btn" data-act="print" ${printable ? '' : 'disabled title="Set LABEL_RELAY_URL to enable printing"'}>
        <svg viewBox="0 0 24 24"><path d="M7 9V3h10v6M7 19H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2m-10 0v3h10v-6H7z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>
        Print QR</button>
      <button class="btn span2" data-act="duplicate">
        <svg viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        Add another sealed one</button>
      ${f.status === 'opened' ? `<button class="btn ghost span2" data-act="unopen">Actually, it's still sealed</button>` : ''}
    </div>

    ${f.status === 'opened' ? `
    <div class="remaining" data-weight="${f.spool_weight_g}">
      <div class="remaining-head">
        <b id="remainingValue">${f.remaining_pct}%</b>
        <span id="remainingGrams">roughly ${remainingG} g left</span>
      </div>
      <input type="range" id="remainingRange" min="0" max="100" step="5"
             value="${f.remaining_pct}" aria-label="How much filament is left">
      <div class="remaining-quick">
        ${[25, 50, 75, 100].map((v) => `
          <button type="button" data-pct="${v}" class="${f.remaining_pct === v ? 'on' : ''}">${v}%</button>
        `).join('')}
      </div>
    </div>` : ''}

    <dl class="spec-list">
      ${spec('Brand', f.brand)}
      ${spec('Type', f.material)}
      ${spec('Finish', f.finish)}
      ${spec('Spool', `${f.spool_weight_g} g`)}
      ${spec('Nozzle', f.nozzle_temp ? `${f.nozzle_temp} °C` : '')}
      ${spec('Bed', f.bed_temp ? `${f.bed_temp} °C` : '')}
      ${spec('Price', f.price != null ? f.price.toFixed(2) : '')}
      ${spec('Purchased', f.purchased_at ? fmtDate(f.purchased_at) : '')}
      ${spec('Opened', f.opened_at ? `${fmtDate(f.opened_at)} · ${ago(f.opened_at)}` : '')}
      ${spec('Used up', f.finished_at ? `${fmtDate(f.finished_at)} · ${ago(f.finished_at)}` : '')}
      ${spec('Added', fmtDate(f.created_at))}
      ${spec('ID', f.id)}
    </dl>

    ${f.notes ? `<div class="notes-block">${esc(f.notes)}</div>` : ''}

    <div class="qr-block">
      ${labelPreviewHTML(f, {
        size: state.print.size || '2x1',
        showText: state.print.show_text !== false,
        qrSrc: `/api/print/qr/${encodeURIComponent(f.id)}.svg`,
      })}
      <span class="qr-caption">${printable
        ? `This is roughly what prints — ${esc(state.print.size || '2x1')}″ label`
        : 'Scan this to open the spool on your phone'}</span>
      <code>${esc(state.print.base_url || location.origin)}/f/${esc(f.id)}</code>
    </div>

    <button class="btn danger wide" data-act="delete">Delete this record permanently</button>
  `;

  el.detailBody.dataset.id = f.id;
  state.currentFilament = f;
  if (!el.detail.open) openSheet(el.detail);
  el.detailBody.scrollTop = 0;

  if (push && location.pathname !== `/f/${f.id}`) {
    history.pushState({ id: f.id }, '', `/f/${f.id}`);
  }
}

el.detail.addEventListener('click', async (e) => {
  const quick = e.target.closest('.remaining-quick button');
  if (quick) {
    const pct = Number(quick.dataset.pct);
    $('#remainingRange').value = pct;
    paintRemaining(pct);
    saveRemaining(pct);
    return;
  }

  const btn = e.target.closest('[data-act], [data-close]');
  if (!btn) return;
  const id = el.detailBody.dataset.id;

  if (btn.hasAttribute('data-close')) return dismissDetail();

  const act = btn.dataset.act;

  if (act === 'edit') {
    const f = state.filaments.find((x) => x.id === id) || await api(`/api/filaments/${id}`);
    closeSheet(el.detail);
    openEditor(f);
    return;
  }

  if (act === 'print') {
    btn.disabled = true;
    try {
      await api(`/api/print/${encodeURIComponent(id)}`, { method: 'POST', body: {} });
      toast('QR label sent to the printer');
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
    }
    return;
  }

  if (act === 'duplicate') {
    btn.disabled = true;
    try {
      const copy = await api(`/api/filaments/${encodeURIComponent(id)}/duplicate`, {
        method: 'POST', body: {},
      });
      await refresh();
      // Jump to the new spool so it can be labelled straight away.
      await showDetail(copy.id, true);
      toast('Added another sealed spool');
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
    }
    return;
  }

  if (act === 'delete') {
    if (!confirm('Delete this record for good?\n\nIf the spool just ran out, use "Mark as used up" instead — that keeps the history.')) return;
    try {
      await api(`/api/filaments/${encodeURIComponent(id)}`, { method: 'DELETE' });
      dismissDetail();
      await refresh();
      toast('Record deleted');
    } catch (err) {
      toast(err.message, true);
    }
    return;
  }

  const endpoint = { open: 'open', empty: 'empty', restore: 'restore', unopen: 'unopen' }[act];
  if (!endpoint) return;

  try {
    await api(`/api/filaments/${encodeURIComponent(id)}/${endpoint}`, { method: 'POST', body: {} });
    await refresh();
    await showDetail(id);
    toast({
      open: 'Marked as opened',
      empty: 'Marked as used up — the record is kept',
      restore: 'Back in the library',
      unopen: 'Marked as sealed again',
    }[act]);
  } catch (err) {
    toast(err.message, true);
  }
});

// ── Remaining control ────────────────────────────────────────────────────────

/** Repaints the readout, chip and spool graphic without touching the network. */
function paintRemaining(pct) {
  const block = el.detailBody.querySelector('.remaining');
  if (!block) return;
  const grams = Math.round(Number(block.dataset.weight) * pct / 100);

  $('#remainingValue').textContent = `${pct}%`;
  $('#remainingGrams').textContent = `roughly ${grams} g left`;
  const chip = $('#remainingChip');
  if (chip) chip.textContent = `${pct}% left · ~${grams} g`;

  for (const b of block.querySelectorAll('.remaining-quick button')) {
    b.classList.toggle('on', Number(b.dataset.pct) === pct);
  }

  const spool = $('#detailSpool');
  if (spool && state.currentFilament) {
    spool.innerHTML = spoolSVG({ ...state.currentFilament, remaining_pct: pct });
  }
}

let remainingSaveTimer;
function saveRemaining(pct) {
  clearTimeout(remainingSaveTimer);
  // Dragging fires continuously; only the value you settle on is worth a write.
  remainingSaveTimer = setTimeout(async () => {
    const id = el.detailBody.dataset.id;
    try {
      await api(`/api/filaments/${encodeURIComponent(id)}`, {
        method: 'PATCH', body: { remaining_pct: pct },
      });
      await Promise.all([loadFilaments(), loadStats()]);
    } catch (err) {
      toast(err.message, true);
    }
  }, 350);
}

el.detail.addEventListener('input', (e) => {
  if (e.target.id === 'remainingRange') paintRemaining(Number(e.target.value));
});

el.detail.addEventListener('change', (e) => {
  if (e.target.id === 'remainingRange') saveRemaining(Number(e.target.value));
});

function dismissDetail() {
  closeSheet(el.detail);
  if (location.pathname.startsWith('/f/')) history.pushState({}, '', '/');
}

el.detail.addEventListener('cancel', (e) => {
  e.preventDefault();
  dismissDetail();
});

// ── Editor ───────────────────────────────────────────────────────────────────

const form = el.editorForm;

/**
 * What the Add button does — plain save, or save and queue a label. Persisted,
 * because whichever you did last is almost always what you want next.
 */
let saveMode = localStorage.getItem('saveMode') === 'print' ? 'print' : 'save';
let submitIntent = saveMode;

const ICON_PLUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';
const ICON_PRINT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 9V3h10v6M7 19H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2m-10 0v3h10v-6H7z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';

function syncSaveButton() {
  const editing = Boolean(state.editingId);
  const printable = state.print.mode !== 'off';
  // Printing an edit doesn't make sense here — the spool's own page does that.
  const showSplit = !editing && printable;

  $('#saveModeBtn').hidden = !showSplit;
  if (!showSplit) closeSaveMenu();

  // Short labels: the full wording lives in the menu, where there's room. On a
  // phone "Add and print QR" wrapped onto a second line inside the button.
  if (editing) {
    el.saveBtn.innerHTML = '<span>Save changes</span>';
  } else if (showSplit && saveMode === 'print') {
    // One icon, not two — a plus and a printer together crowded the label into
    // an ellipsis on a phone. The menu carries both icons for disambiguation.
    el.saveBtn.innerHTML = `${ICON_PRINT}<span>Add &amp; print</span>`;
  } else {
    el.saveBtn.innerHTML = `${ICON_PLUS}<span>Add to library</span>`;
  }

  for (const item of $('#saveMenu').querySelectorAll('button[data-mode]')) {
    item.setAttribute('aria-checked', String(item.dataset.mode === saveMode));
  }
  submitIntent = showSplit ? saveMode : 'save';
}

function closeSaveMenu() {
  $('#saveMenu').hidden = true;
  $('#saveModeBtn').setAttribute('aria-expanded', 'false');
}

$('#saveModeBtn').addEventListener('click', () => {
  const menu = $('#saveMenu');
  menu.hidden = !menu.hidden;
  $('#saveModeBtn').setAttribute('aria-expanded', String(!menu.hidden));
});

$('#saveMenu').addEventListener('click', (e) => {
  const item = e.target.closest('button[data-mode]');
  if (!item) return;
  saveMode = item.dataset.mode;
  localStorage.setItem('saveMode', saveMode);
  closeSaveMenu();
  syncSaveButton();
  // Picking an action performs it — that's what a split button is for.
  form.requestSubmit(el.saveBtn);
});

// Any tap outside the menu dismisses it.
document.addEventListener('click', (e) => {
  if ($('#saveMenu').hidden) return;
  if (e.target.closest('#saveSplit')) return;
  closeSaveMenu();
});

el.saveBtn.addEventListener('click', () => { submitIntent = state.editingId ? 'save' : saveMode; });

/** Queues one label per spool. Sequential — the relay accepts 10 jobs a minute. */
async function printLabelsFor(ids) {
  let sent = 0;
  let firstError = null;
  for (const id of ids) {
    try {
      await api(`/api/print/${encodeURIComponent(id)}`, { method: 'POST', body: {} });
      sent++;
    } catch (err) {
      firstError ??= err.message;
    }
  }
  return { sent, firstError };
}

function setField(name, value) {
  const input = form.elements[name];
  if (input) input.value = value ?? '';
}

function openEditor(filament = null) {
  state.editingId = filament?.id ?? null;
  el.editorTitle.textContent = filament ? 'Edit spool' : 'Add filament';
  el.editorError.hidden = true;
  $('#quantityField').hidden = Boolean(filament);
  closeSaveMenu();
  syncSaveButton();

  form.reset();
  const f = filament ?? {};
  refreshBrandPicker(f.brand ?? '');
  refreshMaterialPicker(f.material ?? '');
  $('#materialHint').textContent = '';
  fillFinishSelect();
  setField('finish', f.finish ?? '');
  setField('color_hex2', f.color_hex2 ?? '');
  setField('color_hex3', f.color_hex3 ?? '');
  syncFinishHint();
  syncExtraColors();
  setField('color_name', f.color_name);
  setField('color_hex', f.color_hex || '#808080');
  setField('status', f.status || 'new');
  setField('spool_weight_g', f.spool_weight_g ?? 1000);
  // How much is left is adjusted on the spool's own page, not here — but the
  // preview should still show the spool at its real fullness while editing.
  editorRemaining = f.remaining_pct ?? 100;
  setField('diameter', f.diameter ?? 1.75);
  setField('price', f.price ?? '');
  setField('nozzle_temp', f.nozzle_temp ?? '');
  setField('bed_temp', f.bed_temp ?? '');
  setField('location', f.location);
  setField('notes', f.notes);
  setField('purchased_at', f.purchased_at ? f.purchased_at.slice(0, 10) : '');
  clampQuantity(1);
  syncEditorRemaining();

  syncColorText();
  syncPreview();
  openSheet(el.editor);
  el.editor.querySelector('.sheet-inner').scrollTop = 0;
}

$('#addBtn').addEventListener('click', () => openEditor());

el.editor.addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) closeSheet(el.editor);
});
el.editor.addEventListener('cancel', () => closeSheet(el.editor));

// Live preview + dependent fields
function currentDraft() {
  return {
    brand: form.elements.brand.value.trim(),
    material: form.elements.material.value.trim(),
    color_name: form.elements.color_name.value.trim(),
    color_hex: form.elements.color_hex.value,
    color_hex2: form.elements.color_hex2.value,
    color_hex3: form.elements.color_hex3.value,
    finish: form.elements.finish.value,
    status: form.elements.status.value,
    remaining_pct: editorRemaining,
  };
}

function syncPreview() {
  const d = currentDraft();
  $('#editorPreview').innerHTML = spoolSVG(d, { title: false });
  $('#previewName').textContent = [d.brand, d.material].filter(Boolean).join(' ') || 'New spool';
  $('#previewSub').textContent = [d.color_name, d.finish, STATUS_LABEL[d.status]].filter(Boolean).join(' · ');
}

function syncColorText() {
  const hex = form.elements.color_hex.value.toUpperCase();
  $('#f_color_hex_text').value = hex;
  for (const sw of document.querySelectorAll('.swatch')) {
    sw.setAttribute('aria-pressed', String(sw.dataset.hex.toUpperCase() === hex));
  }
}

/** Fullness shown in the editor's preview spool. */
let editorRemaining = 100;

/**
 * The slider is only offered while adding — an existing spool's level is
 * adjusted on its own page, and having it in two places invites them to
 * disagree.
 */
function syncEditorRemaining() {
  const adding = !state.editingId;
  const opened = form.elements.status.value === 'opened';
  $('#remainingField').hidden = !(adding && opened);

  form.elements.remaining_pct.value = editorRemaining;
  $('#remainingOut').textContent = `${editorRemaining}%`;
  for (const b of $('#editorRemainingQuick').querySelectorAll('button')) {
    b.classList.toggle('on', Number(b.dataset.pct) === editorRemaining);
  }
}

form.elements.remaining_pct.addEventListener('input', (e) => {
  editorRemaining = Number(e.target.value);
  syncEditorRemaining();
  syncPreview();
});

$('#editorRemainingQuick').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-pct]');
  if (!btn) return;
  editorRemaining = Number(btn.dataset.pct);
  syncEditorRemaining();
  syncPreview();
});

function renderSwatches() {
  $('#swatches').innerHTML = state.catalog.colors.map((c) => {
    // Multi-color stock can't be shown as one flat chip.
    const background = c.rainbow ? RAINBOW_CSS : esc(c.hex);
    const pale = !c.rainbow && luminance(c.hex) > 0.8;
    return `
      <button type="button" class="swatch" data-hex="${esc(c.hex)}" data-name="${esc(c.name)}"
              title="${esc(c.name)}" aria-label="${esc(c.name)}" aria-pressed="false"
              style="background:${background}${pale ? ';border-color:var(--muted)' : ''}"></button>`;
  }).join('');
  syncColorText();
}

$('#swatches').addEventListener('click', (e) => {
  const sw = e.target.closest('.swatch');
  if (!sw) return;
  form.elements.color_hex.value = sw.dataset.hex;
  // Always renames. Leaving the old name behind after picking a new swatch was
  // the bug — you'd end up with a spool labelled Red that renders blue.
  form.elements.color_name.value = sw.dataset.name;
  syncColorText();
  syncPreview();
});

// ── Color name lookup ────────────────────────────────────────────────────────

/**
 * Resolves a typed color name to a hex.
 *
 * Exact match first, then the longest known color word appearing inside the
 * string, so "Galaxy Black" and "Matte Sky Blue" still land somewhere sensible.
 * Word boundaries are required — otherwise "Redwood" would resolve as red.
 */
const normColor = (s) => String(s).toLowerCase().replace(/[\s_-]+/g, ' ').trim();

function hexForColorName(input) {
  const target = normColor(input ?? '');
  if (!target) return null;

  const names = Object.entries(state.catalog.color_names ?? {});

  for (const [name, hex] of names) {
    if (normColor(name) === target) return hex;
  }

  // Longest containing match wins, so "Dark Sea Green" beats "Green".
  let bestLength = 0;
  let bestHex = null;
  for (const [name, hex] of names) {
    const n = normColor(name);
    if (n.length <= bestLength) continue;
    if (new RegExp(`(^| )${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`).test(target)) {
      bestLength = n.length;
      bestHex = hex;
    }
  }
  return bestHex;
}

/** Typing a recognised color name repaints the swatch as you go. */
form.elements.color_name.addEventListener('input', () => {
  const hex = hexForColorName(form.elements.color_name.value);
  if (hex) {
    form.elements.color_hex.value = hex;
    syncColorText();
  }
  syncPreview();
});

$('#f_color_hex_text').addEventListener('input', (e) => {
  let v = e.target.value.trim();
  if (!v.startsWith('#')) v = `#${v}`;
  if (/^#[0-9a-fA-F]{6}$/.test(v)) {
    form.elements.color_hex.value = v;
    syncPreview();
    syncColorText();
  }
});

form.elements.color_hex.addEventListener('input', () => { syncColorText(); syncPreview(); });
form.elements.status.addEventListener('change', () => {
  // A sealed spool is full and a used-up one is empty, by definition.
  const status = form.elements.status.value;
  if (status === 'new') editorRemaining = 100;
  if (status === 'empty') editorRemaining = 0;
  syncEditorRemaining();
  syncPreview();
});
// Brand and material update the preview through their pickers; the color name
// field has its own listener that also resolves the swatch.

function syncFinishHint() {
  const match = (state.catalog.finishes ?? []).find((f) => f.name === form.elements.finish.value);
  $('#finishHint').textContent = match?.blurb ?? '';
}

// ── Extra colors ─────────────────────────────────────────────────────────────

/** Finishes that actually do something with more than one tone. */
const MULTI_TONE = new Set(['gradient', 'dual']);

function currentEffect() {
  return effectFor(form.elements.finish.value);
}

function syncExtraColors() {
  const effect = currentEffect();
  const multi = MULTI_TONE.has(effect);
  $('#extraColorsField').hidden = !multi;
  if (!multi) return;

  $('#extraColorsHint').textContent = effect === 'gradient'
    ? 'The spool blends between these, in order.'
    : 'The spool is split into a wedge per color.';

  const slots = [2, 3];
  $('#extraColors').innerHTML = slots.map((n) => {
    const value = form.elements[`color_hex${n}`].value;
    if (!value) {
      // The third slot only appears once the second is in use.
      if (n === 3 && !form.elements.color_hex2.value) return '';
      return `<button type="button" class="extra-add" data-add="${n}">＋ ${n === 2 ? 'Second' : 'Third'} color</button>`;
    }
    return `
      <span class="extra-color">
        <input type="color" value="${esc(value)}" data-slot="${n}" aria-label="Extra color ${n - 1}">
        <button type="button" data-remove="${n}" aria-label="Remove this color">✕</button>
      </span>`;
  }).join('');
}

$('#extraColors').addEventListener('click', (e) => {
  const add = e.target.closest('[data-add]');
  if (add) {
    // Seeded from the base color so the first drag is an adjustment, not a
    // jump from some arbitrary default.
    form.elements[`color_hex${add.dataset.add}`].value = form.elements.color_hex.value;
    syncExtraColors();
    syncPreview();
    return;
  }
  const remove = e.target.closest('[data-remove]');
  if (remove) {
    form.elements[`color_hex${remove.dataset.remove}`].value = '';
    // Dropping the second tone drops the third with it — a gradient can't skip.
    if (remove.dataset.remove === '2') form.elements.color_hex3.value = '';
    syncExtraColors();
    syncPreview();
  }
});

$('#extraColors').addEventListener('input', (e) => {
  const slot = e.target.dataset?.slot;
  if (!slot) return;
  form.elements[`color_hex${slot}`].value = e.target.value;
  syncPreview();
});

form.elements.finish.addEventListener('change', () => {
  syncFinishHint();
  syncExtraColors();
  syncPreview();
});

/** Picking a known material pre-fills its typical temps and flags drying/enclosure. */
function applyMaterialDefaults(value) {
  const match = state.catalog.materials.find(
    (m) => m.name.toLowerCase() === String(value).trim().toLowerCase(),
  );
  const hint = $('#materialHint');
  if (!match) { hint.textContent = ''; return; }

  if (match.nozzle && !form.elements.nozzle_temp.value) form.elements.nozzle_temp.value = match.nozzle;
  if (match.bed && !form.elements.bed_temp.value) form.elements.bed_temp.value = match.bed;

  hint.textContent = [
    match.nozzle ? `Typical ${match.nozzle}°C nozzle / ${match.bed}°C bed` : '',
    match.enclosure ? 'prefers an enclosure' : '',
    match.dry ? 'keep it dry' : '',
  ].filter(Boolean).join(' · ');
}

// ── Quantity stepper ─────────────────────────────────────────────────────────

const quantityInput = form.elements.quantity;

function clampQuantity(next) {
  const min = Number(quantityInput.min) || 1;
  const max = Number(quantityInput.max) || 20;
  const value = Math.min(max, Math.max(min, Number(next) || min));
  quantityInput.value = value;
  for (const btn of document.querySelectorAll('.stepper button')) {
    const step = Number(btn.dataset.step);
    btn.disabled = (step < 0 && value <= min) || (step > 0 && value >= max);
  }
  return value;
}

document.querySelector('.stepper').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-step]');
  if (btn) clampQuantity(Number(quantityInput.value) + Number(btn.dataset.step));
});
quantityInput.addEventListener('input', () => {
  // Let the field be briefly empty while typing rather than fighting the user.
  if (quantityInput.value !== '') clampQuantity(quantityInput.value);
});
quantityInput.addEventListener('blur', () => clampQuantity(quantityInput.value));

/**
 * A field the browser can't focus (one inside the collapsed "More details"
 * section) makes constraint validation fail with no visible feedback — so
 * reveal it and say what's wrong.
 */
form.addEventListener('invalid', (e) => {
  const details = e.target.closest('details');
  if (details && !details.open) details.open = true;
  // A hidden control can't be focused, so the browser would reject the submit
  // with nothing on screen to explain why.
  if (e.target.hidden) e.target.hidden = false;

  const label = e.target.closest('.field')?.querySelector('label')?.textContent?.trim();
  el.editorError.textContent = `${label || 'A field'}: ${e.target.validationMessage}`;
  el.editorError.hidden = false;
}, true);

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  el.editorError.hidden = true;
  el.saveBtn.disabled = true;
  $('#saveModeBtn').disabled = true;

  const data = Object.fromEntries(new FormData(form).entries());
  // Editing never sends a level — that belongs to the spool's own page, and a
  // stale value from this form would silently overwrite it. On create the
  // server reconciles it against the status anyway.
  if (state.editingId) delete data.remaining_pct;

  try {
    if (state.editingId) {
      await api(`/api/filaments/${encodeURIComponent(state.editingId)}`, { method: 'PATCH', body: data });
      closeSheet(el.editor);
      await refresh();
      await showDetail(state.editingId);
      toast('Spool updated');
    } else {
      const created = await api('/api/filaments', { method: 'POST', body: data });
      const list = Array.isArray(created) ? created : [created];
      const added = list.length === 1 ? 'Spool added' : `${list.length} spools added`;
      closeSheet(el.editor);
      await refresh();

      if (submitIntent !== 'print') {
        toast(added);
      } else {
        // Each spool gets its own QR, so a batch gets a label each.
        toast(`${added} — sending ${list.length === 1 ? 'label' : 'labels'}…`);
        const { sent, firstError } = await printLabelsFor(list.map((f) => f.id));
        if (firstError) {
          toast(`${added}, but ${list.length - sent} of ${list.length} labels failed: ${firstError}`, true);
        } else {
          toast(`${added} · ${sent === 1 ? 'label sent' : `${sent} labels sent`}`);
        }
      }
    }
  } catch (err) {
    el.editorError.textContent = err.message;
    el.editorError.hidden = false;
  } finally {
    el.saveBtn.disabled = false;
    $('#saveModeBtn').disabled = false;
  }
});

// ── Filters ──────────────────────────────────────────────────────────────────

el.statusFilter.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-status]');
  if (!btn) return;
  for (const b of el.statusFilter.children) b.classList.toggle('on', b === btn);
  state.filters.status = btn.dataset.status;
  saveFilters();
  loadFilaments();
});

let searchTimer;
el.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.filters.q = el.search.value.trim();
    loadFilaments();
  }, 220);
});

el.sortBy.addEventListener('change', () => {
  state.filters.sort = el.sortBy.value;
  // Headings from the previous grouping mean nothing under the new one.
  state.collapsedSections.clear();
  saveFilters();
  loadFilaments();
});

el.clearFilters.addEventListener('click', () => {
  state.filters = { status: 'active', brand: [], material: [], finish: [], q: '', sort: el.sortBy.value };
  el.search.value = '';
  state.collapsedSections.clear();
  applyFiltersToUI();
  saveFilters();
  loadFilaments();
});

// ── QR scanning ──────────────────────────────────────────────────────────────

let scanner = null;

async function openScanner() {
  const blocked = cameraBlockedReason();
  $('#scanError').hidden = true;
  $('#scanStatus').textContent = 'Point the camera at the QR code on a spool.';
  openSheet(el.scanner);

  if (blocked) {
    $('#scanError').textContent = blocked;
    $('#scanError').hidden = false;
    return;
  }

  scanner = new QrScanner($('#scanVideo'), onScanned);
  try {
    await scanner.start();
    setupZoom();
    setupMacro();
    // Surfaced because frame size is the difference between reading a label and
    // not — worth being able to see what the camera actually gave us.
    $('#scanDiag').textContent = `Camera ${scanner.resolution}`;
  } catch (err) {
    const denied = err.name === 'NotAllowedError' || err.name === 'SecurityError';
    $('#scanError').textContent = denied
      ? 'Camera access was blocked. Allow it for this site in your browser settings, then try again.'
      : `Could not start the camera (${err.name || 'unknown error'}).`;
    $('#scanError').hidden = false;
    stopScanner();
  }
}

/**
 * Optical zoom, where the camera exposes it. This is the practical answer to a
 * phone not being able to focus close enough: stand back far enough to be sharp
 * and zoom in so the code still fills the frame.
 */
function setupZoom() {
  const row = $('#scanZoom');
  const range = $('#scanZoomRange');
  const caps = scanner?.zoomRange;

  row.hidden = !caps;
  if (!caps) return;

  const start = scanner.defaultZoom;
  range.min = caps.min;
  range.max = Math.min(caps.max, Math.max(start * 6, caps.min * 6));
  range.step = caps.step || 0.1;
  range.value = start;
  $('#scanZoomOut').textContent = `${Number(start).toFixed(1)}×`;
}

$('#scanZoomRange').addEventListener('input', (e) => {
  $('#scanZoomOut').textContent = `${Number(e.target.value).toFixed(1)}×`;
  scanner?.setZoom(e.target.value);
});

/**
 * The ultra-wide is on by default where it exists — it's the only rear lens
 * that focuses close enough for a sticker-sized code, and it's what the native
 * camera app quietly switches to.
 */
function setupMacro() {
  const btn = $('#scanMacroBtn');
  btn.hidden = !scanner?.macroAvailable;
  btn.setAttribute('aria-pressed', String(Boolean(scanner?.usingMacro)));
  $('#scanStatus').textContent = scanner?.usingMacro
    ? 'Hold the label a few centimetres away and fill the box.'
    : 'Hold the label about 15–20 cm away and fill the box.';
  $('#scanLens').textContent = scanner?.lenses?.length
    ? `Lens: ${scanner.usingMacro ? scanner.macroLens.label : 'default rear camera'}`
    : '';
}

$('#scanMacroBtn').addEventListener('click', async () => {
  if (!scanner) return;
  const btn = $('#scanMacroBtn');
  btn.disabled = true;
  await scanner.setMacro(!scanner.usingMacro);
  setupZoom();
  setupMacro();
  $('#scanDiag').textContent = `Camera ${scanner.resolution}`;
  btn.disabled = false;
});

$('#scanRefocus').addEventListener('click', async () => {
  if (!scanner) return;
  $('#scanStatus').textContent = 'Refocusing…';
  await scanner.refocus();
  setTimeout(setupMacro, 900);
});

function stopScanner() {
  scanner?.stop();
  scanner = null;
  $('#scanZoom').hidden = true;
  $('#scanMacroBtn').hidden = true;
  $('#scanDiag').textContent = '';
  $('#scanLens').textContent = '';
}

async function onScanned(value) {
  const id = filamentIdFrom(value);
  if (!id) {
    // Keep scanning — they may just have caught something else in frame.
    $('#scanStatus').textContent = "That isn't a filament code. Still looking…";
    scanner?.tick();
    return;
  }

  try {
    await api(`/api/filaments/${encodeURIComponent(id)}`);
  } catch {
    $('#scanStatus').textContent = `Scanned ${id}, but there's no such spool in the library. Still looking…`;
    scanner?.tick();
    return;
  }

  if (navigator.vibrate) navigator.vibrate(40);
  stopScanner();
  closeSheet(el.scanner);
  showDetail(id, true);
}

$('#scanBtn').addEventListener('click', openScanner);
el.scanner.addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) closeSheet(el.scanner);
});
el.scanner.addEventListener('close', stopScanner);
el.scanner.addEventListener('cancel', (e) => { e.preventDefault(); closeSheet(el.scanner); });

// ── Theme ────────────────────────────────────────────────────────────────────

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('theme', theme);
}
applyTheme(
  localStorage.getItem('theme') ||
  (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'),
);
$('#themeBtn').addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
});

// ── Routing ──────────────────────────────────────────────────────────────────

function routeFromPath() {
  const match = /^\/f\/([^/]+)$/.exec(location.pathname);
  if (match) showDetail(decodeURIComponent(match[1]));
  else if (el.detail.open) closeSheet(el.detail);
}

addEventListener('popstate', routeFromPath);

// ── Boot ─────────────────────────────────────────────────────────────────────

(async function boot() {
  // Shown unconditionally: if the camera turns out to be unavailable the
  // scanner sheet explains why, which beats a button that silently isn't there.
  $('#scanBtn').hidden = false;

  loadSavedFilters();
  applyFiltersToUI();

  try {
    state.print = await api('/api/print/status');
  } catch { /* printing stays disabled */ }

  try {
    await refresh();
    routeFromPath();
  } catch (err) {
    el.grid.innerHTML = `<div class="empty-state"><h3>Can't reach the server</h3><p>${esc(err.message)}</p></div>`;
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* offline shell is optional */ });
  }
})();
