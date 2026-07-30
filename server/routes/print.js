import { Router } from 'express';
import QRCode from 'qrcode';
import { getFilament } from './filaments.js';

export const router = Router();

/**
 * Voice Label Printer integration.
 *
 * Prints go through the relay server, the same path Alexa and Siri use: we POST
 * the job to /webhook and the Windows client picks it up on its next poll.
 *
 * The style rides along with the job in the `style` field rather than being set
 * globally via /settings. That keeps the printer's saved defaults untouched, so
 * printing a filament QR never leaves the printer in QR mode and never clobbers
 * the default style you pinned in the label app.
 *
 * LABEL_CLIENT_URL switches to talking straight to the Windows client's own
 * /print endpoint instead. Useful if the relay isn't reachable, but it needs
 * that PC to be on and reachable from this container.
 */

const CLIENT_URL = (process.env.LABEL_CLIENT_URL || '').replace(/\/+$/, '');
const RELAY_URL  = (process.env.LABEL_RELAY_URL  || '').replace(/\/+$/, '');
const TOKEN      = process.env.LABEL_TOKEN || '';

// Safe to default now that the size travels with the job instead of being
// written to the printer's saved settings.
const SIZE       = process.env.LABEL_SIZE || '2x1';
// On by default: the label prints the spool description beside the code, so a
// sticker is readable without scanning it. Set to 0 for a bare QR.
const SHOW_TEXT  = process.env.LABEL_QR_SHOW_TEXT !== '0';
const NAME_LABEL = process.env.LABEL_NAME_LABEL === '1';
const MODE_PREF  = (process.env.LABEL_MODE || 'auto').toLowerCase();

/** Sizes the label client knows about — anything else would render wrong. */
const VALID_SIZES = ['2x1', '4x2', '4x6', '3x2', '2x0.5', '1.1x3.5', '1.1x2.4'];

export function printMode() {
  const relayReady = Boolean(RELAY_URL && TOKEN);
  const directReady = Boolean(CLIENT_URL);
  if (MODE_PREF === 'relay')  return relayReady ? 'relay' : 'off';
  if (MODE_PREF === 'direct') return directReady ? 'direct' : 'off';
  if (relayReady) return 'relay';
  return directReady ? 'direct' : 'off';
}

/** Public URL of this app, used as the QR payload. */
export function baseUrl(req) {
  const configured = (process.env.APP_BASE_URL || '').replace(/\/+$/, '');
  if (configured) return configured;
  return `${req.protocol}://${req.get('host')}`;
}

export const filamentUrl = (req, id) => `${baseUrl(req)}/f/${id}`;

/**
 * Text printed on the label beside the QR code.
 *
 * Space-separated on purpose: the label renderer auto-wraps on whitespace, so a
 * punctuation separator like "·" would be treated as a word and take a whole
 * line to itself on a 2x1 sticker.
 */
export const describe = (f) =>
  [f.brand, f.material, f.color_name].filter(Boolean).join(' ');

async function request(url, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json', ...headers } : headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) {
    throw new Error(`${new URL(url).pathname} responded ${res.status}: ${parsed?.error ?? text.slice(0, 200)}`);
  }
  return parsed;
}

const relayHeaders = () => ({ 'X-Token': TOKEN });

/** Queues one label on the relay, with its style and caption attached. */
const queueLabel = (text, style, caption) =>
  request(`${RELAY_URL}/webhook`, {
    method: 'POST',
    body: { value1: text, style, ...(caption ? { caption } : {}) },
    headers: relayHeaders(),
  });

// ── On-screen QR ─────────────────────────────────────────────────────────────

router.get('/qr/:id.svg', async (req, res, next) => {
  const filament = getFilament(req.params.id);
  if (!filament) return res.status(404).json({ error: 'Filament not found.' });
  try {
    const svg = await QRCode.toString(filamentUrl(req, filament.id), {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 1,
    });
    res.type('image/svg+xml').set('Cache-Control', 'no-store').send(svg);
  } catch (err) {
    next(err);
  }
});

// ── Config probe (drives the UI's print button state) ────────────────────────

router.get('/status', (req, res) => {
  const mode = printMode();
  res.json({
    mode,
    target: mode === 'relay' ? RELAY_URL : mode === 'direct' ? CLIENT_URL : null,
    size: SIZE || null,
    show_text: SHOW_TEXT,
    name_label: NAME_LABEL,
    base_url: baseUrl(req),
  });
});

// ── Print ────────────────────────────────────────────────────────────────────

router.post('/:id', async (req, res, next) => {
  const filament = getFilament(req.params.id);
  if (!filament) return res.status(404).json({ error: 'Filament not found.' });

  const mode = printMode();
  if (mode === 'off') {
    return res.status(503).json({
      error: 'Label printing is not configured. Set LABEL_RELAY_URL and LABEL_TOKEN, then restart the container.',
    });
  }

  const body = req.body ?? {};
  const url = filamentUrl(req, filament.id);
  const size = VALID_SIZES.includes(body.size) ? body.size : SIZE;
  const showText = body.show_text === undefined ? SHOW_TEXT : Boolean(body.show_text);
  const nameLabel = body.name_label === undefined ? NAME_LABEL : Boolean(body.name_label);
  // The relay accepts 10 jobs a minute; keep copies well inside that.
  const copies = Math.min(mode === 'relay' ? 5 : 10, Math.max(1, parseInt(body.copies, 10) || 1));

  // The QR encodes the URL; the caption is what a human reads off the shelf.
  const caption = describe(filament);
  const qrStyle = { style_preset: 'qr_code', qr_show_text: showText ? 'true' : 'false', icons: 'false', size };
  const textStyle = { style_preset: 'none', icons: 'false', size };

  try {
    if (mode === 'direct') {
      await request(`${CLIENT_URL}/print`, {
        method: 'POST',
        body: { text: url, style_preset: 'qr_code', qr_show_text: showText, caption, icons: false, size, copies },
      });
      if (nameLabel) {
        await request(`${CLIENT_URL}/print`, {
          method: 'POST',
          body: { text: caption, style_preset: 'none', icons: false, size, copies },
        });
      }
    } else {
      // Each job carries its own style, so ordering no longer matters and the
      // printer's saved settings are never touched.
      for (let i = 0; i < copies; i++) await queueLabel(url, qrStyle, caption);
      if (nameLabel) {
        for (let i = 0; i < copies; i++) await queueLabel(caption, textStyle);
      }
    }

    res.json({ ok: true, mode, url, caption, size, copies });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return res.status(504).json({
        error: `Timed out reaching the label printer at ${mode === 'relay' ? RELAY_URL : CLIENT_URL}.`,
      });
    }
    if (err.cause?.code) {
      return res.status(502).json({
        error: `Could not reach the label printer at ${mode === 'relay' ? RELAY_URL : CLIENT_URL} (${err.cause.code}).`,
      });
    }
    next(err);
  }
});
