/**
 * Camera QR scanning.
 *
 * Uses the built-in BarcodeDetector where it exists (Chrome, Android) and falls
 * back to a vendored jsQR for everything else — notably Safari on iOS, which
 * has no BarcodeDetector and is the main target here.
 *
 * jsQR is ~250 KB, so it's only fetched the first time the scanner is opened.
 */

let jsQRPromise = null;

function loadJsQR() {
  if (window.jsQR) return Promise.resolve(window.jsQR);
  jsQRPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/vendor/jsqr.js';
    script.onload = () => (window.jsQR ? resolve(window.jsQR) : reject(new Error('jsQR failed to initialise')));
    script.onerror = () => reject(new Error('Could not load the QR decoder'));
    document.head.appendChild(script);
  });
  return jsQRPromise;
}

/** Why the camera can't be used, or null when it can. */
export function cameraBlockedReason() {
  if (!navigator.mediaDevices?.getUserMedia) {
    if (!window.isSecureContext) {
      return 'Scanning needs a secure connection. Open the app over https (or on localhost) and try again.';
    }
    return "This browser doesn't support camera access.";
  }
  // getUserMedia exists but is inert outside a secure context.
  if (!window.isSecureContext) {
    return 'Scanning needs a secure connection. Open the app over https (or on localhost) and try again.';
  }
  return null;
}

export class QrScanner {
  constructor(video, onResult) {
    this.video = video;
    this.onResult = onResult;
    this.stream = null;
    this.running = false;
    this.detector = null;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    });
    this.video.srcObject = this.stream;
    this.video.setAttribute('playsinline', '');
    await this.video.play();

    if ('BarcodeDetector' in window) {
      try {
        const formats = await window.BarcodeDetector.getSupportedFormats();
        if (formats.includes('qr_code')) {
          this.detector = new window.BarcodeDetector({ formats: ['qr_code'] });
        }
      } catch { /* fall through to jsQR */ }
    }
    if (!this.detector) this.decode = await loadJsQR();

    this.running = true;
    this.tick();
  }

  async tick() {
    if (!this.running) return;

    const { video } = this;
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      try {
        const value = this.detector ? await this.scanNative() : this.scanFallback();
        if (value) {
          this.onResult(value);
          return; // caller decides whether to keep going
        }
      } catch { /* a bad frame isn't worth stopping for */ }
    }

    // Throttled to ~10fps: decoding every frame drains the battery for no gain.
    this.timer = setTimeout(() => requestAnimationFrame(() => this.tick()), 100);
  }

  async scanNative() {
    const [hit] = await this.detector.detect(this.video);
    return hit?.rawValue ?? null;
  }

  scanFallback() {
    const { video, canvas, ctx } = this;
    // Downscale before decoding — jsQR is pure JS and full-resolution frames
    // are far slower than they need to be.
    const scale = Math.min(1, 480 / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    if (!canvas.width || !canvas.height) return null;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const hit = this.decode(image.data, image.width, image.height, {
      inversionAttempts: 'dontInvert',
    });
    return hit?.data ?? null;
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    this.video.srcObject = null;
  }
}

/**
 * Pulls a filament id out of a scanned value.
 *
 * Accepts a full /f/<id> URL from any host — the QR may have been printed when
 * the app answered on a different address than you're browsing now — and also a
 * bare id, so a hand-typed code works.
 */
export function filamentIdFrom(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;

  const fromPath = /\/f\/([A-Za-z0-9]+)\/?$/.exec(text);
  if (fromPath) return fromPath[1].toUpperCase();

  if (/^[0-9A-HJKMNP-TV-Z]{8}$/i.test(text)) return text.toUpperCase();
  return null;
}
