/**
 * The bench kiosk: a Pi with a 1024×600 touchscreen beside the printers.
 *
 * Deliberately not the library. It shows one thing at a time — the camera,
 * waiting for a label, or the spool that was just scanned with the handful of
 * things you actually do to a roll at the printer, as buttons big enough to hit
 * across a bench. Everything goes through the same API the library uses, so the
 * history, undo and printer loading behave exactly as they do there.
 *
 * The camera isn't touched from here. A daemon on the Pi reads it, and drives
 * this page over Chromium's DevTools port:
 *   window.kioskFrame(dataUrl)  a preview frame, ~10 a second
 *   window.kioskOpen(id)        a label was read; show that spool
 *   window.kioskLabelRead(r)    what a label photo said, for a new spool
 *   window.kioskScreen(on)      the Pi has turned the display off, or back on
 * and the page asks it for things through window.kioskCommand(json), a
 * DevTools binding the daemon installs.
 */
import { spoolSVG, escapeXML as esc } from './spool.js';
import { locIconSVG } from './location-icons.js';

const $ = (s) => document.querySelector(s);

const STATUS_LABEL = { new: 'Sealed', opened: 'Opened', empty: 'Used up' };
const IDLE_MS = 60 * 1000;          // a spool left on screen goes back to scanning
const ADD_IDLE_MS = 3 * 60 * 1000;  // a half-entered new spool gets longer
const REFRESH_MS = 30 * 1000;       // the printer panel, while it's showing
const RECENT_MAX = 4;

const state = {
  filaments: [],
  locations: [],
  canPrint: false,   // whether the library has a label printer to send to
  current: null,     // the spool on screen, as the server last returned it
  busy: false,
  canRead: false,    // whether the library can read labels (a Vision key is set)
  catalog: null,     // brands, types, colors: what a new spool's details come from
};

// ── Server ──────────────────────────────────────────────────────────────────

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `The server said ${res.status}`);
  return data;
}

async function loadAll() {
  const [filaments, locs] = await Promise.all([
    api('/api/filaments'),
    api('/api/locations'),
  ]);
  state.filaments = filaments;
  state.locations = locs.locations;
}

const nameOf = (f) => [f.brand, f.material].filter(Boolean).join(' ');
const sameName = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
const placeNamed = (name) => state.locations.find((l) => sameName(l.name, name));
const printers = () => state.locations.filter((l) => l.kind === 'printer');
const shelves = () => state.locations.filter((l) => l.kind !== 'printer');
const gramsLeft = (f) => Math.round(f.spool_weight_g * f.remaining_pct / 100);

/* Nowhere in particular: the library's own mark for it, minus the plus — here
   it's a choice being made, not an invitation to pick a place. */
const NOWHERE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor"'
  + ' stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="8.5" stroke-dasharray="3 3"/></svg>';

// ── Recently used ───────────────────────────────────────────────────────────

/*
 * The last few spools handled here, so the one you just put down can be picked
 * back up without finding its label again. Kept in this browser only: it's a
 * convenience of this screen, not something the library needs to know.
 */
function recentIds() {
  try { return JSON.parse(localStorage.getItem('kioskRecent') || '[]'); } catch { return []; }
}
function remember(id) {
  const ids = [id, ...recentIds().filter((x) => x !== id)].slice(0, RECENT_MAX);
  try { localStorage.setItem('kioskRecent', JSON.stringify(ids)); } catch { /* per-viewer nicety */ }
}

// ── The waiting screen ──────────────────────────────────────────────────────

function spoolRowHTML(f, extra = '') {
  const pct = f.status === 'empty' ? 'Used up' : `${f.remaining_pct}%`;
  return `<button class="spool-row" data-open="${esc(f.id)}">
    <span class="row-art">${spoolSVG(f, { title: false })}</span>
    <span class="row-text">
      <b>${esc(nameOf(f))}</b>
      <span>${esc(f.color_name || '—')}</span>
    </span>
    ${extra}
    <span class="row-pct">${esc(pct)}</span>
  </button>`;
}

