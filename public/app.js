import { spoolSVG, escapeXML as esc, luminance, RAINBOW_CSS, isRainbow, effectFor } from './spool.js';
import { labelPreviewHTML } from './label.js';
import { QrScanner, StillCamera, cameraBlockedReason, filamentIdFrom } from './scan.js';

// ── State ────────────────────────────────────────────────────────────────────

const state = {
  filaments: [],
  catalog: { brands: [], materials: [], colors: [], locations: [] },
  print: { mode: 'off' },
  labelScan: false,
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
  labelScanner: $('#labelScanner'),
  settings: $('#settings'),
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
const SHEETS = [el.detail, el.editor, el.scanner, el.labelScanner, el.settings];

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
  if (dialog === el.labelScanner) stopLabelCamera();
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

/**
 * A text field that filters a grouped list as you type.
 *
 * The input *is* the form field, so anything typed counts whether or not it
 * matches — which is the point once the brand list runs to three hundred names
 * and a dropdown becomes a thing you scroll rather than read. The old control
 * was a <select> plus a hidden "Something else" input; that was workable at
 * forty brands and unusable at this many, especially on a phone, where a long
 * <select> is a spinning wheel.
 *
 * `groups` is a function rather than a list because the contents move while the
 * editor is open — adding a spool of a new brand should offer it next time
 * without rebuilding the control.
 */
function wireCombo({ input, groups, onPick }) {
  const combo = input.closest('.combo');
  const list = combo.querySelector('.combo-list');
  const toggle = combo.querySelector('.combo-toggle');
  let active = -1;
  let options = [];

  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  };

  /** Highlights the matched run, on text that's already been escaped. */
  function mark(text, query) {
    const at = query ? text.toLowerCase().indexOf(query) : -1;
    if (at === -1) return esc(text);
    return esc(text.slice(0, at))
      + `<mark>${esc(text.slice(at, at + query.length))}</mark>`
      + esc(text.slice(at + query.length));
  }

  function render() {
    const query = input.value.trim().toLowerCase();
    const seen = new Set();
    options = [];
    let html = '';

    for (const [label, items] of groups()) {
      const hits = [];
      for (const item of items) {
        if (!item || seen.has(item.toLowerCase())) continue;
        const at = item.toLowerCase().indexOf(query);
        if (query && at === -1) continue;
        seen.add(item.toLowerCase());
        hits.push({ item, at });
      }
      if (!hits.length) continue;

      // Names starting with what you typed come first: "PET" should offer PETG
      // before PCTG, which only contains those letters further along.
      hits.sort((a, b) => (a.at - b.at) || a.item.localeCompare(b.item));

      html += `<li class="combo-group" role="presentation">${esc(label)}</li>`;
      for (const { item } of hits) {
        html += `<li class="combo-option" role="option" id="${combo.dataset.combo}-opt-${options.length}"
                     aria-selected="false" data-value="${esc(item)}">${mark(item, query)}</li>`;
        options.push(item);
      }
    }

    if (!options.length) {
      html = `<li class="combo-empty" role="presentation">${
        query ? 'Nothing matches — it will be saved exactly as you typed it'
              : 'Nothing to suggest yet — type a name'}</li>`;
    }

    list.innerHTML = html;
    active = -1;
    list.scrollTop = 0;
  }

  const open = () => {
    render();
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  };

  function highlight(next) {
    if (!options.length) return;
    active = (next + options.length) % options.length;
    const rows = list.querySelectorAll('.combo-option');
    rows.forEach((row, i) => row.setAttribute('aria-selected', String(i === active)));
    const row = rows[active];
    if (row) {
      input.setAttribute('aria-activedescendant', row.id);
      row.scrollIntoView({ block: 'nearest' });
    }
  }

  function choose(value) {
    input.value = value;
    close();
    onPick?.(value);
    syncPreview();
  }

  input.addEventListener('input', () => {
    open();
    // Fires on every keystroke, as it did before: what's typed is the value,
    // matched or not.
    onPick?.(input.value);
    syncPreview();
  });
  input.addEventListener('focus', open);

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (list.hidden) return open();
      return highlight(active + (e.key === 'ArrowDown' ? 1 : -1));
    }
    if (e.key === 'Enter' && !list.hidden) {
      // Only swallowed when it's picking something, so Enter still submits the
      // form the rest of the time.
      if (active >= 0) { e.preventDefault(); choose(options[active]); }
      else close();
      return;
    }
    if (e.key === 'Escape' && !list.hidden) { e.preventDefault(); close(); }
    if (e.key === 'Tab') close();
  });

  // mousedown, not click: the input blurs first otherwise and the list is gone
  // before the click lands.
  list.addEventListener('mousedown', (e) => {
    const row = e.target.closest('.combo-option');
    if (!row) return;
    e.preventDefault();
    choose(row.dataset.value);
  });

  toggle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    if (list.hidden) { input.focus(); open(); } else close();
  });

  input.addEventListener('blur', () => {
    // Deferred so a pick on the list still registers.
    setTimeout(close, 120);
  });

  return { close };
}

