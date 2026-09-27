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
 */
import { spoolSVG, escapeXML as esc } from './spool.js';
import { locIconSVG } from './location-icons.js';

const $ = (s) => document.querySelector(s);

const STATUS_LABEL = { new: 'Sealed', opened: 'Opened', empty: 'Used up' };
const IDLE_MS = 60 * 1000;          // a spool left on screen goes back to scanning
const REFRESH_MS = 30 * 1000;       // the printer panel, while it's showing
const RECENT_MAX = 4;

const state = {
  filaments: [],
  locations: [],
  canPrint: false,   // whether the library has a label printer to send to
  current: null,     // the spool on screen, as the server last returned it
  busy: false,
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
    groups.push(`<div class="group"><h3>Amount left</h3><div class="row">
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
$('#rollAction').addEventListener('click', onAction);

// ── Screens ─────────────────────────────────────────────────────────────────

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
    $('#scanView').hidden = true;
    $('#spoolView').hidden = false;
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
  $('#spoolView').hidden = true;
  $('#scanView').hidden = false;
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
  idleTimer = setTimeout(() => { if (!$('#spoolView').hidden) showScan(); }, IDLE_MS);
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

// ── The daemon's way in ─────────────────────────────────────────────────────

window.kioskOpen = (id) => showSpool(id, { scanned: true });

// Frames stop arriving if the daemon or camera does; say so rather than leave
// the last frame frozen there looking live.
let camStale = null;
window.kioskFrame = (src) => {
  $('#cam').src = src;
  $('#camMini').src = src;
  $('#cam').hidden = false;
  $('#camMini').hidden = false;
  $('#camOff').hidden = true;
  clearTimeout(camStale);
  camStale = setTimeout(() => {
    $('#cam').hidden = true;
    $('#camMini').hidden = true;
    $('#camOff').hidden = false;
    $('#camOff').textContent = 'Camera not responding';
  }, 3000);
};

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
  if ($('#scanView').hidden) return;
  try {
    const [was, now] = [await loadedAs, await scriptTag()];
    if (was && now && was !== now) location.reload();
  } catch { /* offline for a moment; try again next time */ }
}, 5 * 60 * 1000);

api('/api/print/status')
  .then((s) => { state.canPrint = s.mode && s.mode !== 'off'; })
  .catch(() => { /* no printing, no button */ });

showScan();
