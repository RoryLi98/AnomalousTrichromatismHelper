// Focus that stays put. The phone's own continuous autofocus keeps hunting in dim light and on
// plain surfaces, and it focuses on whatever it likes rather than on the reticle. Where the browser
// lets a page set the lens position (Chrome on Android: focusMode 'manual' + focusDistance), the lens
// is swept here, the sharpness is measured around the reticle, and the lens is parked at the
// sharpest position. It stays there until the user taps again, or the phone is pointed at something
// else and held still (then a short search from the current position).
//
// Chrome's Camera2 code (VideoCaptureCamera2.java): 'continuous' = CONTINUOUS_PICTURE; 'manual' =
// AF off with LENS_FOCUS_DISTANCE = 1 / focusDistance (metres → diopters); 'single-shot' does
// nothing for the live picture (only for takePhoto), and the current lens position cannot be read
// while the camera focuses by itself. pointsOfInterest also moves exposure and white-balance
// metering to the point, which would upset the true-colour white reference, so it is not used.

/** Diopters (1 / metres) nearer than this are not searched (12.5 cm). */
export const D_NEAR_MAX = 8;
const COARSE_STEP = 0.75, FINE_STEP = 0.25, LOCAL_STEP = 0.3;

/** What focus control the camera offers: {manual, continuous, dFar, dNear, min, max, step}. */
export function focusCaps(caps) {
  const modes = Array.isArray(caps && caps.focusMode) ? caps.focusMode : [];
  const fd = caps && caps.focusDistance;
  const continuous = modes.includes('continuous');
  const ok = modes.includes('manual') && fd && Number.isFinite(fd.min) && Number.isFinite(fd.max) && fd.min > 0 && fd.max > fd.min;
  if (!ok) return { manual: false, continuous };
  const dNear = Math.min(1 / fd.min, D_NEAR_MAX);
  const dFar = fd.max > 1e4 ? 0 : 1 / fd.max; // an unknown hyperfocal distance is reported as a huge number
  if (dNear - dFar < 1) return { manual: false, continuous }; // (almost) fixed focus
  return { manual: true, continuous, dFar, dNear, min: fd.min, max: fd.max, step: fd.step > 0 ? fd.step : 0 };
}

/** Diopters → a focusDistance (metres) the camera accepts. */
export function distanceFor(D, fc) {
  if (D <= fc.dFar + 1e-6) return fc.max;
  // not rounded to fc.step: Chrome reports a made-up 0.01 m step (Android has none), and rounding
  // would leave close-up positions half a diopter apart
  return Math.min(fc.max, Math.max(fc.min, 1 / D));
}

/**
 * Sharpness of an RGBA patch: mean squared gradient of the green channel, normalised by the mean
 * brightness so a small exposure change does not look like a focus change. Also the contrast
 * (std / mean) and a 4×4 layout signature (block means / overall mean) to notice a new scene.
 */
export function sharpnessOf(data, w, h) {
  const n = w * h, g = new Float32Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) { g[i] = data[i * 4 + 1]; sum += g[i]; }
  const mean = sum / n;
  let e = 0, m = 0, v = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = g[i + 1] - g[i - 1], gy = g[i + w] - g[i - w];
      e += gx * gx + gy * gy; m++;
    }
  }
  const sig = new Float32Array(16), cnt = new Float32Array(16);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, k = ((y * 4 / h) | 0) * 4 + ((x * 4 / w) | 0);
    v += (g[i] - mean) * (g[i] - mean); sig[k] += g[i]; cnt[k]++;
  }
  for (let k = 0; k < 16; k++) sig[k] = sig[k] / Math.max(1, cnt[k]) / (mean + 5);
  return { fine: e / Math.max(1, m) / (mean * mean + 25), contrast: Math.sqrt(v / n) / (mean + 5), mean, sig };
}

/** How different two layout signatures are (0 = same scene; ~0.3+ = something else in view). */
export function sigDiff(a, b) {
  if (!a || !b) return 1;
  let d = 0;
  for (let k = 0; k < 16; k++) d += Math.abs(a[k] - b[k]);
  return d / 16;
}

/** Peak of a parabola through three points (x equally spaced or not); falls back to the middle x. */
export function parabolaPeak(x0, y0, x1, y1, x2, y2) {
  const d = (x0 - x1) * (x0 - x2) * (x1 - x2);
  if (!d) return x1;
  const a = (x2 * (y1 - y0) + x1 * (y0 - y2) + x0 * (y2 - y1)) / d;
  const b = (x2 * x2 * (y0 - y1) + x1 * x1 * (y2 - y0) + x0 * x0 * (y1 - y2)) / d;
  if (a >= 0) return x1; // not a peak
  const p = -b / (2 * a);
  return Math.min(Math.max(p, Math.min(x0, x2)), Math.max(x0, x2));
}

/**
 * Find the sharpest lens position.
 * o = { fc, setD: async (D) => bool, measure: async (scale: 'coarse'|'fine') => number|null,
 *       D0: current lens position (diopters) or null, mode: 'full'|'local', aborted: () => bool }
 * Returns { ok, D, score, steps, flat, aborted }.
 */