function renderScanView() {
  const list = printers();
  $('#printerList').innerHTML = list.length
    ? list.map((p) => {
      const loaded = state.filaments.filter((f) => sameName(f.location, p.name));
      return `<div class="printer">
        <div class="printer-name">${locIconSVG(p.icon)}<b>${esc(p.code || p.name)}</b>
          ${p.code ? `<span>${esc(p.name)}</span>` : ''}</div>
        ${loaded.length ? loaded.map((f) => spoolRowHTML(f)).join('')
          : '<p class="printer-empty">Nothing loaded</p>'}
      </div>`;
    }).join('')
    : '<p class="printer-empty">No printers saved yet. Add them as places in the library\'s Settings.</p>';

  const inPrinters = new Set(list.flatMap((p) => state.filaments
    .filter((f) => sameName(f.location, p.name)).map((f) => f.id)));
  const recent = recentIds()
    .filter((id) => !inPrinters.has(id))
    .map((id) => state.filaments.find((f) => f.id === id))
    .filter(Boolean);
  $('#recentHead').hidden = !recent.length;
  $('#recentList').innerHTML = recent.map((f) => spoolRowHTML(f)).join('');
}

// ── One spool ───────────────────────────────────────────────────────────────

function button(label, { icon = '', cls = '', data = '', on = false, sub = '' } = {}) {
  return `<button class="act ${cls}${on ? ' on' : ''}" ${data}>
    ${icon}<span class="act-label">${label}${sub ? `<small>${sub}</small>` : ''}</span></button>`;
}

function renderSpool() {
  const f = state.current;
  const here = placeNamed(f.location);

  $('#spoolName').textContent = nameOf(f) || 'Unnamed spool';
  $('#spoolSub').textContent = [f.color_name, f.finish, STATUS_LABEL[f.status]].filter(Boolean).join(' · ');
  $('#spoolArt').innerHTML = spoolSVG(f, { title: false });
  $('#spoolLeft').textContent = f.status === 'empty'
    ? 'Used up'
    : `${f.remaining_pct}% left · about ${gramsLeft(f)} g`;
  $('#spoolWhere').innerHTML = f.location
    ? `${locIconSVG(here?.icon ?? 'box')}<span>${here?.kind === 'printer' ? 'Loaded in' : 'In'} ${esc(f.location)}</span>`
    : '<span class="muted">Not put away</span>';

  const groups = [];

  if (f.status !== 'empty' && printers().length) {
    groups.push(`<div class="group"><h3>Load into</h3><div class="row">
      ${printers().map((p) => button(esc(p.code || p.name), {
        icon: locIconSVG(p.icon),
        cls: 'printer-btn',
        data: `data-move="${esc(p.name)}"`,
        on: sameName(f.location, p.name),
        sub: sameName(f.location, p.name) ? 'loaded' : '',
      })).join('')}
    </div></div>`);
  }

  if (f.status !== 'empty') {
    groups.push(`<div class="group"><h3>Put away</h3><div class="row wrap">
      ${shelves().map((p) => button(esc(p.name), {
        icon: locIconSVG(p.icon),
        data: `data-move="${esc(p.name)}"`,
        on: sameName(f.location, p.name),
      })).join('')}
      ${button('Not put away', { icon: NOWHERE_ICON, cls: 'nowhere', data: 'data-move=""', on: !f.location })}
    </div></div>`);
  }

  $('#printBtn').hidden = !state.canPrint;

  if (f.status === 'opened') {
    /*
     * A slider for anything the quick buttons don't land on, starting where the
     * spool actually is. Steps of 1, not the library's 5: a spool at 48% set
     * into a 5-step slider would be shown, and saved, as 50.
     */
    groups.push(`<div class="group"><h3>Amount left</h3>
      <div class="level">
        <input type="range" id="level" min="0" max="100" step="1" value="${f.remaining_pct}"
          style="--pct:${f.remaining_pct}%" aria-label="Amount left">
        <output id="levelOut">${f.remaining_pct}%</output>
      </div>
      <div class="row">
      ${[10, 25, 50, 75, 100].map((pct) => button(`${pct}%`, {
        cls: 'pct', data: `data-pct="${pct}"`, on: f.remaining_pct === pct,
      })).join('')}
    </div></div>`);
  }

  $('#actions').innerHTML = groups.join('');

  /*
   * The roll's own state goes under its picture rather than at the foot of the
   * button column. It's one button, it's about the roll rather than where the
   * roll goes, and the column below the spool had the room — at the bottom of
   * the actions it was the first thing pushed off a 600-pixel screen.
   */
  $('#rollAction').innerHTML = {
    new: button('Mark as opened', { cls: 'primary', data: 'data-status="open"' }),
    opened: button('Used up', { cls: 'warn', data: 'data-status="empty"' }),
    empty: button('Put back in the library', { cls: 'primary', data: 'data-status="restore"' }),
  }[f.status];
}

