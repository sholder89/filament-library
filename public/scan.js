/**
 * Camera QR scanning.
 *
 * Uses the built-in BarcodeDetector where it exists (Chrome, Android). iOS has
 * none and never has, which is why the same label the iOS camera app reads
 * instantly used to fail here — Apple's decoder is native, ours was jsQR.
 *
 * So everywhere else gets ZXing-C++ compiled to WebAssembly, through a ponyfill
 * presenting the same BarcodeDetector interface. Measured against jsQR on a
 * rendered copy of a real label: jsQR lost the code at ±30 of sensor noise,
 * ZXing still read it at ±120, and ZXing was ~5x faster. Camera grain in indoor
 * light is exactly that failure, so this is the difference between a scanner
 * that works in a workshop and one that only works in daylight.
 *
 * The wasm is ~1 MB (about 460 KB gzipped) and is fetched from this server, not
 * a CDN — the app has to keep working on a LAN with no internet. Both files
 * load on first scan only, and the service worker caches them after that.
 */

/** Fraction of the short side handed to the decoder — matches the reticle. */
const CROP = 0.74;

/**
 * Ceiling on the decoded square.
 *
 * A 29-module label code gets ~15 pixels per module here where 3 would do, so
 * this is already generous; spending more only costs frame rate, and attempts
 * per second are what decide whether a handheld scan lands. ZXing read every
 * blur and noise case tested at this size.
 */
const MAX_DECODE = 512;

/**
 * Rear-facing lenses, tagged with whether each one is the ultra-wide.
 *
 * On iOS the labels read "Back Camera", "Back Ultra Wide Camera", "Back Dual
 * Wide Camera" and so on — but only once camera permission has been granted, so
 * this can't be called before the first getUserMedia.
 */
async function backLenses() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === 'videoinput' && /back|rear|environment/i.test(d.label))
      .map((d) => ({
        deviceId: d.deviceId,
        label: d.label,
        // The ultra-wide is the one that can focus close enough for macro.
        macro: /ultra[\s-]?wide/i.test(d.label),
      }));
  } catch {
    return [];
  }
}

let zxingPromise = null;

/**
 * The WebAssembly decoder, as a BarcodeDetector.
 *
 * Deliberately the ponyfill rather than the polyfill: it registers itself as
 * BarcodeDetectionAPI and leaves window.BarcodeDetector alone, so a browser
 * with a real one keeps it and never pays for this download.
 */
function loadZXing() {
  zxingPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/vendor/barcode-detector.js';
    script.onload = () => {
      const api = window.BarcodeDetectionAPI;
      if (!api) { reject(new Error('QR decoder failed to initialize')); return; }
      // Without this it would go to jsDelivr for the wasm, which is exactly
      // what a LAN-only app cannot rely on.
      api.prepareZXingModule({
        overrides: { locateFile: (path) => (path.endsWith('.wasm') ? '/vendor/zxing_reader.wasm' : path) },
      });
      resolve(api);
    };
    script.onerror = () => reject(new Error('Could not load the QR decoder'));
    document.head.appendChild(script);
  });
  return zxingPromise;
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

/**
 * A plain rear camera for taking one still, used by label scanning.
 *
 * Deliberately does not hunt for the ultra-wide the way QrScanner does: that
 * lens exists to focus on a sticker held a couple of centimeters away, whereas
 * a filament label is read at arm's length where the standard lens is sharper
 * and has the longer focal length that keeps text from bowing at the edges.
 */
export class StillCamera {
  constructor(video) {
    this.video = video;
    this.stream = null;
  }