export async function findFocus(o) {
  const { fc } = o;
  const clampD = (D) => Math.min(fc.dNear, Math.max(fc.dFar, D));
  let steps = 0;
  const at = async (D, scale) => {
    if (o.aborted && o.aborted()) throw ABORT;
    steps++;
    if (!(await o.setD(D))) throw FAIL;
    const s = await o.measure(scale);
    if (s == null || !Number.isFinite(s)) throw FAIL;
    return s;
  };
  try {
    if (o.mode === 'local' && o.D0 != null) {
      const r = await localSearch(o.D0, at, clampD);
      if (r) return { ok: true, ...r, steps };
      // too blurred around the old position: search the whole range
    }
    // coarse: wide patch, downscaled, far → near; stop once well past a clear peak
    const pts = [];
    for (let D = fc.dFar; D <= fc.dNear + 1e-6; D += COARSE_STEP) pts.push(D);
    if (pts[pts.length - 1] < fc.dNear - 0.2) pts.push(fc.dNear);
    const sc = [];
    let best = 0;
    for (let i = 0; i < pts.length; i++) {
      sc.push(await at(pts[i], 'coarse'));
      if (sc[i] > sc[best]) best = i;
      const lo = Math.min(...sc);
      if (i - best >= 2 && sc[i] < 0.6 * sc[best] && sc[i - 1] < 0.6 * sc[best] && sc[best] > 1.25 * lo) break;
    }
    const lo = Math.min(...sc), hi = sc[best];
    if (hi < 1.12 * lo) return { ok: false, flat: true, steps };
    // fine: small patch at full resolution around the coarse peak, one direction only
    const Dc = pts[best];
    const fx = [], fy = [];
    for (let k = -2; k <= 2; k++) {
      const D = clampD(Dc + k * FINE_STEP);
      if (fx.length && Math.abs(D - fx[fx.length - 1]) < 0.05) continue;
      fx.push(D); fy.push(await at(D, 'fine'));
    }
    let j = 0;
    for (let k = 1; k < fy.length; k++) if (fy[k] > fy[j]) j = k;
    let D = fx[j];
    if (j > 0 && j < fy.length - 1) D = parabolaPeak(fx[j - 1], fy[j - 1], fx[j], fy[j], fx[j + 1], fy[j + 1]);
    if (Math.max(...fy) < 1.04 * Math.min(...fy)) D = Dc; // fine patch has no detail: keep the coarse peak
    const score = await at(clampD(D), 'fine');
    return { ok: true, D: clampD(D), score, steps };
  } catch (e) {
    if (e === ABORT) return { ok: false, aborted: true, steps };
    if (e === FAIL) return { ok: false, failed: true, steps };
    throw e;
  }
}
const ABORT = { abort: true }, FAIL = { fail: true };

/** Hill-climb with the fine measure from the current position. null when it is too blurred to tell. */
async function localSearch(D0, at, clampD) {
  const xs = [], ys = [];
  const add = async (D) => { D = clampD(D); const i = xs.findIndex((x) => Math.abs(x - D) < 0.05); if (i >= 0) return ys[i]; xs.push(D); const y = await at(D, 'fine'); ys.push(y); return y; };
  const s0 = await add(D0);
  const sm = await add(D0 - LOCAL_STEP), sp = await add(D0 + LOCAL_STEP);
  let dir = sp > s0 && sp >= sm ? 1 : sm > s0 ? -1 : 0;
  let cur = D0, curS = s0;
  if (dir) {
    cur = D0 + dir * LOCAL_STEP; curS = dir > 0 ? sp : sm;
    for (let k = 0; k < 8; k++) {
      const n = clampD(cur + dir * LOCAL_STEP);
      if (Math.abs(n - cur) < 0.05) break;
      const s = await add(n);
      if (s <= curS) break;
      cur = n; curS = s;
    }
  }
  if (Math.max(...ys) < 1.08 * Math.min(...ys)) return null; // flat: everything blurred (or no detail)
  const L = await add(cur - LOCAL_STEP), H = await add(cur + LOCAL_STEP);
  const D = clampD(parabolaPeak(clampD(cur - LOCAL_STEP), L, cur, curS, clampD(cur + LOCAL_STEP), H));
  const score = await at(D, 'fine');
  return { D, score };
}

/**
 * Should the lens be moved again? Watches the layout of the wide patch around the focus point while
 * the lens is parked. When the phone has been pointed at something else (the layout changed a lot)
 * and is then held still, a short local search runs; if the distance did not change it ends after
 * a few small lens moves.
 */
export class RefocusWatch {
  constructor() { this.reset(); }
  reset(ref = null) { this.ref = ref; this.hist = []; }
  /** s = sharpnessOf(...) of the wide patch; returns true when a refocus is due. */
  push(s, now) {
    if (!s || !s.sig) return false;
    if (this.ref == null) { this.ref = s.sig; return false; }
    this.hist.push({ sig: s.sig, t: now });
    this.hist = this.hist.filter((h) => now - h.t < 1300);
    if (this.hist.length < 3) return false;
    let steady = true;
    for (let k = 1; k < this.hist.length; k++) if (sigDiff(this.hist[k - 1].sig, this.hist[k].sig) > 0.06) steady = false;
    return steady && sigDiff(this.ref, s.sig) > 0.22;
  }
}