// ── Doing things ────────────────────────────────────────────────────────────

/**
 * One change to the spool on screen, with an undo that erases it the way the
 * library's does: the server puts the old values back and drops the history
 * written at that moment, rather than filing a second change on top.
 */
async function change(message, request) {
  if (state.busy) return;
  state.busy = true;
  document.body.classList.add('busy');
  const before = state.current;
  try {
    const after = await request();
    state.current = after;
    remember(after.id);
    renderSpool();
    toast(message, async () => {
      const back = await api(`/api/filaments/${encodeURIComponent(after.id)}/undo`, {
        method: 'POST', body: { at: after.updated_at, fields: before },
      });
      state.current = back;
      renderSpool();
      toast('Undone');
    });
  } catch (err) {
    toast(err.message, null, true);
  } finally {
    state.busy = false;
    document.body.classList.remove('busy');
  }
}

function onAction(e) {
  const f = state.current;
  if (!f) return;
  const id = encodeURIComponent(f.id);

  const move = e.target.closest('[data-move]');
  if (move) {
    const to = move.dataset.move;
    if (sameName(f.location, to)) return;
    const place = placeNamed(to);
    const from = placeNamed(f.location);
    // Clearing the place also takes it out of a printer; the server does that.
    const said = !to
      ? (from?.kind === 'printer' ? `Taken out of ${from.code || from.name}` : 'Not put away')
      : place?.kind === 'printer' ? `Loaded into ${place.code || to}` : `Put away in ${to}`;
    change(said, () => api(`/api/filaments/${id}`, { method: 'PATCH', body: { location: to } }));
    return;
  }

  const pct = e.target.closest('[data-pct]');
  if (pct) {
    const value = Number(pct.dataset.pct);
    if (value === f.remaining_pct) return;
    change(`${value}% left`,
      () => api(`/api/filaments/${id}`, { method: 'PATCH', body: { remaining_pct: value } }));
    return;
  }

  const status = e.target.closest('[data-status]');
  if (status) {
    const kind = status.dataset.status;
    const said = { open: 'Marked as opened', empty: 'Marked as used up', restore: 'Back in the library' }[kind];
    change(said, () => api(`/api/filaments/${id}/${kind}`, { method: 'POST' }));
  }
}
$('#actions').addEventListener('click', onAction);

/*
 * Dragging shows the new amount everywhere it appears — the number, the grams
 * and the spool picture — but saves nothing until the finger lifts, so a drag
 * from 60 down to 35 is one change in the history rather than twenty-five.
 */
$('#actions').addEventListener('input', (e) => {
  if (e.target.id !== 'level' || !state.current) return;
  const pct = Number(e.target.value);
  const preview = { ...state.current, remaining_pct: pct };
  e.target.style.setProperty('--pct', `${pct}%`);
  $('#levelOut').textContent = `${pct}%`;
  $('#spoolLeft').textContent = `${pct}% left · about ${gramsLeft(preview)} g`;
  $('#spoolArt').innerHTML = spoolSVG(preview, { title: false });
});

$('#actions').addEventListener('change', (e) => {
  if (e.target.id !== 'level' || !state.current) return;
  const value = Number(e.target.value);
  if (value === state.current.remaining_pct) return;
  const id = encodeURIComponent(state.current.id);
  change(`${value}% left`,
    () => api(`/api/filaments/${id}`, { method: 'PATCH', body: { remaining_pct: value } }));
});
$('#rollAction').addEventListener('click', onAction);

// ── Screens ─────────────────────────────────────────────────────────────────

const VIEWS = ['scanView', 'spoolView', 'addView'];
function showView(id) {
  for (const v of VIEWS) $(`#${v}`).hidden = v !== id;
}

/**
 * Shows a spool, and when a label was just read, says so loudly.
 *
 * Switching is fast enough to be missed: move one roll away from the camera
 * and a second one sitting beside it can take over the screen before you look
 * back, leaving you pressing buttons for the wrong spool. So a different spool
 * slides in over the old one rather than simply replacing it, its picture
 * spins into place, and a scan also rings the screen in green and tags the
 * name "Scanned" for a moment — at least one of those catches the eye from
 * across the bench.
 */