let brandCombo;
let materialCombo;

function refreshBrandPicker(value = '') {
  const groups = () => {
    const owned = state.catalog.owned_brands ?? [];
    const rest = (state.catalog.brands ?? []).filter(
      (b) => !owned.some((o) => o.toLowerCase() === b.toLowerCase()),
    );
    return [['Brands you own', owned], ['All brands', rest]];
  };

  brandCombo ??= wireCombo({ input: form.elements.brand, groups });
  brandCombo.close();
  form.elements.brand.value = value || '';
}

function refreshMaterialPicker(value = '') {
  const groups = () => {
    const owned = [...new Set(state.filaments.map((f) => f.material))].filter(Boolean).sort();
    const byFamily = new Map();
    for (const m of state.catalog.materials ?? []) {
      if (owned.some((o) => o.toLowerCase() === m.name.toLowerCase())) continue;
      if (!byFamily.has(m.family)) byFamily.set(m.family, []);
      byFamily.get(m.family).push(m.name);
    }
    return [['Types you use', owned], ...byFamily.entries()];
  };

  materialCombo ??= wireCombo({
    input: form.elements.material, groups, onPick: applyMaterialDefaults,
  });
  materialCombo.close();
  form.elements.material.value = value || '';
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

function syncPickerHint() {
  const selected = state.filters[pickerKind] ?? [];
  $('#pickerHint').textContent = selected.length
    ? `${selected.length} selected — spools matching any of them are shown.`
    : 'Pick as many as you like.';
}

function renderPickerOptions() {
  const options = tally(pickerKind);
  const selected = state.filters[pickerKind];

  if (!options.length) {
    $('#pickerHint').textContent = 'Nothing in the library to filter by yet.';
    $('#pickerOptions').innerHTML = '';
    return;
  }
  syncPickerHint();

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

  /*
   * Toggled in place rather than by re-rendering the list. Replacing the HTML
   * would detach the row mid-click, and the outside-click handler below would
   * then find no #picker ancestor on the event target and close the popover —
   * so picking one option dismissed the whole thing. Editing the row also keeps
   * the list from scrolling back to the top on every tap.
   */
  row.setAttribute('aria-pressed', String(at === -1));
  syncPickerHint();

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

  /*
   * composedPath() is captured when the event is dispatched, so it still holds
   * the real ancestors even if a handler further down removed the target from
   * the DOM first. Walking up from e.target instead would treat a click on
   * anything the popover replaced as a click outside it.
   */
  const path = e.composedPath?.() ?? [];
  const insidePicker = path.includes(el.picker) || e.target.closest?.('#picker');
  const onFilterButton = path.some((n) => n?.classList?.contains?.('filter-btn'))
    || e.target.closest?.('.filter-btn');

  if (insidePicker || onFilterButton) return;
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
    ${statCard('', formatKg(s.active_grams), 'On hand', 'kg')}
    ${statCard('', s.empty, 'Used up')}
  `;
}

/** A decimal is useful at 40.1 kg and just noise at 140 kg. */
const formatKg = (grams) => {
  const kg = grams / 1000;
  return kg >= 100 ? Math.round(kg).toString() : kg.toFixed(1);
};

/**
 * The unit is a separate, smaller element rather than part of the value, so it
 * can sit alongside the number instead of wrapping onto its own line and making
 * this card taller than the three beside it.
 */
const statCard = (cls, value, label, unit = '') =>
  `<div class="stat ${cls}">
     <b>${esc(value)}${unit ? `<i>${esc(unit)}</i>` : ''}</b>
     <span>${esc(label)}</span>
   </div>`;

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

/** Columns the current grouped layout was flowed into. */
let gridColumns = 0;

function renderGrid() {
  const spec = SECTIONS[state.filters.sort];
  // Drives the section row spacing, so it has to be off for the flat sorts and
  // for the empty state as well.
  el.grid.classList.toggle('is-grouped', Boolean(spec) && state.filaments.length > 0);

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

  if (!spec) {
    el.grid.innerHTML = groupFilaments(state.filaments).map(renderGroup).join('');
    return;
  }

  // Emptying first so the track count below is the grid's own, not one widened
  // by the spans of the layout being replaced.
  el.grid.innerHTML = '';
  gridColumns = measureColumns();
  el.grid.innerHTML = flowSections(sectionsOf(state.filaments, spec), spec, gridColumns);
}

/**
 * How many card columns the grid is currently laying out. It comes from
 * `auto-fill`, so it moves with the window, the density switch and the
 * platform's scrollbar width — and `auto-fill` keeps its empty tracks, so this
 * reads correctly on an empty grid.
 */
function measureColumns() {
  const tracks = getComputedStyle(el.grid).gridTemplateColumns;
  if (!tracks || tracks === 'none') return 1;
  return Math.max(1, tracks.split(/\s+/).filter(Boolean).length);
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

/**
 * Grouping by brand would bury the spool that's in the printer somewhere down
 * in the Bs, which is the opposite of the point of flagging it — so under a
 * grouped sort the loaded ones are lifted into a section of their own at the
 * top. They're taken out of their usual group rather than shown twice, so the
 * counts still add up to what you own.
 */
const LOADED_SECTION = 'In printer';

function sectionsOf(filaments, spec) {
  const loaded = filaments.filter((f) => f.loaded);
  const byLabel = new Map();

  for (const f of filaments) {
    if (f.loaded) continue;
    const label = spec.label(f);
    if (!byLabel.has(label)) byLabel.set(label, { label, items: [], hex: f.color_hex });
    byLabel.get(label).items.push(f);
  }

  // Sorted rather than left in encounter order: variants of one base type can
  // arrive far apart (PA-CF sorts nowhere near "Nylon (PA)") and merge into a
  // heading that would otherwise sit in a surprising place.
  const sections = [...byLabel.values()].sort((a, b) => {
    if (a.label === 'Not set') return 1;
    if (b.label === 'Not set') return -1;
    return a.label.localeCompare(b.label);
  });

  if (loaded.length) sections.unshift({ label: LOADED_SECTION, items: loaded, pinned: true });
  return sections;
}

/**
 * Lays the groups out as one continuous run of cards rather than a block per
 * group, so nothing is ever left half empty: a group picks up wherever the last
 * one stopped and wraps onto the next row when it runs out of columns. Each
 * piece of a wrapped group carries the heading again, so you can always see
 * which group the row in front of you belongs to.
 *
 * Groups stay in the order they were sorted into — no packing heuristic gets to
 * pull a later group forward to plug a hole, which would quietly break the A–Z
 * the sort promised.
 */
function flowSections(sections, spec, cols) {
  // A single column can't leave a gap beside anything, so there groups simply
  // stack. Flowing them would give every single card a heading of its own,
  // which is what list view would otherwise turn into.
  const stacked = cols === 1;
  let free = cols;
  let html = '';

  sections.forEach((section, g) => {
    const collapsed = state.collapsedSections.has(section.label);
    if (free === 0) free = cols;

    // Folded away, a group is one tile wide however much it holds.
    if (collapsed) {
      html += runHTML(section, spec, [], { span: 1, collapsed, continued: false, id: `${g}-0` });
      free -= 1;
      return;
    }

    const slots = slotsFor(section);
    if (stacked) {
      html += runHTML(section, spec, slots, { span: 1, collapsed, continued: false, id: `${g}-0` });
      free = 0;
      return;
    }

    for (let i = 0, run = 0; i < slots.length; run += 1) {
      if (free === 0) free = cols;
      const take = Math.min(free, slots.length - i);
      html += runHTML(section, spec, slots.slice(i, i + take), {
        span: take, collapsed, continued: i > 0, id: `${g}-${run}`,
      });
      i += take;
      free -= take;
    }
  });
  return html;
}

/**
 * One group's cards in layout order. A stack counts once while it's stacked and
 * once per spool once it's fanned open, with a tile on the end to stack it back
 * up — the old full-width "stack them back up" bar would have had to break the
 * run it sits in.
 */
function slotsFor(section) {
  const out = [];
  for (const group of groupFilaments(section.items)) {
    if (group.items.length > 1 && state.expandedGroups.has(group.key)) {
      out.push(...group.items.map(cardHTML), restackHTML(group));
    } else {
      out.push(renderGroup(group));
    }
  }
  return out;
}

function runHTML(section, spec, slots, { span, collapsed, continued, id }) {
  // No swatch on the pinned section — it holds whatever colours happen to be
  // in the printer, so any one of them would misrepresent it.
  const swatch = spec.swatch && !section.pinned
    ? `<span class="section-swatch" style="background:${
        isRainbow(section.label) ? RAINBOW_CSS : esc(section.hex || '#808080')}"></span>`
    : '';

  // Naming each run lets a view transition slide it to its new place instead of
  // dissolving it there. The name is positional rather than built from the
  // group's label, which guarantees it's a valid ident and unique — a clash
  // makes the browser drop the whole transition.
  return `
    <section class="section${collapsed ? ' is-collapsed' : ''}${section.pinned ? ' is-pinned' : ''}"
             style="--span:${span}; view-transition-name: run-${id}">
      <button class="section-head" data-section="${esc(section.label)}"
              aria-expanded="${!collapsed}" title="${esc(section.label)}">
        <svg class="section-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        ${swatch}
        <span class="section-name">${esc(section.label)}</span>
        ${continued ? '' : `<span class="section-count">${section.items.length}</span>`}
      </button>
      ${slots.length ? `<div class="section-body">${slots.join('')}</div>` : ''}
    </section>`;
}

