// Quick color-vision self-test (rough estimate, inspired by the Cambridge Colour Test).
//
// A Landolt-C made of dots is shown on a field of dots. Dot luminance is randomly
// jittered so only chromaticity can reveal the C. The C differs from the background
// along one confusion axis: the linear-RGB direction that the Machado (2009) model of
// a full protanope / deuteranope / tritanope attenuates most (smallest singular vector).
// A 2-down/1-up staircase finds the contrast threshold per axis; the threshold is
// converted to a severity with the same model: the severity at which the simulated
// colour difference at threshold equals a normal observer's ΔE threshold.
import { mat3Inverse, mat3MulVec, machadoMatrix } from './cvd.js';
import { linearToSrgb, rgbToLab, deltaE2000 } from './color.js';

const GRAY = 0.2; // background linear gray
const JIT = [0.72, 1.12]; // luminance jitter range
const AXES = ['protan', 'deutan', 'tritan'];
const MAX_TRIALS = 9;
const MAX_REVERSALS = 3;
const NORMAL_DE = 3.5; // assumed normal detection threshold (ΔE2000) for this noisy stimulus

const DIRS = {};
/** Unit linear-RGB direction least visible to a full dichromat of this type. */
export function axisDir(axis) {
  if (DIRS[axis]) return DIRS[axis];
  const M = machadoMatrix(axis, 1);
  // A = MᵀM (+ε), inverse power iteration -> eigenvector of the smallest eigenvalue
  const A = new Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    let v = 0;
    for (let k = 0; k < 3; k++) v += M[k * 3 + i] * M[k * 3 + j];
    A[i * 3 + j] = v + (i === j ? 1e-6 : 0);
  }
  const Ai = mat3Inverse(A);
  let x = [0.577, 0.577, 0.577];
  for (let it = 0; it < 40; it++) {
    x = mat3MulVec(Ai, x);
    const n = Math.hypot(...x); x = x.map((v) => v / n);
  }
  if (x[1] < 0) x = x.map((v) => -v); // point toward "greener"
  DIRS[axis] = x;
  return x;
}

export function maxContrast(dir) {
  let m = Infinity;
  for (const v of dir) {
    if (v > 0) m = Math.min(m, (1 / JIT[1] - GRAY) / v);
    else if (v < 0) m = Math.min(m, GRAY / -v);
  }
  return m * 0.98;
}

function to8(lin) { return lin.map((v) => Math.round(linearToSrgb(Math.max(0, Math.min(1, v))) * 255)); }

/** Perceived ΔE between background and target (contrast c) for a viewer of given type/severity. */
export function perceivedDE(axis, c, type, severity) {
  const dir = axisDir(axis);
  const bg = [GRAY, GRAY, GRAY];
  const tg = bg.map((v, k) => v + c * dir[k]);
  const M = machadoMatrix(type, severity);
  return deltaE2000(rgbToLab(...to8(mat3MulVec(M, bg))), rgbToLab(...to8(mat3MulVec(M, tg))));
}

/** Severity (0..1) implied by one threshold on its own axis, given the viewer's detection ΔE. */
export function severityFromThreshold(axis, c, failedAtMax, baseDE = NORMAL_DE) {
  if (failedAtMax) return 1;
  if (perceivedDE(axis, c, axis, 0) <= baseDE) return 0;
  for (let s = 0.05; s <= 1.0001; s += 0.05) {
    if (perceivedDE(axis, c, axis, s) <= baseDE) return Math.round(s * 100) / 100;
  }
  return 1;
}

/**
 * Joint fit over all three thresholds. At threshold, the perceived difference should equal the
 * viewer's own detection criterion on every axis, so for the right hypothesis (type, severity) the
 * predicted ΔEs are all equal. The criterion itself is unknown (screen, lighting, person), so it is
 * fitted too: we minimise the variance of log ΔE across axes. Failures at maximum contrast are
 * one-sided constraints (predicted ΔE must not exceed the criterion).
 * thresholds = {protan: {c, failed}, deutan: {...}, tritan: {...}}
 */
