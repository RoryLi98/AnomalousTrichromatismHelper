// Software focus (docs/js/focus.js) against a simulated lens.
import test from 'node:test';
import assert from 'node:assert/strict';
import { focusCaps, distanceFor, sharpnessOf, sigDiff, parabolaPeak, findFocus, RefocusWatch } from '../docs/js/focus.js';

const CAPS = { focusMode: ['manual', 'single-shot', 'continuous'], focusDistance: { min: 0.1, max: 5, step: 0.01 } };
const fc = focusCaps(CAPS);

// deterministic noise
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

/** A lens and a scene at D0 diopters. Sharpness peaks are wide for the coarse patch, narrow for the fine one. */
function sim(D0, { flat = false, noise = 0.03, seed = 1 } = {}) {
  const r = rng(seed);
  let lens = 1;
  const g = (d, s) => Math.exp(-(d * d) / (2 * s * s));
  return {
    moves: 0,
    async setD(D) { this.moves++; lens = 1 / distanceFor(D, fc) || 0; if (D <= fc.dFar + 1e-6) lens = fc.dFar; return true; },
    async measure(scale) {
      const d = lens - D0;
      const v = flat ? 1 : scale === 'coarse' ? 1 + 6 * g(d, 0.9) : 1 + 10 * g(d, 0.22);
      return v * (1 + noise * (2 * r() - 1));
    },
    get lens() { return lens; },
  };
}

test('focusCaps reads Chrome-style capabilities', () => {
  assert.equal(fc.manual, true);
  assert.ok(Math.abs(fc.dNear - 8) < 1e-9, 'nearest search distance is capped at 12.5 cm');
  assert.ok(Math.abs(fc.dFar - 0.2) < 1e-9);
  assert.equal(focusCaps({ focusMode: ['continuous'] }).manual, false);
  assert.equal(focusCaps({}).manual, false);
  // unknown hyperfocal distance (reported as a huge number) means the far end is infinity
  assert.equal(focusCaps({ focusMode: ['manual'], focusDistance: { min: 0.1, max: 9.2e18 } }).dFar, 0);
  // fixed focus or nearly so
  assert.equal(focusCaps({ focusMode: ['manual'], focusDistance: { min: 0, max: 0 } }).manual, false);
  assert.equal(focusCaps({ focusMode: ['manual'], focusDistance: { min: 2, max: 5 } }).manual, false);
});

test('distanceFor stays inside the range', () => {
  assert.equal(distanceFor(0, fc), 5);
  assert.equal(distanceFor(100, fc), 0.1);
  assert.ok(Math.abs(distanceFor(3, fc) - 1 / 3) < 1e-9);
  assert.ok(distanceFor(1, fc) === 1);
});

test('parabolaPeak finds the vertex', () => {
  assert.ok(Math.abs(parabolaPeak(0, -1, 1, 0, 2, -1) - 1) < 1e-9);
  assert.ok(Math.abs(parabolaPeak(0, 0, 1, 1, 2, 0.5) - 1.1667) < 1e-3);
  assert.equal(parabolaPeak(0, 1, 1, 0, 2, 1), 1, 'a valley is not a peak');
});

for (const D0 of [0.25, 0.7, 1.5, 3, 5, 7.4]) {
  test(`full search finds a subject at ${(1 / D0).toFixed(2)} m`, async () => {
    const s = sim(D0, { seed: Math.round(D0 * 100) });
    const r = await findFocus({ fc, setD: (D) => s.setD(D), measure: (k) => s.measure(k), mode: 'full' });
    assert.equal(r.ok, true);
    assert.ok(Math.abs(s.lens - D0) < 0.15, `lens ${s.lens.toFixed(3)} D vs ${D0}`);
    assert.ok(r.steps <= 19, `${r.steps} steps`);
  });
}

test('a far subject stops the sweep early', async () => {
  const s = sim(0.5);
  const r = await findFocus({ fc, setD: (D) => s.setD(D), measure: (k) => s.measure(k), mode: 'full' });
  assert.ok(r.ok && r.steps <= 11, `${r.steps} steps`);
});

test('no detail anywhere: reports flat instead of guessing', async () => {
  const s = sim(2, { flat: true });
  const r = await findFocus({ fc, setD: (D) => s.setD(D), measure: (k) => s.measure(k), mode: 'full' });
  assert.equal(r.ok, false);
  assert.equal(r.flat, true);
});