const restackHTML = (group) => `
  <button type="button" class="restack" data-collapse="${esc(group.key)}">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V5m0 0L8 9m4-4 4 4M4 19h16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
    <span>Stack these ${group.items.length} back up</span>
  </button>`;

// The column count decides where every group breaks, so a width change means
// re-running the layout rather than nudging it. Height is ignored on purpose:
// re-flowing changes how tall the grid is, which would otherwise come straight
// back through here.
let lastGridWidth = 0;
new ResizeObserver(([entry]) => {
  const width = Math.round(entry.contentRect.width);
  if (width === lastGridWidth) return;
  lastGridWidth = width;
  if (el.grid.classList.contains('is-grouped') && columnsIgnoringSpans() !== gridColumns) renderGrid();
}).observe(el.grid);

/**
 * The track count as the grid would lay it out empty. A run still spanning more
 * columns than the narrowed grid now has makes it add implicit tracks to fit,
 * and those show up in the track list — so measuring around the outgoing layout
 * would report the old width and the flow would never re-break.
 */
function columnsIgnoringSpans() {
  const sections = [...el.grid.querySelectorAll('.section')];
  const spans = sections.map((s) => s.style.getPropertyValue('--span'));
  for (const s of sections) s.style.setProperty('--span', '1');
  const cols = measureColumns();
  sections.forEach((s, i) => s.style.setProperty('--span', spans[i]));
  return cols;
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
    // `loaded` is part of the key because a spool in a printer is not
    // interchangeable with one on the shelf — hiding it inside a stack would
    // defeat the point of flagging it.
    const key = [f.brand, f.material, f.color_name, f.color_hex, f.status, f.loaded, f.spool_weight_g]
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
/**
 * The filament's colour as CSS, for the parts of the card that aren't the spool
 * graphic. Multi-tone stock gets the same treatment there as it does on the
 * winding, so a dual-colour spool doesn't flatten to whichever tone happens to
 * be stored first.
 */
/**
 * Colours the fill bar once a spool is getting low, so "what am I about to run
 * out of" reads off the grid without sorting for it. Thresholds are deliberately
 * generous — the point is to notice before you're mid-print, not after.
 */
const lowClass = (pct) => (pct <= 10 ? 'is-out' : pct <= 25 ? 'is-low' : '');

export function colorCSS(f) {
  if (isRainbow(f.color_name)) return RAINBOW_CSS;
  const tones = [f.color_hex, f.color_hex2, f.color_hex3].filter(Boolean);
  return tones.length > 1 ? `linear-gradient(170deg, ${tones.join(', ')})` : (tones[0] || '#808080');
}

/**
 * `stack` is how many identical spools this card stands for, or 0 for a single
 * one. The count sits beside the type rather than on the wrapper around the
 * card: in a list row that keeps it attached to the thing it's counting, and
 * because it rides inside a column that's sized as a fraction of the row, a row
 * having one doesn't push the colour, fill bar or status badge out of line with
 * the rows that don't.
 */
function cardHTML(f, stack = 0) {
  const detail = [f.color_name || '—', f.finish].filter(Boolean).join(' · ');
  const grams = Math.round(f.spool_weight_g * f.remaining_pct / 100);
  const sub = [f.brand, f.color_name].filter(Boolean).join(' · ');

  return `
  <button class="card ${f.status === 'empty' ? 'is-empty' : ''}${f.loaded ? ' is-loaded' : ''}"
          style="--fc:${colorCSS(f)}" data-id="${esc(f.id)}">
    ${f.loaded ? `<span class="loaded-flag" title="Loaded in a printer" role="img" aria-label="Loaded in a printer">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 8V4h10v4M7 17H6a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-1M7 14h10v6H7z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>
    </span>` : ''}
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
      <span class="card-title-row">
        <span class="card-title">${esc(f.material)}</span>
        ${stack > 1 ? `<span class="stack-count">×${stack}</span>` : ''}
      </span>
      <span class="card-color"><i class="color-chip"></i><span>${esc(detail)}</span></span>
      <div class="card-extra">
        ${f.status === 'empty'
          ? `<span class="card-meta">Used up ${esc(fmtDate(f.finished_at))}</span>`
          : `<span class="card-bar ${lowClass(f.remaining_pct)}"><i style="width:${f.remaining_pct}%"></i></span>
             <span class="card-meta ${lowClass(f.remaining_pct)}">${f.remaining_pct}% left · ${grams} g</span>`}
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
      ${cardHTML(first, count)}
    </div>`;
}

/**
 * Folding a group away re-flows every group after it, so there's no one element
 * to animate — the whole grid is what changes. A view transition handles that:
 * it snapshots the grid as it stands, lets the re-render happen, and eases
 * between the two. Where it isn't supported the render just lands, as before.
 */
function renderGridSmooth() {
  if (!document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    renderGrid();
    return;
  }

  const before = runNames();
  const transition = document.startViewTransition(() => {
    renderGrid();
    const after = runNames();
    animateLeaving(before.filter((name) => !after.includes(name)));
  });

  const clear = () => animateLeaving([]);
  transition.finished.then(clear, clear);
}

const runNames = () => [...el.grid.querySelectorAll('.section')]
  .map((section) => section.style.viewTransitionName)
  .filter(Boolean);

/**
 * Runs that exist before a collapse but not after have no new size or place to
 * be eased towards, so the browser gives them nothing but a fade — a group of
 * six rows folding down to one had five of them blink out where they stood
 * while the sixth animated. These get an exit of their own: they shrink back
 * towards the heading as they go, which is the direction the group is folding.
 *
 * It goes on the run's outgoing image rather than its group, because the group
 * carries the transform that puts it on the page and animating that would tear
 * it out of position.
 */
function animateLeaving(names) {
  let sheet = document.getElementById('vt-leaving');
  if (!sheet) {
    sheet = document.createElement('style');
    sheet.id = 'vt-leaving';
    document.head.append(sheet);
  }
  sheet.textContent = names.length
    ? `@keyframes fl-run-leave { to { opacity: 0; transform: scale(.78); } }
       ${names.map((n) => `::view-transition-old(${n})`).join(',')} {
         animation-name: fl-run-leave;
         animation-duration: .44s;
         animation-timing-function: cubic-bezier(.4, 0, .55, 1);
         transform-origin: top left;
       }`
    : '';
}

el.grid.addEventListener('click', (e) => {
  const section = e.target.closest('[data-section]');
  if (section) {
    const label = section.dataset.section;
    if (state.collapsedSections.has(label)) state.collapsedSections.delete(label);
    else state.collapsedSections.add(label);
    renderGridSmooth();
    return;
  }

  const collapse = e.target.closest('[data-collapse]');
  if (collapse) {
    state.expandedGroups.delete(collapse.dataset.collapse);
    renderGridSmooth();
    return;
  }

  // A tap on a stack fans it out rather than opening a spool — which one you
  // got would otherwise be arbitrary.
  const stack = e.target.closest('[data-expand]');
  if (stack) {
    state.expandedGroups.add(stack.dataset.expand);
    renderGridSmooth();
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

    <div class="detail-hero" style="--fc:${colorCSS(f)}">
      <div id="detailSpool">${spoolSVG(f)}</div>
      <div>
        <div class="detail-sub"><i class="color-chip"></i>${esc(f.color_name || 'No color set')}</div>
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
      ${f.status !== 'empty' ? `
      <button class="btn span2 ${f.loaded ? 'loaded-on' : ''}" data-act="loaded">
        <svg viewBox="0 0 24 24"><path d="M12 3v9m0 0 3.5-3.5M12 12 8.5 8.5M5 14v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        ${f.loaded ? 'Loaded in a printer — take it out' : 'Mark as loaded in a printer'}</button>` : ''}
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

  if (act === 'loaded') {
    btn.disabled = true;
    const now = !state.currentFilament?.loaded;
    try {
      await api(`/api/filaments/${encodeURIComponent(id)}`, {
        method: 'PATCH', body: { loaded: now ? 1 : 0 },
      });
      await refresh();
      await showDetail(id);
      toast(now ? 'Marked as loaded in a printer' : 'Taken out of the printer');
    } catch (err) {
      toast(err.message, true);
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
  // Scanning only makes sense for a new spool — an edit already has its values.
  $('#scanLabelBtn').hidden = Boolean(filament) || !state.labelScan;
  closeSaveMenu();
  syncSaveButton();

  form.reset();
  scanContext = '';
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
  // An existing spool's colour was already chosen deliberately, so editing its
  // name shouldn't repaint it. A new one starts free to follow what's typed.
  colorPinned = Boolean(f.color_hex);
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
 * disagree. A used-up spool has nothing left to set.
 */
function syncEditorRemaining() {
  const adding = !state.editingId;
  $('#remainingField').hidden = !adding || form.elements.status.value === 'empty';

  form.elements.remaining_pct.value = editorRemaining;
  $('#remainingOut').textContent = `${editorRemaining}%`;
  for (const b of $('#editorRemainingQuick').querySelectorAll('button')) {
    b.classList.toggle('on', Number(b.dataset.pct) === editorRemaining);
  }
}

/**
 * Saying a spool is part used says it has been opened, so the condition follows
 * along rather than making you set the same fact twice — and a sealed spool
 * recorded as 60% full would be nonsense anyway.
 *
 * Only ever promotes. Sliding back to full leaves it opened, because a spool
 * you opened and didn't print with is a real thing, and silently re-sealing it
 * would undo a deliberate choice.
 */
function setEditorRemaining(pct) {
  editorRemaining = pct;
  if (pct < 100 && form.elements.status.value === 'new') {
    form.elements.status.value = 'opened';
  }
  syncEditorRemaining();
  syncPreview();
}

form.elements.remaining_pct.addEventListener('input', (e) => setEditorRemaining(Number(e.target.value)));

$('#editorRemainingQuick').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-pct]');
  if (btn) setEditorRemaining(Number(btn.dataset.pct));
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

/**
 * Whether the colour was chosen outright — a swatch, a hex, or a scan — rather
 * than inferred from the name that was typed.
 *
 * Once it has been, typing over the name leaves it alone: naming a spool
 * "Midnight Blue Sparkle" after picking the exact purple off the label should
 * not drag it back to blue. Until then the name still drives the colour, which
 * is what makes typing "Red" fill the swatch in for you.
 */
let colorPinned = false;

$('#swatches').addEventListener('click', (e) => {
  const sw = e.target.closest('.swatch');
  if (!sw) return;
  form.elements.color_hex.value = sw.dataset.hex;
  // Always renames. Leaving the old name behind after picking a new swatch was
  // the bug — you'd end up with a spool labelled Red that renders blue.
  form.elements.color_name.value = sw.dataset.name;
  colorPinned = true;
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

/**
 * Typing a recognised color name repaints the swatch as you go — but only while
 * nothing has claimed the colour outright.
 *
 * Clearing the field deliberately does not hand control back. Renaming means
 * selecting the old text and typing over it, which takes the field through
 * empty on the way, and treating that as "start guessing again" is what made a
 * hand-picked cyan jump to navy the moment "Snow Mountain Blue" was typed over
 * it. To go back to guessing, pick a different swatch.
 */
form.elements.color_name.addEventListener('input', () => {
  const hex = colorPinned ? null : hexForColorName(form.elements.color_name.value);
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
    colorPinned = true;
    syncPreview();
    syncColorText();
  }
});

form.elements.color_hex.addEventListener('input', () => {
  colorPinned = true;
  syncColorText();
  syncPreview();
});
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

// ── Label scanning ───────────────────────────────────────────────────────────

let labelCamera = null;

function stopLabelCamera() {
  labelCamera?.stop();
  labelCamera = null;
}

async function openLabelScanner() {
  const blocked = cameraBlockedReason();
  $('#labelError').hidden = true;
  $('#labelStatus').textContent = 'Fill the frame with the label — the printed text, not the barcode.';
  $('#labelCaptureBtn').disabled = false;
  openSheet(el.labelScanner);

  if (blocked) {
    $('#labelError').textContent = blocked;
    $('#labelError').hidden = false;
    return;
  }

  labelCamera = new StillCamera($('#labelVideo'));
  try {
    await labelCamera.start();
  } catch (err) {
    const denied = err.name === 'NotAllowedError' || err.name === 'SecurityError';
    $('#labelError').textContent = denied
      ? 'Camera access was blocked. Allow it for this site in your browser settings, then try again.'
      : `Could not start the camera (${err.name || 'unknown error'}).`;
    $('#labelError').hidden = false;
    stopLabelCamera();
  }
}

/**
 * Everything read from this box so far. A box rarely has all of it on one face,
 * so each photo's text is kept and sent back with the next one — the server
 * parses the accumulated lot, which is what lets a shot of the brand and a shot
 * of the spec panel add up to a filled-in form.
 *
 * Reset whenever the editor opens, so the next spool starts clean.
 */
let scanContext = '';

/**
 * Writes whatever came back onto the form.
 *
 * Only blanks are filled. A later photo can complete what an earlier one
 * missed, but nothing already on the form is overwritten — not by a second
 * scan, and not over something typed by hand.
 */
function applyScannedFields(fields) {
  const added = [];
  const known = [];

  /*
   * Taken before anything is written, for two reasons. Filling in the material
   * pre-fills the catalog's typical temperatures, and those must not count as
   * "already answered" and beat the ones actually printed on the label. And a
   * field still holding the value the form ships with — 1.75 mm, 1000 g —
   * hasn't been answered either, so the label is free to set it.
   */
  const untouched = {};
  for (const name of ['brand', 'material', 'color_name', 'finish',
                      'diameter', 'spool_weight_g', 'nozzle_temp', 'bed_temp']) {
    const input = form.elements[name];
    const value = String(input?.value ?? '').trim();
    untouched[name] = !value || value === String(input?.defaultValue ?? '').trim();
  }

  const fill = (name, label, apply) => {
    if (fields[name] == null || fields[name] === '') return;
    if (untouched[name]) { apply(); added.push(label); } else known.push(label);
  };

  fill('brand', 'brand', () => refreshBrandPicker(fields.brand));
  fill('material', 'type', () => refreshMaterialPicker(fields.material));
  fill('color_name', 'color', () => {
    setField('color_name', fields.color_name);
    if (fields.color_hex) {
      setField('color_hex', fields.color_hex);
      // Read off the label, so typing a nicer name for it shouldn't repaint it.
      colorPinned = true;
    }
  });
  fill('finish', 'finish', () => {
    fillFinishSelect();
    setField('finish', fields.finish);
    syncFinishHint();
    syncExtraColors();
  });

  for (const [field, label] of [
    ['diameter', 'diameter'],
    ['spool_weight_g', 'spool size'],
    ['nozzle_temp', 'nozzle temp'],
    ['bed_temp', 'bed temp'],
  ]) {
    fill(field, label, () => setField(field, fields[field]));
  }

  syncColorText();
  syncPreview();
  return { added, known };
}

$('#labelCaptureBtn').addEventListener('click', async () => {
  if (!labelCamera) return;
  const btn = $('#labelCaptureBtn');

  const image = labelCamera.capture();
  if (!image) return;

  btn.disabled = true;
  $('#labelError').hidden = true;
  $('#labelStatus').textContent = 'Reading…';

  try {
    const result = await api('/api/scan', {
      method: 'POST', body: { image, context: scanContext },
    });
    // Kept whether or not this photo added anything on its own: a line it read
    // may only become meaningful next to one from the next photo.
    if (result.text) scanContext = `${scanContext}\n${result.text}`.trim();

    const { added, known } = applyScannedFields(result.fields ?? {});

    if (!added.length) {
      // Three different dead ends, each needing something different from you.
      $('#labelStatus').textContent = known.length
        ? `Nothing new — this shot only repeats the ${known.join(', ')} you already have. Try another face of the box.`
        : result.text
          ? "Read the label, but couldn't match anything on it. Try the printed spec panel."
          : 'No text found. Try getting closer, or improve the lighting.';
      btn.disabled = false;
      return;
    }

    // Left open when there's still an obvious gap, since the next photo is
    // usually of another face of the same box.
    const missing = ['brand', 'material', 'color_name']
      .filter((name) => !String(form.elements[name]?.value ?? '').trim());

    if (missing.length) {
      $('#labelStatus').textContent =
        `Got ${added.join(', ')}. Still missing ${missing.length === 3 ? 'everything' : missing
          .map((m) => ({ brand: 'the brand', material: 'the type', color_name: 'the color' })[m])
          .join(' and ')} — photograph another side.`;
      btn.disabled = false;
      return;
    }

    closeSheet(el.labelScanner);
    toast(`Filled in ${added.join(', ')}`);
  } catch (err) {
    $('#labelError').textContent = err.message;
    $('#labelError').hidden = false;
    $('#labelStatus').textContent = 'Fill the frame with the label — the printed text, not the barcode.';
    btn.disabled = false;
  }
});

$('#scanLabelBtn').addEventListener('click', openLabelScanner);
el.labelScanner.addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) closeSheet(el.labelScanner);
});
el.labelScanner.addEventListener('close', stopLabelCamera);
el.labelScanner.addEventListener('cancel', (e) => { e.preventDefault(); closeSheet(el.labelScanner); });

// ── Theme ────────────────────────────────────────────────────────────────────

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('theme', theme);
  // bg.js listens for this to recolour the background effect without a full
  // reinit — it has no other way to know the theme just changed.
  dispatchEvent(new CustomEvent('themechange', { detail: { theme } }));
}
applyTheme(
  localStorage.getItem('theme') ||
  (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'),
);
$('#themeBtn').addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
});

// ── Settings ─────────────────────────────────────────────────────────────────

/**
 * Reads back what the server is actually configured to do. Printing and label
 * scanning both switch themselves on from environment variables, and until now
 * the only way to tell whether a variable had taken was to go looking for the
 * button it enables.
 */
async function showSettings() {
  openSheet(el.settings);
  const facts = $('#settingsFacts');
  facts.innerHTML = '<div class="spec"><dt>Loading…</dt><dd></dd></div>';

  const row = (label, value) =>
    `<div class="spec"><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`;

  try {
    const [health, stats] = await Promise.all([
      api('/api/health'),
      api('/api/filaments/stats'),
    ]);
    facts.innerHTML = [
      row('Spools', `${stats.total} (${stats.empty} used up)`),
      row('On hand', `${(stats.active_grams / 1000).toFixed(1)} kg`),
      row('Brands', stats.brands),
      row('Label printing', { off: 'Off', relay: 'Via relay', direct: 'Direct to client' }[health.print_mode] ?? health.print_mode),
      row('Label scanning', health.label_scan ? 'On' : 'Off — set VISION_API_KEY'),
    ].join('');
  } catch (err) {
    facts.innerHTML = row('Could not reach the server', err.message);
  }
}

$('#settingsBtn').addEventListener('click', showSettings);

el.settings.addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) closeSheet(el.settings);
});

