// Camera sequences for true-colour measurement (torch difference), written against a small camera
// interface so they can be tested in Node with a simulated camera:
//
//   cam.caps()        -> MediaTrackCapabilities-like object
//   cam.settings()    -> MediaTrackSettings-like object
//   cam.apply(c)      -> Promise<boolean>  (applyConstraints of one constraint set; false on error)
//   read(n)           -> Promise<{t: [r,g,b], ref: [r,g,b] | null, tClip, refClip}> linear means of the
//                        target (and the paper, if any) over n fresh frames, and their clipped fractions
//   sleep(ms)
//
// What the browsers allow (源码调研, 2026-10): Chrome on Android implements exposureMode 'manual' as
// "auto exposure off" with our exposureTime / iso. It lists 'manual' whenever the camera can *lock*
// auto exposure, so on some cameras the setting is accepted but does nothing. That is why
// verifyManualExposure() measures it: halving the exposure time must roughly halve the brightness.
// The current ISO is not readable in auto mode, so we choose one and run our own exposure loop.
// iOS Safari has torch and white-balance lock but no exposure control at all.

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const luma = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

export function measureCaps(caps = {}) {
  const em = Array.isArray(caps.exposureMode) ? caps.exposureMode : [];
  const wm = Array.isArray(caps.whiteBalanceMode) ? caps.whiteBalanceMode : [];
  return {
    torch: !!caps.torch,
    manualListed: em.includes('manual') && !!caps.exposureTime,
    exposureTime: caps.exposureTime || null,     // units of 100 µs
    iso: caps.iso || null,
    wbLock: wm.includes('manual'),
    colorTemperature: wm.includes('manual') && caps.colorTemperature ? caps.colorTemperature : null,
  };
}

/** Wait until the target brightness is stable (3 readings within 3 %), at most `timeout` ms. */
export async function settle(read, sleep, timeout = 1500, minWait = 250) {
  await sleep(minWait);
  let last = luma((await read(1)).t), stable = 0, waited = minWait;
  while (waited < timeout && stable < 2) {
    await sleep(100); waited += 100;
    const y = luma((await read(1)).t);
    stable = Math.abs(y - last) / Math.max(last, 1e-4) < 0.03 ? stable + 1 : 0;
    last = y;
  }
  return waited;
}

function pickIso(caps, want = 400) {
  return caps.iso ? Math.round(clamp(want, caps.iso.min, caps.iso.max)) : undefined;
}

async function setManual(cam, t, iso) {
  const c = { exposureMode: 'manual', exposureTime: t };
  if (iso !== undefined) c.iso = iso;
  return cam.apply(c);
}

/**
 * Own exposure loop at manual exposure: bring `key` ('t' or 'ref') to luminance `goal` with no
 * channel above `maxCh`. Returns {t, iso, frame}.
 */
async function exposeFor(cam, read, sleep, caps, { t, iso, key = 't', goal = 0.35, maxCh = 0.9, tries = 5 }) {
  const et = caps.exposureTime;
  let frame = null;
  for (let k = 0; k < tries; k++) {
    await setManual(cam, t, iso);
    await sleep(320);
    frame = await read(2);
    const v = frame[key] || frame.t;
    const clip = (key === 'ref' ? frame.refClip : frame.tClip) || 0;
    const y = luma(v), mx = Math.max(...v);
    // the patch median skips blown-out pixels, so also look at how many there are
    const tooBright = mx > maxCh || clip > 0.03, ok = !tooBright && Math.abs(y / goal - 1) < 0.3;
    if (ok) break;
    let f = tooBright ? Math.min(0.6, (0.8 * maxCh) / Math.max(mx, 1e-4)) : goal / Math.max(y, 1e-4);
    f = clamp(f, 0.12, 8);
    let nt = t * f;
    if (et && nt > et.max) {
      // longer than the camera allows: raise ISO instead
      if (caps.iso && iso !== undefined && iso < caps.iso.max) { iso = Math.round(clamp(iso * (nt / et.max), caps.iso.min, caps.iso.max)); }
      nt = et.max;
    }
    if (et && nt < et.min) {
      if (caps.iso && iso !== undefined && iso > caps.iso.min) { iso = Math.round(clamp(iso * (nt / et.min), caps.iso.min, caps.iso.max)); }
      nt = et.min;
    }
    if (Math.abs(nt - t) / t < 0.02 && k > 0) break;
    t = nt;
  }
  return { t, iso, frame };
}

/**
 * Does manual exposure really work on this camera? Halve the exposure time twice; the linear
 * brightness should halve each time. Also fits a per-channel tone exponent k (true linear ≈ sRGB-linear^k).
 * @returns {ok, ratios:[q1,q2], toneK:[kr,kg,kb]|null, reason}
 */