test('local search from a nearby position is short', async () => {
  for (const [D0, start] of [[2, 2.35], [2, 1.6], [0.8, 0.8]]) {
    const s = sim(D0, { seed: 7 });
    await s.setD(start);
    const r = await findFocus({ fc, setD: (D) => s.setD(D), measure: (k) => s.measure(k), mode: 'local', D0: start });
    assert.ok(r.ok, 'ok');
    assert.ok(Math.abs(s.lens - D0) < 0.15, `lens ${s.lens.toFixed(3)} vs ${D0}`);
    assert.ok(r.steps <= 9, `${r.steps} steps`);
  }
});

test('local search far from the subject falls back to the full sweep', async () => {
  const s = sim(4, { seed: 3 });
  await s.setD(0.4);
  const r = await findFocus({ fc, setD: (D) => s.setD(D), measure: (k) => s.measure(k), mode: 'local', D0: 0.4 });
  assert.ok(r.ok);
  assert.ok(Math.abs(s.lens - 4) < 0.15, `lens ${s.lens}`);
});

test('abort and camera errors end the search cleanly', async () => {
  const s = sim(2);
  let n = 0;
  const r = await findFocus({ fc, setD: (D) => s.setD(D), measure: (k) => s.measure(k), mode: 'full', aborted: () => ++n > 3 });
  assert.equal(r.aborted, true);
  const r2 = await findFocus({ fc, setD: async () => false, measure: (k) => s.measure(k), mode: 'full' });
  assert.equal(r2.failed, true);
  const r3 = await findFocus({ fc, setD: (D) => s.setD(D), measure: async () => null, mode: 'full' });
  assert.equal(r3.failed, true);
});

// ---- sharpness measure on real pixels ----
function patch(w, h, f) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = f(x, y); const i = (y * w + x) * 4; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
  return d;
}
function blur(d, w, h, r) {
  const o = new Uint8ClampedArray(d.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, n = 0;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const xx = Math.min(w - 1, Math.max(0, x + dx)), yy = Math.min(h - 1, Math.max(0, y + dy));
      s += d[(yy * w + xx) * 4 + 1]; n++;
    }
    const i = (y * w + x) * 4; o[i] = o[i + 1] = o[i + 2] = s / n; o[i + 3] = 255;
  }
  return o;
}

test('sharpnessOf: blur lowers sharpness; brightness alone does not', () => {
  const W = 64;
  const tex = (x, y) => 60 + 120 * (((x >> 2) + (y >> 2)) & 1) + ((x * 7 + y * 13) % 11);
  const sharp = patch(W, W, tex);
  const a = sharpnessOf(sharp, W, W), b = sharpnessOf(blur(sharp, W, W, 1), W, W), c = sharpnessOf(blur(sharp, W, W, 2), W, W);
  assert.ok(a.fine > 1.5 * b.fine && b.fine > 1.5 * c.fine, `fine ${a.fine} > ${b.fine} > ${c.fine}`);
  const dim = sharpnessOf(patch(W, W, (x, y) => tex(x, y) * 0.6), W, W);
  assert.ok(Math.abs(dim.fine / a.fine - 1) < 0.2, 'normalised by brightness');
  assert.ok(sigDiff(a.sig, dim.sig) < 0.05, 'layout signature ignores exposure');
  const other = sharpnessOf(patch(W, W, (x, y) => (x < 32 ? 40 : 200)), W, W);
  assert.ok(sigDiff(a.sig, other.sig) > 0.3, 'a different scene has a different signature');
  const flat = sharpnessOf(patch(W, W, () => 128), W, W);
  assert.ok(flat.contrast < 0.01 && flat.fine < 1e-6);
});

test('RefocusWatch: a new scene held still triggers; jitter and motion do not', () => {
  const W = 32;
  const A = sharpnessOf(patch(W, W, (x, y) => 60 + 3 * x + 2 * y), W, W);
  const A2 = sharpnessOf(patch(W, W, (x, y) => 62 + 3 * x + 2 * y), W, W); // hand jitter
  const B = sharpnessOf(patch(W, W, (x, y) => (y < 16 ? 220 : 40)), W, W);
  const C = sharpnessOf(patch(W, W, (x, y) => (x < 16 ? 220 : 40)), W, W);
  const w = new RefocusWatch();
  let t = 0;
  assert.equal(w.push(A, t), false);
  for (let k = 0; k < 6; k++) assert.equal(w.push(k % 2 ? A : A2, t += 300), false, 'same scene');
  assert.equal(w.push(B, t += 300), false, 'moving');
  assert.equal(w.push(C, t += 300), false, 'moving');
  let fired = false;
  for (let k = 0; k < 4 && !fired; k++) fired = w.push(C, t += 300);
  assert.equal(fired, true, 'held still on something new');
  w.reset(C.sig);
  for (let k = 0; k < 5; k++) assert.equal(w.push(C, t += 300), false, 'after refocusing');
});
