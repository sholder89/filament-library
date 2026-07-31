/**
 * Ambient background — a faint, slowly-animating line pattern (Vanta.js
 * "trunk" effect) behind the app content.
 *
 * Renders through p5.js, not three.js/WebGL — despite most other Vanta effects
 * being three.js-based, trunk specifically is a p5 sketch under the hood. (An
 * earlier version of this file loaded three.js here, which fails at runtime
 * with a caught-but-silent "TypeError: ... is not a constructor" — the effect
 * just never appears — because trunk never touches THREE at all.)
 *
 * Strictly decorative and always optional: every failure path here falls back
 * to the plain theme background that's already painted on <html>, silently.
 * Nothing about the app's actual function depends on this file loading,
 * running, or existing at all.
 *
 * Loaded lazily and only when it's cheap:
 *   - not if the visitor prefers reduced motion
 *   - not on a connection with data-saver on
 *   - not until the page has finished loading and gone idle, since p5 + vanta
 *     together are a real payload (~800 KB) that the actual app shouldn't
 *     have to wait behind
 *
 * p5.js and vanta.trunk are vendored in public/vendor/ rather than pulled from
 * a CDN — see the header comments in those files for why and how to
 * regenerate them. vanta.trunk is pinned to p5 1.1.9 (its documented pairing);
 * don't update one without the other.
 */

const CONTAINER_ID = 'bgFx';

function reducedMotion() {
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function onSaveData() {
  return Boolean(navigator.connection?.saveData);
}

/** Reads --bgfx-color off the current theme and returns it as 0xRRGGBB. */
function currentColor() {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--bgfx-color').trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(raw)?.[1] ?? '5b8cff';
  return parseInt(hex, 16);
}

let scriptsLoaded = null; // becomes a shared Promise once loading starts

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = resolve;
    el.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(el);
  });
}

/** Loads p5.js then vanta.trunk, in order, exactly once. */
function ensureScripts() {
  scriptsLoaded ??= loadScript('/vendor/p5.min.js')
    .then(() => loadScript('/vendor/vanta.trunk.min.js'));
  return scriptsLoaded;
}

let effect = null;
let disabledForSession = false;

function startEffect() {
  if (disabledForSession || effect || reducedMotion()) return;

  const el = document.getElementById(CONTAINER_ID);
  if (!el) return;

  try {
    effect = window.VANTA.TRUNK({
      el,
      // These four ride on the app's own theme instead of a fixed value.
      color: currentColor(),
      backgroundAlpha: 0,
      // No pointer reaction: the container is pointer-events:none anyway (see
      // styles.css), so these would never fire — set false to stop vanta
      // attaching the listeners at all.
      mouseControls: false,
      touchControls: false,
      gyroControls: false,
      chaos: 1,
      spacing: 10,
      minHeight: 200,
      minWidth: 200,
      scale: 1,
      scaleMobile: 1,
    });
  } catch (err) {
    // Whatever the cause, give up for this whole session rather than retrying
    // on every visibility change.
    console.debug('Background effect disabled:', err);
    disabledForSession = true;
    el.remove();
  }
}

function stopEffect() {
  try {
    effect?.destroy();
  } catch { /* already gone */ }
  effect = null;
}

async function init() {
  if (reducedMotion() || onSaveData()) return;

  try {
    await ensureScripts();
  } catch (err) {
    console.debug('Background effect scripts failed to load:', err);
    disabledForSession = true;
    return;
  }

  startEffect();

  // Stopped while hidden so battery isn't spent on a tab nobody is looking at;
  // p5's own draw loop runs via requestAnimationFrame otherwise, which most
  // browsers only throttle, not fully pause, in a background tab.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopEffect();
    else startEffect(); // re-checks reduced-motion in case it changed mid-session
  });

  addEventListener('themechange', () => {
    if (effect?.setOptions) effect.setOptions({ color: currentColor() });
  });
}

function boot() {
  const idle = window.requestIdleCallback ?? ((fn) => setTimeout(fn, 300));
  idle(() => init());
}

if (document.readyState === 'complete') boot();
else addEventListener('load', boot);
