/**
 * Camera QR scanning.
 *
 * Uses the built-in BarcodeDetector where it exists (Chrome, Android) and falls
 * back to a vendored jsQR for everything else — notably Safari on iOS, which
 * has no BarcodeDetector and is the main target here.
 *
 * jsQR is ~250 KB, so it's only fetched the first time the scanner is opened.
 */

/** Fraction of the short side handed to the decoder — matches the reticle. */
const CROP = 0.74;

/** Ceiling on the decoded square. jsQR is pure JS; beyond this it gets slow. */
const MAX_DECODE = 1024;

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
    /*
     * Resolution is the whole ballgame here.
     *
     * A label QR is ~50 characters, which is a 33x33 module code. At the
     * closest a phone can still focus (~10-15cm on the wide lens) a 20mm code
     * covers roughly 7% of the frame. On the 640x480 default that's ~47px —
     * about 1.4 pixels per module, where decoders want 3+. Asking for a much
     * larger frame is what makes it readable at a distance the lens can
     * actually focus at.
     */
    const constraints = {
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 2560 },
        height: { ideal: 1440 },
        // Ignored where unsupported rather than failing the whole request.
        advanced: [{ focusMode: 'continuous' }],
      },
      audio: false,
    };

    try {
      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch {
      // Some cameras reject the size outright — fall back to whatever they'll give.
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
    }

    this.video.srcObject = this.stream;
    this.video.setAttribute('playsinline', '');
    await this.video.play();

    [this.track] = this.stream.getVideoTracks();
    this.capabilities = this.track?.getCapabilities?.() ?? {};

    /*
     * Phone cameras autofocus on their own; the constraint is only here for the
     * browsers that expose the control, and is applied after the stream is live
     * because some accept it via applyConstraints but not in the initial
     * request. Failures are ignored — it's a hint, not a requirement.
     */
    try {
      if (this.capabilities.focusMode?.includes('continuous')) {
        await this.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
      }
    } catch { /* camera kept its own focus behaviour */ }

    // Start at 1x. Left alone, a multi-lens phone can open on a zoomed lens
    // whose minimum focus distance is much further out.
    await this.setZoom(this.defaultZoom);

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
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;

    /*
     * Crop to the reticle instead of shrinking the whole frame. Downscaling a
     * full frame to fit jsQR's budget throws away exactly the detail the
     * decoder needs; cropping spends that budget on the part of the image the
     * code is actually in, keeping close to native pixels per module.
     */
    const side = Math.min(vw, vh) * CROP;
    const sx = (vw - side) / 2;
    const sy = (vh - side) / 2;
    const target = Math.min(Math.round(side), MAX_DECODE);

    canvas.width = target;
    canvas.height = target;
    ctx.drawImage(video, sx, sy, side, side, 0, 0, target, target);

    const image = ctx.getImageData(0, 0, target, target);
    // Alternate inversion attempts: light-on-dark labels cost nothing to catch
    // if we only pay for it every other frame.
    this.frame = (this.frame ?? 0) + 1;
    const hit = this.decode(image.data, image.width, image.height, {
      inversionAttempts: this.frame % 2 ? 'dontInvert' : 'onlyInvert',
    });
    return hit?.data ?? null;
  }

  /** Actual negotiated frame size, for the on-screen diagnostic. */
  get resolution() {
    return this.video.videoWidth ? `${this.video.videoWidth}×${this.video.videoHeight}` : 'unknown';
  }

  get zoomRange() {
    const z = this.capabilities?.zoom;
    return z && z.max > z.min ? z : null;
  }

  /** 1x where the camera supports it, otherwise the widest it will go. */
  get defaultZoom() {
    const z = this.zoomRange;
    if (!z) return null;
    return Math.min(Math.max(1, z.min), z.max);
  }

  async setZoom(value) {
    if (!this.zoomRange || value == null) return;
    try {
      await this.track.applyConstraints({ advanced: [{ zoom: Number(value) }] });
    } catch { /* the camera refused; leave it where it was */ }
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
