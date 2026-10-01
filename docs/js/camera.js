// Camera access: choose among all cameras, full-sensor 4:3 capture, hardware zoom, torch and
// white-balance locking where the browser supports it (MediaStream Image Capture constraints).

const LENS_PATTERNS = [
  ['tele', /tele|长焦|zoom|潜望/i],
  ['ultra', /ultra|超广/i],
  ['macro', /macro|微距/i],
  ['depth', /depth|景深|tof/i],
  ['ir', /infrared|\bir\b|红外/i],
  ['multi', /triple|dual|双|三摄|三镜头/i],
];

/** Front / rear from a device label (labels are only available after permission). */
export function guessFacing(label) {
  if (/front|user|前置|facing front|selfie/i.test(label)) return 'user';
  if (/back|rear|environment|后置|facing back|world/i.test(label)) return 'environment';
  return null;
}

/** Lens type from a device label: main | ultra | tele | macro | depth | ir | multi. */
export function lensKind(label) {
  for (const [k, re] of LENS_PATTERNS) if (re.test(label)) return k;
  return 'main';
}

/** Long side / short side of a frame (1 = square, 1.33 = 4:3, 1.78 = 16:9). */
export function frameAspect(w, h) { return w && h ? Math.max(w, h) / Math.min(w, h) : 0; }
const isFullSensor = (w, h) => Math.abs(frameAspect(w, h) - 4 / 3) < 0.05;

/** 4:3 sizes to try, landscape (sensor) orientation, largest useful first. */
// (640×480 would show the whole sensor too, but too blurry on a phone screen)
export const FULL_SENSOR_SIZES = [[1920, 1440], [1440, 1080], [1600, 1200], [2048, 1536], [1280, 960], [1024, 768], [960, 720]];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Our own "a newer start() replaced this one" signal (browsers also throw AbortError for real failures). */
export function superseded() { const e = new Error('superseded'); e.name = 'SupersededError'; return e; }
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

/**
 * Some browser + phone combinations answer our "about 1920×1440" request with a 1:1 or 16:9
 * sensor mode (several candidate sizes are equally far from the request, and the browser takes
 * the first). Those modes crop the sensor, so the view looks square or zoomed in. Ask the running
 * track for exact 4:3 sizes, without letting the browser crop or scale a non-4:3 mode, until one
 * is accepted. Returns true when the track ends up 4:3.
 */
export async function ensureFullSensor(track, timeoutMs = 2500) {
  if (!track || !track.applyConstraints) return false;
  const size = () => { try { const s = track.getSettings(); return [s.width, s.height]; } catch { return [0, 0]; } };
  if (isFullSensor(...size())) return true;
  // without resizeMode support we cannot forbid cropping, but browsers lacking it (Firefox,
  // Safari) only pick native camera modes anyway
  let noResize = {};
  try { if (navigator.mediaDevices.getSupportedConstraints().resizeMode) noResize = { resizeMode: { exact: 'none' } }; } catch { /* ignore */ }
  for (const [w, h] of FULL_SENSOR_SIZES) {
    for (const [cw, ch] of [[w, h], [h, w]]) {
      try {
        await withTimeout(track.applyConstraints({
          width: { exact: cw }, height: { exact: ch }, frameRate: { ideal: 30 }, ...noResize,
        }), timeoutMs);
      } catch { continue; } // not a native size of this camera
      if (track.readyState === 'ended') return false;
      if (isFullSensor(...size())) return true;
    }
  }
  return false;
}

/** Lens types that should not be picked automatically. */
const AVOID = new Set(['tele', 'macro', 'depth', 'ir', 'ultra']);