export function fitObserver(thresholds) {
  const seen = AXES.filter((a) => !thresholds[a].failed);
  if (!seen.length) return { type: 'deutan', severity: 1, allFailed: true, perType: { protan: 1, deutan: 1, tritan: 1 } };
  const evalHyp = (type, sev) => {
    const logs = seen.map((a) => Math.log(Math.max(1e-3, perceivedDE(a, thresholds[a].c, type, sev))));
    const mean = logs.reduce((x, y) => x + y, 0) / logs.length;
    let err = logs.reduce((x, y) => x + (y - mean) ** 2, 0);
    for (const a of AXES) {
      if (!thresholds[a].failed) continue;
      const lp = Math.log(Math.max(1e-3, perceivedDE(a, thresholds[a].c, type, sev)));
      if (lp > mean) err += (lp - mean) ** 2;
    }
    return err;
  };
  const normalErr = evalHyp('deutan', 0);
  let best = { type: 'deutan', severity: 0, err: normalErr };
  const perType = {}, perTypeErr = {};
  for (const type of AXES) {
    let tb = { s: 0, err: normalErr };
    for (let k = 1; k <= 20; k++) {
      const sev = k / 20, err = evalHyp(type, sev);
      if (err < tb.err - 1e-9) tb = { s: sev, err };
    }
    perType[type] = tb.s;
    perTypeErr[type] = tb.err;
    if (tb.err < best.err) best = { type, severity: tb.s, err: tb.err };
  }
  // protan and deutan confusion lines are close together; deutan is ~4× more common,
  // so prefer it unless protan fits clearly better.
  if (best.type === 'protan' && perTypeErr.deutan - best.err < 0.04 && perType.deutan > 0) {
    best = { type: 'deutan', severity: perType.deutan, err: perTypeErr.deutan };
  }
  // parsimony: only report a deficiency if it explains the data clearly better than normal vision
  const normal = best.severity < 0.2 || normalErr - best.err < 0.06;
  return { type: best.type, severity: normal ? 0 : best.severity, perType, perTypeErr, normalErr, allFailed: false };
}

export class SelfTest {
  constructor({ root, canvas, t, onApply }) {
    this.root = root; this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.t = t; this.onApply = onApply;
    this.el = (id) => root.querySelector('#' + id);
    this.el('btnTestStart').addEventListener('click', () => this.start());
    this.el('btnTestRetry').addEventListener('click', () => this.start());
    this.el('btnTestApply').addEventListener('click', () => { if (this.result) this.onApply(this.result.type, this.result.severity); });
    root.querySelectorAll('.dir-pad button').forEach((b) => b.addEventListener('click', () => this.answer(+b.dataset.dir)));
  }

  show(which) {
    this.el('testIntro').hidden = which !== 'intro';
    this.el('testRun').hidden = which !== 'run';
    this.el('testResult').hidden = which !== 'result';
  }

  reset() { this.show('intro'); }
  stop() { this.show('intro'); }

  layout() {
    // random non-overlapping dots inside the disc
    const W = this.canvas.width, R = W / 2 - 6, cx = W / 2, cy = W / 2;
    const dots = [];
    const cell = 26, grid = new Map();
    const key = (x, y) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
    for (let tries = 0; tries < 14000 && dots.length < 1100; tries++) {
      const r = 5 + Math.random() * 8;
      const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * (R - r);
      const x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d;
      let ok = true;
      const gx = Math.floor(x / cell), gy = Math.floor(y / cell);
      for (let i = -1; i <= 1 && ok; i++) for (let j = -1; j <= 1 && ok; j++) {
        const list = grid.get(`${gx + i},${gy + j}`);
        if (list) for (const o of list) if (Math.hypot(o.x - x, o.y - y) < o.r + r + 1.5) { ok = false; break; }
      }
      if (!ok) continue;
      const dot = { x, y, r };
      dots.push(dot);
      const k = key(x, y);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(dot);
    }
    this.dots = dots;
  }

  start() {
    this.layout();
    this.stairs = {};
    for (const axis of AXES) {
      const dir = axisDir(axis), max = maxContrast(dir);
      this.stairs[axis] = { dir, max, c: max * 0.75, n: 0, streak: 0, last: 0, revs: [], done: false, failsAtMax: 0 };
    }
    this.trial = 0;
    this.result = null;
    this.show('run');
    this.next();
  }

