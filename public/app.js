import { spoolSVG, escapeXML as esc, luminance } from './spool.js';

// ── State ────────────────────────────────────────────────────────────────────

const state = {
  filaments: [],
  catalog: { brands: [], materials: [], colors: [], locations: [] },
  print: { mode: 'off' },
  editingId: null,
  filters: { status: 'active', brand: '', material: '', q: '', sort: 'newest' },
};

const $ = (sel) => document.querySelector(sel);
const el = {
  stats: $('#stats'),
  grid: $('#grid'),
  statusFilter: $('#statusFilter'),
  search: $('#search'),
  brandFilter: $('#brandFilter'),
  materialFilter: $('#materialFilter'),
  sortBy: $('#sortBy'),
  clearFilters: $('#clearFilters'),
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

/** Locks background scrolling while a sheet is up — iOS ignores <dialog>'s own lock. */
function openSheet(dialog) {
  document.body.style.overflow = 'hidden';
  dialog.showModal();
}
function closeSheet(dialog) {
  dialog.close();
}
for (const dialog of [el.detail, el.editor]) {
  dialog.addEventListener('close', () => {
    if (!el.detail.open && !el.editor.open) document.body.style.overflow = '';
  });
  // Tapping the backdrop dismisses.
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) closeSheet(dialog);
  });
}

// ── Load ─────────────────────────────────────────────────────────────────────

async function loadCatalog() {
  state.catalog = await api('/api/catalog');
  fillDatalist('brandList', state.catalog.brands);
  fillDatalist('materialList', state.catalog.materials.map((m) => m.name));
  fillDatalist('colorList', state.catalog.colors.map((c) => c.name));
  fillDatalist('locationList', state.catalog.locations);
  fillDatalist('weightList', state.catalog.spool_weights.map(String));
  fillSelect(el.brandFilter, state.catalog.owned_brands, 'All brands');
  fillSelect(el.materialFilter, [...new Set(state.filaments.map((f) => f.material))].sort(), 'All types');
  renderSwatches();
}

function fillDatalist(id, values) {
  document.getElementById(id).innerHTML = values.map((v) => `<option value="${esc(v)}">`).join('');
}

function fillSelect(select, values, allLabel) {
  const current = select.value;
  select.innerHTML = `<option value="">${esc(allLabel)}</option>` +
    values.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
  if (values.includes(current)) select.value = current;
}

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
  const { status, brand, material, q, sort } = state.filters;
  if (status !== 'active') p.set('status', status);
  if (brand) p.set('brand', brand);
  if (material) p.set('material', material);
  if (q) p.set('q', q);
  p.set('sort', sort);

  state.filaments = await api(`/api/filaments?${p}`);
  renderGrid();

  const active = brand || material || q || status !== 'active';
  el.clearFilters.hidden = !active;
}

async function refresh() {
  await loadFilaments();
  await Promise.all([loadStats(), loadCatalog()]);
}

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

  el.grid.innerHTML = state.filaments.map((f) => `
    <button class="card ${f.status === 'empty' ? 'is-empty' : ''}" data-id="${esc(f.id)}">
      <span class="badge ${esc(f.status)}">${esc(STATUS_LABEL[f.status])}</span>
      <div class="card-spool">${spoolSVG(f)}</div>
      <span class="card-brand">${esc(f.brand)}</span>
      <span class="card-title">${esc(f.material)}</span>
      <span class="card-color">${esc(f.color_name || '—')}</span>
    </button>
  `).join('');
}

