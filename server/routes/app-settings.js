import { Router } from 'express';
import { getSetting, setSetting, clearSetting, maskSecret } from '../settings.js';
import { VISION_KEY_SETTING, visionKey, visionKeyIsManaged } from './scan.js';

export const router = Router();

/**
 * The Vision API key, settable from the UI.
 *
 * Write-only on purpose. A saved key is never sent back to any client — the
 * status below reports whether one exists and its last four characters, which
 * is enough to tell "the key I pasted" from "some other key" and not enough to
 * spend anyone's quota. Somebody who can read the response gains nothing they
 * could use; somebody who can read the database already has the key anyway.
 */

/** Rejects the obvious mistakes before they become a confusing 403 from Google. */
function validate(key) {
  if (!key) return 'Paste the key from the Google Cloud console.';
  if (/\s/.test(key)) return 'That has a space in it — copy just the key itself.';
  if (key.length < 20) return "That looks too short to be an API key.";
  if (key.length > 200) return 'That looks too long to be an API key.';
  // Not a hard requirement — Google could change the format — but catching the
  // common paste-the-wrong-thing case is worth one specific sentence.
  if (/^https?:/i.test(key)) return 'That looks like a URL rather than a key.';
  return null;
}

const status = () => ({
  configured: Boolean(visionKey()),
  managed: visionKeyIsManaged(),
  hint: maskSecret(visionKey()),
});

router.get('/vision', (_req, res) => res.json(status()));

router.put('/vision', (req, res) => {
  if (visionKeyIsManaged()) {
    return res.status(409).json({
      error: 'This server sets VISION_API_KEY in its environment, which takes precedence. Change it there.',
    });
  }

  const key = String(req.body?.key ?? '').trim();
  const problem = validate(key);
  if (problem) return res.status(400).json({ error: problem });

  setSetting(VISION_KEY_SETTING, key);
  res.json(status());
});

router.delete('/vision', (req, res) => {
  if (visionKeyIsManaged()) {
    return res.status(409).json({
      error: 'This server sets VISION_API_KEY in its environment. Remove it there.',
    });
  }
  clearSetting(VISION_KEY_SETTING);
  res.json(status());
});

/*
 * A 1x1 PNG. Vision charges a unit for it, out of 1000 free a month, and it
 * buys the difference between "your key is wrong" now and a 502 in a fortnight
 * when somebody is standing at the shelf with a spool in one hand.
 */
const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

router.post('/vision/test', async (_req, res) => {
  const key = visionKey();
  if (!key) return res.status(400).json({ error: 'No key saved yet.' });

  const endpoint = process.env.VISION_ENDPOINT || 'https://vision.googleapis.com/v1/images:annotate';

  try {
    const response = await fetch(`${endpoint}?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{ image: { content: PIXEL }, features: [{ type: 'TEXT_DETECTION', maxResults: 1 }] }],
      }),
      signal: AbortSignal.timeout(15000),
    });

    const json = await response.json().catch(() => null);
    const detail = json?.error?.message || json?.responses?.[0]?.error?.message;

    if (!response.ok || detail) {
      return res.status(502).json({ error: `Vision says: ${detail || `HTTP ${response.status}`}` });
    }
    res.json({ ok: true, message: 'That key works.' });
  } catch (err) {
    if (err.name === 'TimeoutError') return res.status(504).json({ error: 'Vision took too long to answer.' });
    res.status(502).json({ error: `Could not reach Vision (${err.cause?.code || err.message}).` });
  }
});