  next() {
    const open = AXES.filter((a) => !this.stairs[a].done);
    if (!open.length) { this.finish(); return; }
    this.axis = open[Math.floor(Math.random() * open.length)];
    this.dirAns = Math.floor(Math.random() * 4);
    this.trial++;
    this.el('testProgress').textContent = this.t('test.progress', { i: this.trial, n: AXES.length * MAX_TRIALS });
    this.draw();
  }

  draw() {
    const { ctx, canvas } = this, W = canvas.width, cx = W / 2, cy = W / 2;
    const st = this.stairs[this.axis];
    const Ro = W * 0.33, Ri = W * 0.2, gapHalf = (Ro - Ri) * 0.55;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, W);
    for (const d of this.dots) {
      const dx = d.x - cx, dy = d.y - cy, rr = Math.hypot(dx, dy);
      let inC = rr > Ri && rr < Ro;
      if (inC) {
        // gap: a slot in the answer direction
        const [ux, uy] = [[0, -1], [1, 0], [0, 1], [-1, 0]][this.dirAns];
        const along = dx * ux + dy * uy, across = Math.abs(-dx * uy + dy * ux);
        if (along > 0 && across < gapHalf) inC = false;
      }
      const f = JIT[0] + Math.random() * (JIT[1] - JIT[0]);
      const base = inC ? [GRAY + st.c * st.dir[0], GRAY + st.c * st.dir[1], GRAY + st.c * st.dir[2]] : [GRAY, GRAY, GRAY];
      const rgb = to8(base.map((v) => v * f));
      ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
      ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2); ctx.fill();
    }
  }

  answer(dir) {
    if (this.el('testRun').hidden) return;
    const st = this.stairs[this.axis];
    const correct = dir === this.dirAns;
    st.n++;
    const step = 0.62;
    let move = 0;
    if (correct) {
      st.streak++;
      if (st.streak >= 2) { st.streak = 0; move = -1; }
    } else {
      st.streak = 0; move = 1;
      if (st.c >= st.max * 0.999) st.failsAtMax++;
    }
    if (move) {
      if (st.last && move !== st.last) st.revs.push(st.c);
      st.last = move;
      st.c = move < 0 ? st.c * step : Math.min(st.max, st.c / step);
    }
    if (st.revs.length >= MAX_REVERSALS || st.n >= MAX_TRIALS || st.failsAtMax >= 2) st.done = true;
    this.next();
  }

  finish() {
    const th = {};
    for (const axis of AXES) {
      const st = this.stairs[axis];
      const levels = st.revs.length ? st.revs : [st.c];
      th[axis] = { c: Math.exp(levels.reduce((x, v) => x + Math.log(v), 0) / levels.length), failed: st.failsAtMax >= 2 };
    }
    const fit = fitObserver(th);
    this.fit = fit;
    const t = this.t;
    let text;
    if (fit.allFailed) {
      this.result = { type: fit.type, severity: 100 };
      text = t('test.allHigh');
    } else if (fit.severity === 0) {
      this.result = null;
      text = t('test.normal');
    } else {
      const severity = Math.round(fit.severity * 20) * 5;
      this.result = { type: fit.type, severity };
      text = t('test.found', { type: t('cvd.' + fit.type), sev: severity });
    }
    this.el('testResultText').textContent = text;
    this.el('btnTestApply').hidden = !this.result;
    const bars = this.el('testBars');
    bars.innerHTML = '';
    for (const axis of AXES) {
      const v = this.result ? Math.round((axis === this.result.type ? this.result.severity / 100 : fit.perType[axis]) * 100) : 0;
      const row = document.createElement('div');
      row.className = 'bar' + (this.result && axis === this.result.type ? ' best' : '');
      row.innerHTML = `<span>${t('cvd.' + axis)}</span><span class="track"><span class="fill" style="width:${v}%"></span></span><span>${v}%</span>`;
      bars.appendChild(row);
    }
    this.show('result');
  }
}