async function showSpool(id, { scanned = false } = {}) {
  let f;
  try {
    f = await api(`/api/filaments/${encodeURIComponent(id)}`);
  } catch {
    toast("That label's spool isn't in the library", null, true);
    return 'not found';
  }

  const changed = state.current?.id !== f.id || $('#spoolView').hidden;
  const swap = () => {
    state.current = f;
    renderSpool();
    showView('spoolView');
  };

  if (changed && document.startViewTransition) {
    /*
     * A transition captures the old screen before changing anything, which
     * takes a rendered frame — and while the display is asleep there are
     * none, so it would wait indefinitely and the scanned spool would never
     * arrive. Past a quarter second it's skipped: the change still happens,
     * it just isn't animated.
     */
    const vt = document.startViewTransition(swap);
    const guard = setTimeout(() => vt.skipTransition(), 250);
    await vt.updateCallbackDone.catch(() => {});
    clearTimeout(guard);
  } else {
    swap();
  }

  if (scanned) announceScan(changed);
  remember(f.id);
  stillHere();
  return 'opened';
}

let chipTimer = null;
function announceScan(changed) {
  const view = $('#spoolView');
  // Restarting an animation means taking the class off and letting the
  // browser notice before putting it back; reading a layout property does that.
  view.classList.remove('just-scanned', 'new-spool');
  void view.offsetWidth;
  view.classList.add('just-scanned');
  if (changed) view.classList.add('new-spool');

  $('#scanChip').hidden = false;
  clearTimeout(chipTimer);
  chipTimer = setTimeout(() => {
    $('#scanChip').hidden = true;
    view.classList.remove('just-scanned', 'new-spool');
  }, 2500);
}

async function showScan() {
  state.current = null;
  closePicker();
  showView('scanView');
  hideToast();
  try {
    await loadAll();
  } catch (err) {
    toast(`Can't reach the library: ${err.message}`, null, true);
  }
  renderScanView();
}

$('#backBtn').addEventListener('click', showScan);

/*
 * Another label for the roll in hand, sent the same way the library's Print QR
 * button sends one, with whatever size and copies are saved in its settings.
 */
$('#printBtn').addEventListener('click', async () => {
  const f = state.current;
  if (!f || state.busy) return;
  const btn = $('#printBtn');
  btn.disabled = true;
  try {
    await api(`/api/print/${encodeURIComponent(f.id)}`, { method: 'POST', body: {} });
    toast('Label sent to the printer');
  } catch (err) {
    toast(err.message, null, true);
  } finally {
    btn.disabled = false;
  }
});
document.addEventListener('click', (e) => {
  const row = e.target.closest('[data-open]');
  if (row) showSpool(row.dataset.open);
});

// Back to scanning after a minute untouched, so the next person — or the next
// label — starts from the camera rather than from someone else's spool.
let idleTimer = null;
function stillHere() {
  clearTimeout(idleTimer);
  const adding = !$('#addView').hidden;
  idleTimer = setTimeout(() => {
    if (adding && adder.reading) return stillHere();    // Vision still thinking
    if (!$('#spoolView').hidden || !$('#addView').hidden) showScan();
  }, adding ? ADD_IDLE_MS : IDLE_MS);
}
addEventListener('pointerdown', stillHere, { capture: true, passive: true });

// The printer panel stays current while nobody is using the screen.
setInterval(() => {
  if (!$('#scanView').hidden) loadAll().then(renderScanView).catch(() => {});
}, REFRESH_MS);

// ── Toast ───────────────────────────────────────────────────────────────────

let toastTimer = null;
let pendingUndo = null;