export class Camera {
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.facing = 'environment';
    this.deviceId = null;
    this.label = '';
    this.torchOn = false;
    this.wbLocked = false;
    this.gen = 0;           // guards against overlapping start() calls
    this.onEnded = null;    // called when the track ends unexpectedly (camera taken, interruption)
  }

  get active() { return !!this.stream; }
  /** True only while the video track is actually delivering frames. */
  get live() { const tr = this.track; return !!tr && tr.readyState === 'live'; }
  get track() { return this.stream ? this.stream.getVideoTracks()[0] : null; }
  get mirrored() { return this.facing === 'user'; }

  get caps() {
    const tr = this.track;
    try { return tr && tr.getCapabilities ? tr.getCapabilities() : {}; } catch { return {}; }
  }
  get settings() {
    const tr = this.track;
    try { return tr && tr.getSettings ? tr.getSettings() : {}; } catch { return {}; }
  }

  /**
   * Start a camera. opts = {deviceId?, facing?}. A deviceId that no longer exists falls back
   * to the facing mode. Requests 4:3 (the whole sensor; 16:9 crops it and looks "zoomed in").
   */
  async start(opts = {}) {
    if (!window.isSecureContext) {
      const e = new Error('insecure'); e.name = 'InsecureContext'; throw e;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      const e = new Error('getUserMedia unavailable'); e.name = 'NotSupportedError'; throw e;
    }
    const g = ++this.gen;
    this.stop();
    const facing = opts.facing || this.facing;
    // 1440×1080 is a native 4:3 mode on most phones (several modes are equally far from 1920×1440,
    // and some browsers then take a 1:1 one); resizeMode 'none' keeps Chrome from cropping a 16:9
    // mode to 4:3. Browsers without resizeMode ignore it.
    const size = { width: { ideal: 1440 }, height: { ideal: 1080 }, frameRate: { ideal: 30 }, resizeMode: 'none' };
    // opts.strict: the user picked this camera, so never silently open a different one instead
    const strict = !!(opts.strict && opts.deviceId);
    const tries = [];
    if (opts.deviceId) {
      tries.push({ video: { deviceId: { exact: opts.deviceId }, ...size }, device: true });
      // some lenses only stream small sizes: retry without the size only when the size was the problem
      tries.push({ video: { deviceId: { exact: opts.deviceId } }, device: true, onlyAfter: 'OverconstrainedError' });
    }
    if (!strict) {
      tries.push({ video: { facingMode: { ideal: facing }, ...size } });
      tries.push({ video: true });
    }
    let stream = null, lastErr = null;
    outer:
    for (const tr of tries) {
      if (tr.onlyAfter && (!lastErr || lastErr.name !== tr.onlyAfter)) continue;
      // Android releases the previous camera asynchronously: opening the next one right away often
      // fails with NotReadableError / AbortError ("could not start video source"), so wait and retry
      for (let k = 0; k < (tr.device ? 3 : 1); k++) {
        if (g !== this.gen) throw superseded();
        try { stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: tr.video }); break outer; }
        catch (err) {
          lastErr = err;
          if (!['OverconstrainedError', 'NotFoundError', 'NotReadableError', 'AbortError'].includes(err.name)) throw err;
          if (err.name === 'OverconstrainedError' || err.name === 'NotFoundError') break;
          await sleep(350 + 450 * k);
        }
      }
    }
    if (!stream) throw lastErr;
    if (g !== this.gen) {
      // a newer start() (or stop()) happened while we were waiting: drop this stream
      stream.getTracks().forEach((t) => t.stop());
      throw superseded();
    }
    this.stream = stream;
    this.torchOn = false;
    this.wbLocked = false;
    const track = stream.getVideoTracks()[0];
    const st = this.settings;
    this.deviceId = st.deviceId || opts.deviceId || null;
    this.label = track ? track.label : '';
    if (strict && st.deviceId && st.deviceId !== opts.deviceId) {
      // the browser quietly opened another camera
      this.stop();
      const e = new Error('another camera opened'); e.name = 'WrongCameraError'; throw e;
    }
    this.facing = st.facingMode === 'user' || st.facingMode === 'environment'
      ? st.facingMode : (guessFacing(this.label) || facing);
    if (track) track.addEventListener('ended', () => { if (this.stream === stream && this.onEnded) this.onEnded(); });
    const v = this.video;
    v.srcObject = stream;
    v.setAttribute('playsinline', '');
    v.muted = true;
    await v.play().catch(() => {});
    if (!v.videoWidth) {
      await new Promise((res) => {
        const done = () => { v.removeEventListener('loadedmetadata', done); res(); };
        v.addEventListener('loadedmetadata', done);
        setTimeout(done, 3000);
      });
    }
    // a square or 16:9 mode crops the sensor: switch to a 4:3 mode if the camera has one
    if (track && !isFullSensor(v.videoWidth, v.videoHeight)) {
      this.fullSensor = await ensureFullSensor(track).catch(() => false);
      if (g !== this.gen) throw superseded();
    } else this.fullSensor = true;
    // start at 1× if the camera supports zoom and opened zoomed in
    const z = this.zoomRange;
    if (z && this.zoom > 1.01 && z.min <= 1) await this.setZoom(1);
    return stream;
  }

  stop() {
    const st = this.stream;
    this.stream = null;
    if (st) st.getTracks().forEach((t) => t.stop());
  }

  /** Cancel any start() still waiting for permission / hardware. */
  cancelPending() { this.gen++; }

  /** All video inputs: [{deviceId, label, facing, kind}]. Labels need prior permission. */
  async list() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
    let devs = [];
    try { devs = await navigator.mediaDevices.enumerateDevices(); } catch { return []; }
    return devs.filter((d) => d.kind === 'videoinput').map((d, i) => ({
      deviceId: d.deviceId, label: d.label || '', index: i,
      facing: guessFacing(d.label || '') || (d.deviceId === this.deviceId ? this.facing : null),
      kind: lensKind(d.label || ''),
    }));
  }

  /**
   * If the browser handed us a telephoto / ultra-wide / depth camera by default, pick the
   * main rear camera instead. Returns the deviceId to switch to, or null.
   */
  async preferredMain() {
    if (this.facing !== 'environment' || !AVOID.has(lensKind(this.label))) return null;
    const cams = await this.list();
    const rear = cams.filter((c) => c.facing === 'environment' && c.deviceId !== this.deviceId);
    const main = rear.find((c) => c.kind === 'main') || rear.find((c) => c.kind === 'multi');
    return main ? main.deviceId : null;
  }

  // ---- zoom ----
  get zoomRange() {
    const z = this.caps.zoom;
    return z && typeof z.max === 'number' && z.max > z.min ? { min: z.min, max: z.max, step: z.step || 0.1 } : null;
  }
  get zoom() { return this.settings.zoom || 1; }
  async setZoom(v) {
    const z = this.zoomRange, tr = this.track;
    if (!z || !tr) return false;
    try { await tr.applyConstraints({ advanced: [{ zoom: Math.max(z.min, Math.min(z.max, v)) }] }); return true; }
    catch { return false; }
  }

  // ---- torch ----
  get torchSupported() { return !!this.caps.torch; }
  async setTorch(on) {
    const tr = this.track;
    if (!tr) return false;
    try { await tr.applyConstraints({ advanced: [{ torch: !!on }] }); this.torchOn = !!on; return true; }
    catch { return false; }
  }

  // ---- camera white balance (Android Chrome; iOS Safari has no such control) ----
  get wbLockSupported() {
    const m = this.caps.whiteBalanceMode;
    return Array.isArray(m) && (m.includes('manual') || m.includes('single-shot'));
  }
  /** Freeze the camera's own auto white balance at its current setting. */
  async lockWB() {
    const tr = this.track;
    if (!tr || !this.wbLockSupported) return false;
    const modes = this.caps.whiteBalanceMode;
    const temp = this.settings.colorTemperature;
    try {
      if (modes.includes('manual') && temp) await tr.applyConstraints({ advanced: [{ whiteBalanceMode: 'manual', colorTemperature: temp }] });
      else await tr.applyConstraints({ advanced: [{ whiteBalanceMode: modes.includes('single-shot') ? 'single-shot' : 'manual' }] });
      this.wbLocked = true;
      return true;
    } catch { return false; }
  }
  async unlockWB() {
    const tr = this.track;
    if (!tr || !this.wbLocked) return;
    try { await tr.applyConstraints({ advanced: [{ whiteBalanceMode: 'continuous' }] }); } catch { /* ignore */ }
    this.wbLocked = false;
  }
}

/** Map a getUserMedia error to an i18n key. */
export function cameraErrorKey(err) {
  switch (err && err.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'err.denied';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'err.notfound';
    case 'NotReadableError':
      return 'err.busy';
    case 'InsecureContext':
      return 'err.insecure';
    default:
      return 'err.generic';
  }
}
