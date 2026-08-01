import { Router } from 'express';
import { parseLabel } from '../label-parse.js';

export const router = Router();

/**
 * Label scanning via Google Cloud Vision.
 *
 * The photo goes phone -> this server -> Vision, never phone -> Vision
 * directly: the API key is a billing credential and has no business being in
 * a page anyone can view source on. It stays in the server's environment.
 *
 * One image is one Vision "unit"; the free tier covers 1000 a month.
 */

const KEY = process.env.VISION_API_KEY || '';
// Overridable so the request path can be exercised against a stub without
// spending real quota; nothing but tests should ever set this.
const ENDPOINT = process.env.VISION_ENDPOINT || 'https://vision.googleapis.com/v1/images:annotate';

/** Cap on the decoded image, well under Vision's own 20MB request limit. */
const MAX_BYTES = 8 * 1024 * 1024;

export const scanEnabled = () => Boolean(KEY);

router.get('/status', (_req, res) => {
  res.json({ enabled: scanEnabled() });
});

router.post('/', async (req, res, next) => {
  if (!scanEnabled()) {
    return res.status(503).json({
      error: 'Label scanning is not configured. Set VISION_API_KEY and restart the container.',
    });
  }

  // Accepts either a bare base64 string or a full data: URL from canvas.
  const raw = String(req.body?.image ?? '');
  const base64 = raw.replace(/^data:image\/[a-z+]+;base64,/i, '').trim();
  if (!base64) return res.status(400).json({ error: 'No image supplied.' });

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
    if (!text.trim()) {
      return res.json({ fields: {}, text: '', message: 'No text found in that photo.' });
    }

    // `text` goes back too so the UI can show what was read when the parse
    // comes up short — otherwise a miss is indistinguishable from a bad photo.
    res.json({ fields: parseLabel(text), text });
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