function toast(message, undo = null, error = false) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(message)}</span>${undo ? '<button class="toast-undo">Undo</button>' : ''}`;
  t.classList.toggle('err', error);
  t.hidden = false;
  pendingUndo = undo;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, undo ? 8000 : 3000);
}
function hideToast() {
  $('#toast').hidden = true;
  pendingUndo = null;
}
$('#toast').addEventListener('click', async (e) => {
  if (!e.target.closest('.toast-undo') || !pendingUndo) return;
  const run = pendingUndo;
  hideToast();
  try { await run(); } catch (err) { toast(err.message, null, true); }
});

// ── A new spool, from its label ─────────────────────────────────────────────

/*
 * The phone's label reading, at the bench: the Pi photographs the label, the
 * library's own reader (Google Vision, then the label parser) says what it
 * found, and what it found fills in the details. Several photos add up — the
 * brand on one face of a box and the specs on another — because each photo is
 * sent with the text already read, and the server parses it all together.
 *
 * Nothing needs typing, which this screen has no keyboard for. Every detail is
 * a tile, and a tile opens a list to choose from: the catalog's brands, types,
 * colors and finishes. A detail chosen by hand is never overwritten by a later
 * photo; one that was only read can be, by a sharper read.
 */
const ADD_FIELDS = [
  { key: 'brand', label: 'Brand', required: true },
  { key: 'material', label: 'Type', required: true },
  { key: 'color_name', label: 'Color' },
  { key: 'finish', label: 'Finish' },
  { key: 'spool_weight_g', label: 'Spool size', show: (v) => (v >= 1000 ? `${v / 1000} kg` : `${v} g`) },
  { key: 'diameter', label: 'Diameter', show: (v) => `${v} mm` },
];

// What a read can fill in, beyond the tiles: sent along when the spool is saved.
const READ_KEYS = ['brand', 'material', 'color_name', 'color_hex', 'color_hex2', 'color_hex3',
  'finish', 'diameter', 'spool_weight_g', 'nozzle_temp', 'bed_temp'];

const adder = { fields: {}, picked: new Set(), context: '', reading: false, reads: 0, timer: null };

async function showAdd() {
  if (!state.catalog) {
    try { state.catalog = await api('/api/catalog'); } catch (err) {
      toast(`Can't load the catalog: ${err.message}`, null, true);
      return;
    }
  }
  Object.assign(adder, { fields: {}, picked: new Set(), context: '', reading: false, reads: 0 });
  renderAdd();
  note('');
  showView('addView');
  stillHere();
}

function note(text, kind = '') {
  const n = $('#readNote');
  n.textContent = text;
  n.className = `read-note ${kind}`;
}

function colorOf(name) {
  const known = state.catalog?.color_names ?? {};
  const hit = Object.keys(known).find((k) => sameName(k, name));
  return hit ? known[hit] : '';
}

function renderAdd() {
  const f = adder.fields;
  $('#addTiles').innerHTML = ADD_FIELDS.map(({ key, label, required, show }) => {
    const v = f[key];
    const has = v !== undefined && v !== null && v !== '';
    const swatch = key === 'color_name' && has
      ? `<i class="tile-swatch" style="background:${esc(f.color_hex || colorOf(v) || '#808080')}"></i>`
      : '';
    return `<button class="tile${has ? '' : ' empty'}${required && !has ? ' needed' : ''}" data-field="${key}">
      <small>${label}${required ? '' : ' <em>optional</em>'}</small>
      <b>${swatch}${has ? esc(show ? show(v) : v) : 'Tap to choose'}</b>
    </button>`;
  }).join('');

  $('#addSave').disabled = !(f.brand && f.material);
  $('#readBtn').disabled = adder.reading;
  $('#readBtn').textContent = adder.reading ? 'Reading…' : adder.reads ? 'Read another side' : 'Read label';
}

$('#addBtn').addEventListener('click', showAdd);
$('#addCancel').addEventListener('click', showScan);

$('#readBtn').addEventListener('click', () => {
  if (adder.reading) return;
  if (typeof window.kioskCommand !== 'function') {
    note("The camera isn't connected to this screen right now.", 'bad');
    return;
  }
  adder.reading = true;
  renderAdd();
  note('Taking a photo and reading it…');
  // A shutter blink, so it's plain the photo was taken and when.
  const finder = $('#addFinder');
  finder.classList.remove('shutter');
  void finder.offsetWidth;
  finder.classList.add('shutter');

  window.kioskCommand(JSON.stringify({ cmd: 'read-label', context: adder.context }));
  // Vision answers in seconds; if nothing comes back at all, say so rather
  // than leave the button stuck on "Reading…".
  clearTimeout(adder.timer);
  adder.timer = setTimeout(() => {
    if (!adder.reading) return;
    adder.reading = false;
    renderAdd();
    note('No answer from the label reader. Try again?', 'bad');
  }, 60000);
});

/**
 * What a photo said. `fresh` is this photo alone and `fields` everything read
 * so far, so a value from this photo replaces an earlier read one (you just
 * aimed the camera at it) while the rest only fills in gaps. Anything chosen
 * by hand stays as chosen.
 */