el.grid.addEventListener('click', (e) => {
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
      ${spoolSVG(f)}
      <div>
        <div class="detail-sub">${esc(f.color_name || 'No colour set')}</div>
        <div class="chips">
          <span class="chip">${esc(STATUS_LABEL[f.status])}</span>
          ${f.status !== 'empty' ? `<span class="chip">${f.remaining_pct}% left · ~${remainingG} g</span>` : ''}
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
      <button class="btn" data-act="print" ${printable ? '' : 'disabled title="Set LABEL_CLIENT_URL to enable printing"'}>
        <svg viewBox="0 0 24 24"><path d="M7 9V3h10v6M7 19H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2m-10 0v3h10v-6H7z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>
        Print QR</button>
      ${f.status === 'opened' ? `<button class="btn ghost span2" data-act="unopen">Actually, it's still sealed</button>` : ''}
    </div>

    <dl class="spec-list">
      ${spec('Brand', f.brand)}
      ${spec('Type', f.material)}
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
      <img src="/api/print/qr/${encodeURIComponent(f.id)}.svg" alt="QR code linking to this spool" width="190" height="190">
      <code>${esc(location.origin)}/f/${esc(f.id)}</code>
    </div>

    <button class="btn danger wide" data-act="delete">Delete this record permanently</button>
  `;

  el.detailBody.dataset.id = f.id;
  if (!el.detail.open) openSheet(el.detail);
  el.detailBody.scrollTop = 0;

  if (push && location.pathname !== `/f/${f.id}`) {
    history.pushState({ id: f.id }, '', `/f/${f.id}`);
  }
}

el.detail.addEventListener('click', async (e) => {
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

function setField(name, value) {
  const input = form.elements[name];
  if (input) input.value = value ?? '';
}

function openEditor(filament = null) {
  state.editingId = filament?.id ?? null;
  el.editorTitle.textContent = filament ? 'Edit spool' : 'Add filament';
  el.saveBtn.textContent = filament ? 'Save changes' : 'Add to library';
  el.editorError.hidden = true;
  $('#quantityField').hidden = Boolean(filament);

  form.reset();
  const f = filament ?? {};
  setField('brand', f.brand);
  setField('material', f.material);
  setField('color_name', f.color_name);
  setField('color_hex', f.color_hex || '#808080');
  setField('status', f.status || 'new');
  setField('spool_weight_g', f.spool_weight_g ?? 1000);
  setField('remaining_pct', f.remaining_pct ?? 100);
  setField('diameter', f.diameter ?? 1.75);
  setField('price', f.price ?? '');
  setField('nozzle_temp', f.nozzle_temp ?? '');
  setField('bed_temp', f.bed_temp ?? '');
  setField('location', f.location);
  setField('notes', f.notes);
  setField('quantity', 1);
  setField('purchased_at', f.purchased_at ? f.purchased_at.slice(0, 10) : '');

  syncColorText();
  syncRemaining();
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
    status: form.elements.status.value,
    remaining_pct: Number(form.elements.remaining_pct.value),
  };
}

function syncPreview() {
  const d = currentDraft();
  $('#editorPreview').innerHTML = spoolSVG(d, { title: false });
  $('#previewName').textContent = [d.brand, d.material].filter(Boolean).join(' ') || 'New spool';
  $('#previewSub').textContent = [d.color_name, STATUS_LABEL[d.status]].filter(Boolean).join(' · ');
}

function syncColorText() {
  const hex = form.elements.color_hex.value.toUpperCase();
  $('#f_color_hex_text').value = hex;
  for (const sw of document.querySelectorAll('.swatch')) {
    sw.setAttribute('aria-pressed', String(sw.dataset.hex.toUpperCase() === hex));
  }
}

function syncRemaining() {
  const status = form.elements.status.value;
  $('#remainingField').hidden = status !== 'opened';
  if (status === 'new') form.elements.remaining_pct.value = 100;
  if (status === 'empty') form.elements.remaining_pct.value = 0;
  $('#remainingOut').textContent = `${form.elements.remaining_pct.value}%`;
}

function renderSwatches() {
  $('#swatches').innerHTML = state.catalog.colors.map((c) => `
    <button type="button" class="swatch" data-hex="${esc(c.hex)}" data-name="${esc(c.name)}"
            title="${esc(c.name)}" aria-label="${esc(c.name)}" aria-pressed="false"
            style="background:${esc(c.hex)}${luminance(c.hex) > 0.8 ? ';border-color:var(--muted)' : ''}"></button>
  `).join('');
  syncColorText();
}

$('#swatches').addEventListener('click', (e) => {
  const sw = e.target.closest('.swatch');
  if (!sw) return;
  form.elements.color_hex.value = sw.dataset.hex;
  if (!form.elements.color_name.value.trim()) form.elements.color_name.value = sw.dataset.name;
  syncColorText();
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
form.elements.status.addEventListener('change', () => { syncRemaining(); syncPreview(); });
form.elements.remaining_pct.addEventListener('input', () => { syncRemaining(); syncPreview(); });
for (const name of ['brand', 'material', 'color_name']) {
  form.elements[name].addEventListener('input', syncPreview);
}

/** Picking a known material pre-fills its typical temps and flags drying/enclosure. */
form.elements.material.addEventListener('change', () => {
  const value = form.elements.material.value.trim().toLowerCase();
  const match = state.catalog.materials.find((m) => m.name.toLowerCase() === value);
  const hint = $('#materialHint');
  if (!match) { hint.textContent = ''; return; }

  if (match.nozzle && !form.elements.nozzle_temp.value) form.elements.nozzle_temp.value = match.nozzle;
  if (match.bed && !form.elements.bed_temp.value) form.elements.bed_temp.value = match.bed;

  hint.textContent = [
    match.nozzle ? `Typical ${match.nozzle}°C nozzle / ${match.bed}°C bed` : '',
    match.enclosure ? 'prefers an enclosure' : '',
    match.dry ? 'keep it dry' : '',
  ].filter(Boolean).join(' · ');
});

/**
 * A field the browser can't focus (one inside the collapsed "More details"
 * section) makes constraint validation fail with no visible feedback — so
 * reveal it and say what's wrong.
 */
form.addEventListener('invalid', (e) => {
  const details = e.target.closest('details');
  if (details && !details.open) details.open = true;
  el.editorError.textContent = `${e.target.previousElementSibling?.textContent || 'A field'}: ${e.target.validationMessage}`;
  el.editorError.hidden = false;
}, true);

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  el.editorError.hidden = true;
  el.saveBtn.disabled = true;

  const data = Object.fromEntries(new FormData(form).entries());
  // A hidden range still submits, so pin the value the status implies.
  if (data.status === 'new') data.remaining_pct = 100;
  if (data.status === 'empty') data.remaining_pct = 0;

  try {
    if (state.editingId) {
      await api(`/api/filaments/${encodeURIComponent(state.editingId)}`, { method: 'PATCH', body: data });
      closeSheet(el.editor);
      await refresh();
      await showDetail(state.editingId);
      toast('Spool updated');
    } else {
      const created = await api('/api/filaments', { method: 'POST', body: data });
      const count = Array.isArray(created) ? created.length : 1;
      closeSheet(el.editor);
      await refresh();
      toast(count === 1 ? 'Spool added' : `${count} spools added`);
    }
  } catch (err) {
    el.editorError.textContent = err.message;
    el.editorError.hidden = false;
  } finally {
    el.saveBtn.disabled = false;
  }
});

// ── Filters ──────────────────────────────────────────────────────────────────

el.statusFilter.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-status]');
  if (!btn) return;
  for (const b of el.statusFilter.children) b.classList.toggle('on', b === btn);
  state.filters.status = btn.dataset.status;
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

el.brandFilter.addEventListener('change', () => { state.filters.brand = el.brandFilter.value; loadFilaments(); });
el.materialFilter.addEventListener('change', () => { state.filters.material = el.materialFilter.value; loadFilaments(); });
el.sortBy.addEventListener('change', () => { state.filters.sort = el.sortBy.value; loadFilaments(); });

el.clearFilters.addEventListener('click', () => {
  state.filters = { status: 'active', brand: '', material: '', q: '', sort: el.sortBy.value };
  el.search.value = '';
  el.brandFilter.value = '';
  el.materialFilter.value = '';
  for (const b of el.statusFilter.children) b.classList.toggle('on', b.dataset.status === 'active');
  loadFilaments();
});

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