// ── Import ───────────────────────────────────────────────────────────────────

$('#importBtn').addEventListener('click', () => $('#importFile').click());

$('#importFile').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  // Cleared straight away so picking the same file twice still fires a change.
  e.target.value = '';
  if (!file) return;

  let payload;
  try {
    payload = JSON.parse(await file.text());
  } catch {
    toast(`${file.name} isn't valid JSON`, true);
    return;
  }

  const rows = Array.isArray(payload) ? payload : payload?.filaments;
  if (!Array.isArray(rows) || !rows.length) {
    toast('That file has no spools in it', true);
    return;
  }

  // Merging is the default and the safe one, so the prompt asks only about the
  // destructive alternative rather than presenting them as equals.
  const replace = confirm(
    `Import ${rows.length} spool${rows.length === 1 ? '' : 's'} from ${file.name}?\n\n` +
    'OK — add anything not already in the library, leaving what\'s here untouched.\n' +
    'Cancel — stop, change nothing.',
  );
  if (!replace) return;

  try {
    const r = await api('/api/import', { method: 'POST', body: { filaments: rows, mode: 'merge' } });
    await refresh();
    // Out of the way, so the result of the import is what you're looking at.
    closeSheet(el.settings);

    const parts = [];
    if (r.imported) parts.push(`added ${r.imported}`);
    if (r.skipped) parts.push(`${r.skipped} already here`);
    if (r.failed) parts.push(`${r.failed} couldn't be read`);
    toast(parts.length ? `Import done — ${parts.join(', ')}` : 'Nothing to import', Boolean(r.failed));

    if (r.errors?.length) console.warn('Import problems:\n' + r.errors.join('\n'));
  } catch (err) {
    toast(err.message, true);
  }
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
    state.labelScan = (await api('/api/scan/status')).enabled;
  } catch { /* label scanning stays hidden */ }

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