window.kioskLabelRead = (reply) => {
  clearTimeout(adder.timer);
  adder.reading = false;
  if ($('#addView').hidden) return;
  stillHere();

  if (reply?.error) {
    renderAdd();
    note(reply.error, 'bad');
    return;
  }

  adder.reads += 1;
  if (reply.text) adder.context = [adder.context, reply.text].filter(Boolean).join('\n');

  const before = Object.keys(adder.fields).length;
  const fresh = reply.fresh ?? {};
  const all = reply.fields ?? {};
  for (const key of READ_KEYS) {
    if (adder.picked.has(key)) continue;
    if (fresh[key] != null && fresh[key] !== '') adder.fields[key] = fresh[key];
    else if (adder.fields[key] == null && all[key] != null && all[key] !== '') adder.fields[key] = all[key];
  }
  renderAdd();

  const gained = Object.keys(adder.fields).length - before;
  const missing = ADD_FIELDS.filter((d) => d.required && !adder.fields[d.key]).map((d) => d.label.toLowerCase());
  if (!gained && adder.reads === 1) {
    note(reply.message || "Couldn't make out any details. Try another angle or side, or tap a box to choose.", 'bad');
  } else if (missing.length) {
    note(`Still need the ${missing.join(' and ')}: read another side, or tap to choose.`);
  } else {
    note(gained ? 'Check the details, then add it.' : 'Nothing new on that side. Check the details, then add it.', 'good');
  }
};

$('#addSave').addEventListener('click', async () => {
  const f = adder.fields;
  if (!f.brand || !f.material || state.busy) return;
  state.busy = true;
  $('#addSave').disabled = true;
  try {
    const body = { status: 'new' };
    for (const key of READ_KEYS) if (f[key] != null && f[key] !== '') body[key] = f[key];
    if (body.color_name && !body.color_hex) body.color_hex = colorOf(body.color_name) || undefined;
    const made = await api('/api/filaments', { method: 'POST', body });
    state.busy = false;
    await showSpool(made.id);
    toast(state.canPrint ? 'Added. Print a label for it from the top corner.' : 'Added to the library');
  } catch (err) {
    state.busy = false;
    renderAdd();
    toast(err.message, null, true);
  }
});

// ── Choosing a detail by hand ───────────────────────────────────────────────

function optionsFor(key) {
  const c = state.catalog;
  const current = adder.fields[key];
  const uniq = (list) => [...new Map(list.filter(Boolean).map((v) => [String(v).toLowerCase(), v])).values()];
  switch (key) {
    case 'brand': return uniq([current, ...(c.owned_brands ?? []), ...(c.brands ?? [])]);
    case 'material': return uniq([current, ...(c.materials ?? []).map((m) => m.name)]);
    case 'finish': return uniq([current, ...(c.finishes ?? []).map((x) => x.name)]);
    case 'spool_weight_g': return uniq([current, ...(c.spool_weights ?? [])]);
    case 'diameter': return uniq([current, 1.75, 2.85]);
    default: return [];
  }
}

function openPicker(key) {
  const def = ADD_FIELDS.find((d) => d.key === key);
  $('#pickerTitle').textContent = def.label;
  const current = adder.fields[key];
  const list = $('#pickerList');

  if (key === 'color_name') {
    const colors = state.catalog.colors ?? [];
    const extra = current && !colors.some((x) => sameName(x.name, current))
      ? [{ name: current, hex: adder.fields.color_hex || colorOf(current) || '#808080' }] : [];
    list.className = 'picker-list swatches';
    list.innerHTML = [...extra, ...colors].map((x) => `<button class="pick${sameName(x.name, current) ? ' on' : ''}"
        data-value="${esc(x.name)}" data-hex="${esc(x.hex)}">
        <i class="pick-swatch" style="background:${esc(x.hex)}"></i><span>${esc(x.name)}</span></button>`).join('');
  } else if (key === 'brand') {
    /*
     * The catalog knows over three hundred brands, which is a lot of scrolling
     * on a bench screen when you own six of them. So the ones already in the
     * library come first under their own heading, and what the label said
     * above even those when it's a brand you've never bought.
     */
    const owned = state.catalog.owned_brands ?? [];
    const isOwned = (b) => owned.some((o) => sameName(o, b));
    const pick = (v) => `<button class="pick${sameName(v, current) ? ' on' : ''}" data-value="${esc(v)}">${esc(v)}</button>`;
    const head = (text) => `<h3 class="pick-head">${text}</h3>`;
    const rest = (state.catalog.brands ?? []).filter((b) => !isOwned(b) && !sameName(b, current));
    list.className = 'picker-list';
    list.innerHTML = [
      current && !isOwned(current) ? head('From the label') + pick(current) : '',
      owned.length ? head('In your library') + owned.map(pick).join('') : '',
      head('All brands') + rest.map(pick).join(''),
    ].join('');
  } else {
    list.className = 'picker-list';
    list.innerHTML = optionsFor(key).map((v) => `<button class="pick${String(v) === String(current) ? ' on' : ''}"
        data-value="${esc(v)}">${esc(def.show ? def.show(v) : v)}</button>`).join('');
  }
  if (!def.required) list.insertAdjacentHTML('beforeend', '<button class="pick clear" data-clear>None</button>');

  $('#picker').dataset.field = key;
  $('#picker').hidden = false;
  list.scrollTop = 0;
}

