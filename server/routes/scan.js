import { Router } from 'express';
import { parseLabel } from '../label-parse.js';
import { getSetting } from '../settings.js';

export const router = Router();

/**
 * Label scanning via Google Cloud Vision.
 *
 * The photo goes phone -> this server -> Vision, never phone -> Vision
 * directly: the API key is a billing credential and has no business being in
 * a page anyone can view source on. It stays on the server.
 *
 * One image is one Vision "unit"; the free tier covers 1000 a month.
 */

/** Overridable so tests can point at a stub instead of spending real quota. */
const ENDPOINT = process.env.VISION_ENDPOINT || 'https://vision.googleapis.com/v1/images:annotate';

export const VISION_KEY_SETTING = 'vision_api_key';

/**
 * The environment wins where it's set, and nothing in the app can overwrite it.
 * A deployment that states its own configuration should not be quietly editable
 * from a web page on the same network; the stored key exists for the install
 * that has no environment to configure, not as a second way to configure this
 * one. Read per request, so saving a key takes effect without a restart.
 */
export const visionKey = () => process.env.VISION_API_KEY || getSetting(VISION_KEY_SETTING);

/** True when the key is fixed by the deployment and can't be changed from the UI. */
export const visionKeyIsManaged = () => Boolean(process.env.VISION_API_KEY);

/** Cap on the decoded image, well under Vision's own 20MB request limit. */
const MAX_BYTES = 8 * 1024 * 1024;

export const scanEnabled = () => Boolean(visionKey());

router.get('/status', (_req, res) => {
  res.json({ enabled: scanEnabled() });
});

router.post('/', async (req, res, next) => {
  const KEY = visionKey();
  if (!KEY) {
    return res.status(503).json({
      error: 'Label scanning needs a Google Vision API key — add one under Settings.',
    });
  }

  // Accepts either a bare base64 string or a full data: URL from canvas.
  const raw = String(req.body?.image ?? '');
  const base64 = raw.replace(/^data:image\/[a-z+]+;base64,/i, '').trim();
  if (!base64) return res.status(400).json({ error: 'No image supplied.' });

  /*
   * Text already read from this box, sent back by the client. The whole lot is
   * parsed together so a second photo of another face adds to the first rather
   * than replacing it — the brand is often on the front and the specs on a
   * panel round the side, and neither photo has all of it. Capped so a long
   * session can't grow the parse input without bound.
   */
  const context = String(req.body?.context ?? '').slice(-20000);

  // base64 is 4 characters per 3 bytes.
  if (base64.length * 0.75 > MAX_BYTES) {
    return res.status(413).json({ error: 'That photo is too large to scan.' });
  }

  try {
    const response = await fetch(`${ENDPOINT}?key=${encodeURIComponent(KEY)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{
          image: { content: base64 },
          // TEXT_DETECTION, not DOCUMENT_TEXT_DETECTION: labels are scattered
          // short strings rather than dense prose, which is what this mode is
          // tuned for.
          features: [{ type: 'TEXT_DETECTION', maxResults: 1 }],
          imageContext: { languageHints: ['en'] },
        }],
      }),
      signal: AbortSignal.timeout(20000),
    });

    const json = await response.json().catch(() => null);

    if (!response.ok) {
      // Surface Vision's own wording — it's specific about bad keys, disabled
      // APIs and exhausted quota, and guessing would be less useful.
      const detail = json?.error?.message || `Vision returned HTTP ${response.status}`;
      console.error('Vision request failed:', detail);
      return res.status(502).json({ error: `Vision: ${detail}` });
    }

    const first = json?.responses?.[0] ?? {};
    if (first.error?.message) {
      return res.status(502).json({ error: `Vision: ${first.error.message}` });
    }

    const text = first.fullTextAnnotation?.text ?? '';
    if (!text.trim() && !context) {
      return res.json({ fields: {}, text: '', message: 'No text found in that photo.' });
    }

    /*
     * Three things go back, and the difference between them matters.
     *
     * `fields` is everything read so far, this photo and the ones before it, so
     * a shot of the brand and a shot of the spec panel add up to a filled form.
     * `fresh` is this photo alone — which is how the client can tell a value it
     * is still inferring from an earlier picture from one you have just pointed
     * the camera at. Re-aiming at a different colour on a multi-variant box
     * would otherwise never take, since the first reading is still in context
     * and still wins. `text` is the raw read, for saying what happened when
     * nothing matched.
     */
    res.json({
      fields: parseLabel([context, text].filter(Boolean).join('\n')),
      fresh: text.trim() ? parseLabel(text) : {},
      text,
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return res.status(504).json({ error: 'Vision took too long to respond.' });
    }
    if (err.cause?.code) {
      return res.status(502).json({ error: `Could not reach Vision (${err.cause.code}).` });
    }
    next(err);
  }
});