  async start() {
    const select = { facingMode: { ideal: 'environment' } };
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { ...select, width: { ideal: 2560 }, height: { ideal: 1440 }, advanced: [{ focusMode: 'continuous' }] },
        audio: false,
      });
    } catch {
      this.stream = await navigator.mediaDevices.getUserMedia({ video: select, audio: false });
    }
    this.video.srcObject = this.stream;
    this.video.setAttribute('playsinline', '');
    await this.video.play();
  }

  /**
   * JPEG data URL of what the viewfinder is showing, long edge capped.
   *
   * Only what the viewfinder is showing. The preview is square and the camera
   * frame is 16:9, and `object-fit: cover` means the sides are cropped away on
   * screen — so a photo of the whole frame contains things you deliberately
   * aimed away from. On a box with four color variants printed side by side
   * that is not a subtle difference: you frame one panel, and the text of the
   * neighbouring panel is in the picture and wins.
   *
   * Cropping to the visible region also spends the resolution budget on the
   * part you meant, which OCR only benefits from.
   *
   * Small text needs resolution, but the whole thing is base64'd into a JSON
   * body — 1600px is the point where label text is still comfortably legible
   * without the upload becoming the slow part.
   */
  capture(maxEdge = 1600) {
    const { videoWidth: w, videoHeight: h } = this.video;
    if (!w || !h) return null;

    const box = this.video.getBoundingClientRect();
    const shown = box.width > 0 && box.height > 0 ? box.width / box.height : w / h;

    // The same center crop `cover` performs: trim whichever axis overflows.
    let sw = w;
    let sh = h;
    if (w / h > shown) sw = Math.round(h * shown);
    else sh = Math.round(w / shown);
    const sx = Math.round((w - sw) / 2);
    const sy = Math.round((h - sh) / 2);

    const scale = Math.min(1, maxEdge / Math.max(sw, sh));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(sw * scale);
    canvas.height = Math.round(sh * scale);
    canvas.getContext('2d').drawImage(this.video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.85);
  }

  stop() {
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    this.video.srcObject = null;
  }
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

  /**
   * Opens a camera and binds it to the <video>.
   *
   * Resolution matters as much as focus: a label QR is ~50 characters, which is
   * a 33x33 module code, and decoding wants roughly 3 camera pixels per module.
   * The default 640x480 doesn't come close, so a large frame is requested and
   * only dropped if the camera refuses it outright.
   */
  async openCamera(select) {
    const sized = {
      ...select,
      width: { ideal: 2560 },
      height: { ideal: 1440 },
      // Ignored where unsupported rather than failing the whole request.
      advanced: [{ focusMode: 'continuous' }],
    };

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: sized, audio: false });
    } catch {
      stream = await navigator.mediaDevices.getUserMedia({ video: select, audio: false });
    }

    this.releaseStream();
    this.stream = stream;
    this.video.srcObject = stream;
    this.video.setAttribute('playsinline', '');
    await this.video.play();

    [this.track] = stream.getVideoTracks();
    this.capabilities = this.track?.getCapabilities?.() ?? {};

    // Phone cameras autofocus on their own; this is only for browsers that
    // expose the control, and is applied after the stream is live because some
    // accept it here but not in the initial request.
    try {
      if (this.capabilities.focusMode?.includes('continuous')) {
        await this.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
      }
    } catch { /* camera kept its own focus behavior */ }

    await this.setZoom(this.defaultZoom);
  }

  async start() {
    // First open is also what unlocks device labels — enumerateDevices returns
    // them blank until camera permission has been granted at least once.
    await this.openCamera({ facingMode: { ideal: 'environment' } });

    this.lenses = await backLenses();
    this.macroLens = this.lenses.find((l) => l.macro) ?? null;

    /*
     * Switch to the ultra-wide if there is one.
     *
     * This is the whole trick. A phone's main wide lens can't focus closer than
     * ~10cm, so a sticker-sized code is either blurry or too small to decode.
     * The native camera app solves it by silently hopping to the ultra-wide,
     * which focuses within a couple of centimeters — that's what "macro mode"
     * is. getUserMedia never does that on its own, so we pick the lens
     * ourselves.
     */
    if (this.macroLens) {
      try {
        await this.openCamera({ deviceId: { exact: this.macroLens.deviceId } });
        this.usingMacro = true;
      } catch {
        // Fall back to the lens we already had open.
        await this.openCamera({ facingMode: { ideal: 'environment' } });
        this.usingMacro = false;
      }
    }

    if ('BarcodeDetector' in window) {
      try {
        const formats = await window.BarcodeDetector.getSupportedFormats();
        if (formats.includes('qr_code')) {
          this.detector = new window.BarcodeDetector({ formats: ['qr_code'] });
        }
      } catch { /* fall through to the wasm build */ }
    }
    if (!this.detector) {
      const { BarcodeDetector } = await loadZXing();
      this.detector = new BarcodeDetector({ formats: ['qr_code'] });
    }

    this.running = true;
    this.tick();
  }

  async tick() {
    if (!this.running) return;

    const { video } = this;
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      try {
        const [hit] = await this.detector.detect(this.frameForDecode());
        if (hit?.rawValue) {
          this.onResult(hit.rawValue);
          return; // caller decides whether to keep going
        }
      } catch { /* a bad frame isn't worth stopping for */ }
    }

    // ~25fps. Most frames from a handheld phone are motion-blurred, so decoding
    // is a race to land on one of the sharp ones and attempts are the scarce
    // resource. On slower phones the decode itself becomes the limit anyway.
    this.timer = setTimeout(() => requestAnimationFrame(() => this.tick()), 40);
  }

  /**
   * The pixels to decode: the reticle square, as ImageData.
   *
   * Cropping rather than handing over the whole frame keeps the reticle honest
   * — what the box promises is what gets read — and keeps each pass cheap
   * enough to run often. Every fourth pass widens to the full short side so a
   * code held slightly outside the box is still found.
   */
  frameForDecode() {
    const { video, canvas, ctx } = this;
    const vw = video.videoWidth;
    const vh = video.videoHeight;

    this.frame = (this.frame ?? 0) + 1;
    const sweep = this.frame % 4 === 0;
    const side = Math.min(vw, vh) * (sweep ? 1 : CROP);
    const sx = (vw - side) / 2;
    const sy = (vh - side) / 2;
    const target = Math.min(Math.round(side), MAX_DECODE);

    canvas.width = target;
    canvas.height = target;
    ctx.drawImage(video, sx, sy, side, side, 0, 0, target, target);
    return ctx.getImageData(0, 0, target, target);
  }

  get zoomRange() {
    const z = this.capabilities?.zoom;
    return z && z.max > z.min ? z : null;
  }

  /**
   * The widest the active lens will go.
   *
   * On the ultra-wide that's the fully-wide setting, which is where its close
   * focus lives — zooming in on that lens pushes the minimum focus distance
   * back out and undoes the point of using it.
   */
  get defaultZoom() {
    const z = this.zoomRange;
    return z ? z.min : null;
  }

  async setZoom(value) {
    if (!this.zoomRange || value == null) return;
    try {
      await this.track.applyConstraints({ advanced: [{ zoom: Number(value) }] });
    } catch { /* the camera refused; leave it where it was */ }
  }

  /**
   * Nudges the camera to refocus. Re-applying a constraint is the only lever the
   * web exposes — there's no explicit "focus now" — but it's usually enough to
   * make a hunting lens settle.
   */
  async refocus() {
    if (!this.track) return;
    try {
      if (this.capabilities.focusMode?.includes('continuous')) {
        await this.track.applyConstraints({ advanced: [{ focusMode: 'manual' }] });
        await this.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
      } else if (this.zoomRange) {
        const z = Number(this.track.getSettings?.().zoom) || this.defaultZoom;
        await this.setZoom(Math.min(z + (this.zoomRange.step || 0.1), this.zoomRange.max));
        await this.setZoom(z);
      }
    } catch { /* nothing more we can do from here */ }
  }

  releaseStream() {
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.releaseStream();
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