function closePicker() {
  $('#picker').hidden = true;
}

$('#addTiles').addEventListener('click', (e) => {
  const tile = e.target.closest('[data-field]');
  if (tile) openPicker(tile.dataset.field);
});

$('#pickerClose').addEventListener('click', closePicker);

$('#pickerList').addEventListener('click', (e) => {
  const pick = e.target.closest('.pick');
  if (!pick) return;
  const key = $('#picker').dataset.field;
  const f = adder.fields;

  if (pick.hasAttribute('data-clear')) {
    delete f[key];
    if (key === 'color_name') { delete f.color_hex; delete f.color_hex2; delete f.color_hex3; }
  } else if (key === 'color_name') {
    f.color_name = pick.dataset.value;
    f.color_hex = pick.dataset.hex;
    delete f.color_hex2;              // a chosen swatch is one color
    delete f.color_hex3;
    adder.picked.add('color_hex');
  } else {
    const raw = pick.dataset.value;
    f[key] = key === 'spool_weight_g' ? Number(raw) : key === 'diameter' ? Number(raw) : raw;
  }
  adder.picked.add(key);
  closePicker();
  renderAdd();
});

// ── The daemon's way in ─────────────────────────────────────────────────────

window.kioskOpen = (id) => showSpool(id, { scanned: true });

// Frames stop arriving if the daemon or camera does; say so rather than leave
// the last frame frozen there looking live.
let camStale = null;
window.kioskFrame = (src) => {
  $('#cam').src = src;
  $('#camMini').src = src;
  $('#camAdd').src = src;
  $('#cam').hidden = false;
  $('#camMini').hidden = false;
  $('#camAdd').hidden = false;
  $('#camOff').hidden = true;
  clearTimeout(camStale);
  camStale = setTimeout(() => {
    $('#cam').hidden = true;
    $('#camMini').hidden = true;
    $('#camAdd').hidden = true;
    $('#camOff').hidden = false;
    $('#camOff').textContent = 'Camera not responding';
  }, 3000);
};

// ── The screen sleeping ─────────────────────────────────────────────────────

/*
 * The Pi turns the display off after five minutes of nothing and back on for
 * movement under the camera or a label. A touch on the dark glass wakes it as
 * well, and must only wake it: whatever button happens to be under a finger
 * tapping blind mustn't also be pressed. So while it's dark, a clear sheet lies
 * over everything and takes that first tap. It wakes the Pi on the way down,
 * so the screen is coming up while the finger is still on it, and lifts on the
 * way up, after the tap has landed on the sheet and nothing else.
 */
const wakeSheet = document.createElement('div');
wakeSheet.id = 'wakeSheet';
wakeSheet.hidden = true;
document.body.append(wakeSheet);

function tellPi(cmd) {
  try { window.kioskCommand?.(JSON.stringify({ cmd })); } catch { /* daemon not attached */ }
}

wakeSheet.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  tellPi('wake');
});
wakeSheet.addEventListener('click', (e) => {
  e.stopPropagation();
  wakeSheet.hidden = true;
});

window.kioskScreen = (on) => {
  wakeSheet.hidden = on;
};

// Someone touching the screen is someone using it, even with nothing moving
// under the camera: say so, but no more than once every twenty seconds.
let toldPiAt = 0;
addEventListener('pointerdown', () => {
  const now = Date.now();
  if (now - toldPiAt < 20000) return;
  toldPiAt = now;
  tellPi('active');
}, { capture: true, passive: true });

// ── Restart and shut down (hidden) ─────────────────────────────────────────