export async function verifyManualExposure(cam, read, sleep, opts = {}) {
  const caps = measureCaps(cam.caps());
  if (!caps.manualListed) return { ok: false, reason: 'notListed' };
  // the torch is for dim rooms: light the scene while checking, or there may be nothing to measure
  const useTorch = !!opts.torch && caps.torch;
  if (useTorch && (await cam.apply({ torch: true }))) await settle(read, sleep, 1200, 300);
  const s = cam.settings();
  const et = caps.exposureTime;
  let t = clamp(s.exposureTime > 0 ? s.exposureTime : 100, et.min * 4, et.max);
  let iso = pickIso(caps);
  try {
    ({ t, iso } = await exposeFor(cam, read, sleep, caps, { t, iso, goal: 0.3, maxCh: 0.85 }));
    const f1 = await read(4);
    if (luma(f1.t) < 0.02) return { ok: false, reason: 'tooDark' };
    if (!(await setManual(cam, t / 2, iso))) return { ok: false, reason: 'rejected' };
    await sleep(380);
    const f2 = await read(4);
    await setManual(cam, t / 4, iso); await sleep(380);
    const f3 = await read(4);
    const q1 = luma(f2.t) / Math.max(luma(f1.t), 1e-5), q2 = luma(f3.t) / Math.max(luma(f2.t), 1e-5);
    const ok = q1 > 0.3 && q1 < 0.75 && q2 > 0.3 && q2 < 0.78 && luma(f1.t) > 0.02;
    let toneK = null;
    if (ok) {
      toneK = [0, 1, 2].map((k) => {
        const a = f2.t[k] / Math.max(f1.t[k], 1e-5), b = f3.t[k] / Math.max(f2.t[k], 1e-5);
        const ks = [a, b].filter((q) => q > 0.2 && q < 0.85).map((q) => Math.log(0.5) / Math.log(q));
        const kk = ks.length ? ks.reduce((x, y) => x + y, 0) / ks.length : 1;
        return clamp(kk, 0.8, 1.25);
      });
    }
    return { ok, ratios: [q1, q2], toneK, reason: ok ? null : 'noEffect' };
  } finally {
    await cam.apply({ exposureMode: 'continuous' });
    if (useTorch) await cam.apply({ torch: false });
  }
}

/**
 * Torch measurement at a locked exposure. Meters on the paper when there is one (the brightest
 * thing), otherwise on the target.
 * @param opts {poi: {x, y} in full-frame fractions, ct: colour temperature preset (K)}
 * @returns {on, off, refOn, refOff, t, iso, expo, ratio, wb: 'preset'|'lock'|null} or {error}
 */
export async function torchMeasure(cam, read, sleep, opts = {}) {
  const caps = measureCaps(cam.caps());
  if (!caps.torch) return { error: 'noTorch' };
  if (!caps.manualListed) return { error: 'noManual' };
  const hasRef = !!opts.hasRef;
  let wb = null;
  try {
    if (opts.poi) await cam.apply({ pointsOfInterest: [opts.poi] });
    // a fixed white-balance preset gives the same gains here and at calibration
    if (caps.colorTemperature) {
      const ct = clamp(opts.ct || 5000, caps.colorTemperature.min, caps.colorTemperature.max);
      if (await cam.apply({ whiteBalanceMode: 'manual', colorTemperature: ct })) wb = 'preset';
    }
    if (!wb && caps.wbLock && (await cam.apply({ whiteBalanceMode: 'manual' }))) wb = 'lock';
    if (!(await cam.apply({ torch: true }))) return { error: 'torchFail' };
    await settle(read, sleep, 1500, 350);
    const s = cam.settings();
    const et = caps.exposureTime;
    let t = clamp(s.exposureTime > 0 ? s.exposureTime : 100, et.min, et.max);
    let iso = pickIso(caps, 200);
    ({ t, iso } = await exposeFor(cam, read, sleep, caps, hasRef
      ? { t, iso, key: 'ref', goal: 0.6, maxCh: 0.92 }
      : { t, iso, key: 't', goal: 0.35, maxCh: 0.9 }));
    const on1 = await read(4);
    if (Math.max(...on1.t) > 0.96 || (on1.tClip || 0) > 0.05 || (hasRef && on1.ref && (Math.max(...on1.ref) > 0.96 || (on1.refClip || 0) > 0.05))) return { error: 'clipped' };
    await cam.apply({ torch: false });
    await settle(read, sleep, 1400, 300);
    const off = await read(4);
    await cam.apply({ torch: true });
    await settle(read, sleep, 1400, 300);
    const on2 = await read(2);
    const avg = (a, b) => a && b ? a.map((v, k) => (2 * v + b[k]) / 3) : (a || b);
    const on = avg(on1.t, on2.t), refOn = hasRef ? avg(on1.ref, on2.ref) : null;
    const D = on.map((v, k) => v - off.t[k]);
    return {
      on, off: off.t, refOn, refOff: hasRef ? off.ref : null, t, iso,
      expo: t * (iso || 100), ratio: luma(D) / Math.max(luma(off.t), 1e-5), wb,
    };
  } finally {
    await cam.apply({ torch: false });
    await cam.apply({ exposureMode: 'continuous' });
    if (wb) await cam.apply({ whiteBalanceMode: 'continuous' });
  }
}