/*
 * The Pi has no keyboard, and pulling its plug risks the SD card, so the
 * screen can restart it or shut it down. Hidden, so it's never pressed by
 * accident: hold a finger on the camera picture for three seconds. The picture
 * dims while it's held, so a deliberate hold can tell it's working. Restart and
 * Shut down each want a second tap to confirm.
 */
const HOLD_MS = 3000;
const POWER_WORDS = {
  reboot: { ask: 'Tap again to restart', doing: 'Restarting…',
    after: 'Back in about a minute.' },
  shutdown: { ask: 'Tap again to shut down', doing: 'Shutting down…',
    after: 'Safe to unplug once the Pi\u2019s green light has stopped flickering.' },
};
const finder = $('#scanView .viewfinder');
let holdTimer = null;

function endHold() {
  clearTimeout(holdTimer);
  finder.classList.remove('holding');
}
finder.addEventListener('pointerdown', () => {
  endHold();
  finder.classList.add('holding');
  holdTimer = setTimeout(() => { endHold(); openPower(); }, HOLD_MS);
});
for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) finder.addEventListener(ev, endHold);
// A long press is also how a touchscreen asks for a context menu.
finder.addEventListener('contextmenu', (e) => e.preventDefault());

let armed = null;
let armTimer = null;
let powerIdle = null;

function openPower() {
  disarm();
  const onPi = typeof window.kioskCommand === 'function';
  for (const b of $('#powerMenu').querySelectorAll('[data-power=reboot], [data-power=shutdown]')) {
    b.disabled = !onPi;
  }
  $('#powerNote').textContent = onPi ? '' : 'This isn\u2019t the kiosk, so only Reload works here.';
  $('#powerPanel').hidden = false;
  $('#powerBye').hidden = true;
  $('#powerMenu').hidden = false;
  clearTimeout(powerIdle);
  powerIdle = setTimeout(closePower, 30000);
}

function closePower() {
  disarm();
  clearTimeout(powerIdle);
  $('#powerMenu').hidden = true;
}

function disarm() {
  clearTimeout(armTimer);
  if (armed) {
    armed.textContent = armed.dataset.label;
    armed.classList.remove('armed');
  }
  armed = null;
}

$('#powerClose').addEventListener('click', closePower);
$('#powerMenu').addEventListener('click', (e) => {
  const b = e.target.closest('[data-power]');
  if (!b || b.disabled) return;
  const what = b.dataset.power;
  if (what === 'reload') { location.reload(); return; }
  if (armed !== b) {
    disarm();
    armed = b;
    b.dataset.label = b.textContent;
    b.textContent = POWER_WORDS[what].ask;
    b.classList.add('armed');
    armTimer = setTimeout(disarm, 5000);
    return;
  }
  disarm();
  clearTimeout(powerIdle);
  tellPi(what);
  $('#powerPanel').hidden = true;
  $('#powerBye').hidden = false;
  $('#powerBye h2').textContent = POWER_WORDS[what].doing;
  $('#powerBye p').textContent = POWER_WORDS[what].after;
  // Still here a minute and a half later means the Pi never acted on it.
  powerIdle = setTimeout(() => {
    closePower();
    toast('The Pi didn\u2019t respond. Try again, or unplug it.', null, true);
  }, 90000);
});

// ── Keeping up with deploys ─────────────────────────────────────────────────

/*
 * This page is never closed, so on its own it would run whatever version it
 * first loaded until the Pi rebooted. Every few minutes it asks whether its
 * own script has changed, and reloads if so — but only while it's sitting on
 * the camera, never under someone's finger.
 */
async function scriptTag() {
  const res = await fetch('/kiosk.js', { method: 'HEAD', cache: 'no-store' });
  return res.headers.get('etag') || res.headers.get('last-modified') || '';
}
const loadedAs = scriptTag().catch(() => '');
setInterval(async () => {
  if ($('#scanView').hidden || !$('#powerMenu').hidden) return;
  try {
    const [was, now] = [await loadedAs, await scriptTag()];
    if (was && now && was !== now) location.reload();
  } catch { /* offline for a moment; try again next time */ }
}, 5 * 60 * 1000);

api('/api/scan/status')
  .then((s) => { state.canRead = Boolean(s.enabled); $('#addBtn').hidden = !state.canRead; })
  .catch(() => { /* no Vision key, no button */ });

api('/api/print/status')
  .then((s) => { state.canPrint = s.mode && s.mode !== 'off'; })
  .catch(() => { /* no printing, no button */ });

showScan();
