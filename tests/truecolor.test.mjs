// True-colour tests: the JS algorithms against the Python simulation (论文资料/真色测量调研), chart
// geometry, saturation calibration, and the camera sequences against a simulated camera.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LIN } from '../docs/js/color.js';
import { nameColor, basicAlternative } from '../docs/js/naming.js';
import { estimateWB } from '../docs/js/wb.js';
import {
  frameStats, passiveEstimate, paperEstimate, torchEstimate, fitChart, orientAndFit, patchCenters, CHARTS, CC24_REF,
  linToLab, linToSrgb8, deltaELin, addSatPoint, satAt, printCalibration, printCardSVG, luma, withLuma,
  makeProfile, calibrationFor,
} from '../docs/js/truecolor.js';
import { verifyManualExposure, torchMeasure, measureCaps } from '../docs/js/measure.js';
import { deltaE2000 } from '../docs/js/color.js';

const FX = JSON.parse(readFileSync(new URL('./fixtures/truecolor_sim.json', import.meta.url)));
const lin8 = (c) => [LIN[c[0]], LIN[c[1]], LIN[c[2]]];
const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor((s.length - 1) / 2)]; };

/** The scene of a fixture as a small analysis frame: background bands, target in the middle, the
 *  white card right next to it (as the user would put it). Returns {img, soft, sx, sy}. */
function sceneImage(f, withCard = true) {
  const W = 64, H = 48, data = new Uint8ClampedArray(W * H * 4), soft = new Float32Array(W * H);
  const tot = f.bg.reduce((s, t) => s + t[3], 0);
  let acc = 0;
  const edges = f.bg.map((t) => (acc += t[3] / tot));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, u = (i + 0.5) / (W * H);
    let k = 0; while (k < edges.length - 1 && u > edges[k]) k++;
    let c = f.bg[k];
    if (Math.abs(x - W / 2) < 10 && Math.abs(y - H / 2) < 8) { c = f.target; soft[i] = 1; }
    else if (withCard && x >= W / 2 + 11 && x < W / 2 + 19 && y >= H / 2 - 4 && y < H / 2 + 4) c = f.card;
    data[i * 4] = c[0]; data[i * 4 + 1] = c[1]; data[i * 4 + 2] = c[2]; data[i * 4 + 3] = 255;
  }
  return { img: { width: W, height: H, data }, soft, sx: W / 2, sy: H / 2, cardAt: { x: (W / 2 + 15) / W, y: (H / 2) / H, r: 3 / W } };
}

function nameOk(lin, f) {
  const n = nameColor(...linToSrgb8(lin)).basicKey;
  return n === f.truth || n === f.truthAlt;
}

test('true colour vs the simulation: camera-only, paper, chart, printed card, torch + paper', () => {
  const de = { A: [], B: [], C: [], E: [], E2: [], CD: [] }, sim = { A: [], B: [], C: [], E: [], E2: [], CD: [] };
  const ok = { A: 0, B: 0, C: 0, E: 0, CD: 0 }, n = { A: 0, B: 0, C: 0, E: 0, CD: 0 };
  let paperFound = 0, paperTried = 0, paperWrong = 0, paperAuto = 0;
  for (const f of FX) {
    const truth = f.truthLab;
    const { img, soft, sx, sy, cardAt } = sceneImage(f);
    const wb = estimateWB(img.data, img.width, img.height, soft);
    const gains = wb.gains;
    const st = frameStats(img, { gains, soft, sx, sy });
    const raw = lin8(f.target);
    // existing app path (reference): WB gains only
    const a = raw.map((v, k) => Math.min(1, v * gains[k]));
    de.A.push(deltaE2000(linToLab(a), truth)); sim.A.push(f.sim.A); n.A++; if (nameOk(a, f)) ok.A++;
    // ① camera only
    const b = passiveEstimate(raw, { gains, mean: st.mean, anchor: st.anchor }).lin;
    de.B.push(deltaE2000(linToLab(b), truth)); sim.B.push(f.sim.B); n.B++; if (nameOk(b, f)) ok.B++;
    // ② paper: found automatically next to the target when it is the brightest neutral there and in
    // the light of the scene; otherwise the user taps it (e.g. paper in the object's shadow)
    if (f.kt === 1 && !f.card.some((v) => v >= 250)) { paperTried++; if (st.paper.found) paperFound++; }
    // an automatic find must be the sheet, not a bright background surface (a wall, a table)
    if (st.paper.found) { paperAuto++; if (deltaELin(st.paper.rgb, lin8(f.card)) > 3) paperWrong++; }
    const sp = st.paper.found ? st : frameStats(img, { gains, soft, sx, sy, paperAt: cardAt });
    if (sp.paper.found && !sp.paper.clipped) {
      const c = paperEstimate(raw, { paper: sp.paper.rgb, mean: st.mean }).lin;
      de.C.push(deltaE2000(linToLab(c), truth)); sim.C.push(f.sim.C); n.C++; if (nameOk(c, f)) ok.C++;
    }
    // ④ chart / printed card
    const fit = fitChart(f.cc.map(lin8), CHARTS.cc24.ref, CHARTS.cc24.neutral);
    const e = fit.apply(raw);
    de.E.push(deltaE2000(linToLab(e), truth)); sim.E.push(f.sim.E); n.E++; if (nameOk(e, f)) ok.E++;
    const fit2 = fitChart(f.pr.map(lin8), CHARTS.print14.ref, CHARTS.print14.neutral);
    de.E2.push(deltaE2000(linToLab(fit2.apply(raw)), truth)); sim.E2.push(f.sim.E2);
    // ③ torch + paper at a locked exposure (only where the torch outshines the room)
    if (f.torchRatio >= 1) {
      const L = f.torchLin;
      const d = torchEstimate({ on: L.t_on, off: L.t_off, ref: { on: L.c_on, off: L.c_off } }).lin;
      de.CD.push(deltaE2000(linToLab(d), truth)); sim.CD.push(f.sim.CD); n.CD++; if (nameOk(d, f)) ok.CD++;
    }
  }
  const m = Object.fromEntries(Object.keys(de).map((k) => [k, [median(de[k]), median(sim[k])]]));
  // the JS port reproduces the simulation (same inputs, independent implementation)
  for (const k of ['B', 'C', 'E', 'E2', 'CD']) assert.ok(m[k][0] <= m[k][1] + 0.8, `${k}: js ${m[k][0].toFixed(2)} vs sim ${m[k][1].toFixed(2)}`);
  assert.ok(Math.abs(m.CD[0] - m.CD[1]) < 0.3, 'torch + paper should match the simulation closely');
  // the chart fit (root-polynomial) does better than the simulation's 3×3 matrix
  assert.ok(m.E[0] < m.E[1] - 0.4 && m.E[0] < 2.1, `chart ${m.E[0].toFixed(2)} vs sim (3×3) ${m.E[1].toFixed(2)}`);
  assert.ok(m.E2[0] < m.E2[1] && m.E2[0] < 3.6, `printed card ${m.E2[0].toFixed(2)} vs sim (3×3) ${m.E2[1].toFixed(2)}`);
  assert.ok(paperWrong <= 0.02 * paperAuto, `automatic paper wrong in ${paperWrong}/${paperAuto}`);
  // and every true-colour source beats the current RGB path
  for (const k of ['B', 'C', 'E', 'CD']) assert.ok(m[k][0] < 0.65 * m.A[0], `${k} ${m[k][0].toFixed(2)} vs current ${m.A[0].toFixed(2)}`);
  // (missed: tinted paper under a strongly coloured lamp, or paper on a surface just as bright and neutral)
  assert.ok(paperFound > 0.85 * paperTried, `paper found automatically in ${paperFound}/${paperTried}`);
  console.log('median ΔE js/sim', JSON.stringify(Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.map((x) => +x.toFixed(2))]))));
  const acc = (k) => ok[k] / n[k];
  assert.ok(acc('B') > acc('A') + 0.04 && acc('C') > 0.9 && acc('E') > 0.93 && acc('CD') > 0.93,
    `name accuracy A ${acc('A').toFixed(2)} B ${acc('B').toFixed(2)} C ${acc('C').toFixed(2)} E ${acc('E').toFixed(2)} CD ${acc('CD').toFixed(2)}`);
});

test('true colour: dim light no longer turns colours grey (3 lx and shadow fixtures)', () => {
  const ach = new Set(['white', 'gray', 'black']);
  let cur = 0, tc = 0, tot = 0;
  for (const f of FX.filter((x) => x.lux === 3 || x.kt < 1)) {
    if (ach.has(f.truth)) continue;
    const { img, soft, sx, sy, cardAt } = sceneImage(f);
    if (f.card.some((v) => v >= 250)) continue;
    const gains = estimateWB(img.data, img.width, img.height, soft).gains;
    const st = frameStats(img, { gains, soft, sx, sy, paperAt: cardAt });
    const raw = lin8(f.target);
    const now = nameColor(...linToSrgb8(raw.map((v, k) => v * gains[k]))).basicKey;
    const est = paperEstimate(raw, { paper: st.paper.rgb, mean: st.mean }).lin;
    const k = nameColor(...linToSrgb8(est)).basicKey;
    tot++; if (ach.has(now)) cur++; if (ach.has(k)) tc++;
  }
  // (white paper cannot undo the camera's own low-light desaturation; the simulation gives ~12 %)
  assert.ok(cur / tot > 0.2 && tc / tot < 0.12 && tc * 3 < cur, `greyed: current ${(cur / tot).toFixed(2)} → true colour ${(tc / tot).toFixed(2)} (n=${tot})`);
});

test('frame stats: a white sheet next to the object is found, a plain wall behind it is not', () => {
  const W = 120, H = 90;
  const make = (paper) => {
    const data = new Uint8ClampedArray(W * H * 4), soft = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      let c = [176, 174, 170];                                                // light wall
      if (Math.abs(x - 60) < 14 && Math.abs(y - 45) < 12) { c = [150, 70, 30]; soft[i] = 1; } // object
      else if (paper && x > 78 && x < 96 && y > 34 && y < 56) c = [236, 234, 228]; // paper
      data.set([c[0], c[1], c[2], 255], i * 4);
    }
    return frameStats({ width: W, height: H, data }, { gains: [1, 1, 1], soft, sx: 60, sy: 45 });
  };
  const withPaper = make(true), wallOnly = make(false);
  assert.ok(withPaper.paper.found, 'paper found');
  assert.ok(Math.abs(withPaper.paper.cx - 87 / 120) < 0.05, `paper centre ${withPaper.paper.cx}`);
  assert.ok(!wallOnly.paper.found, 'a wall filling the view is not taken as paper');
  assert.ok(wallOnly.anchor && wallOnly.anchor.neutral, 'the wall still anchors lightness');
});

test('passive estimate: the same orange in dim light keeps its name; lightness follows the white anchor', () => {
  const orange = [0.75, 0.2, 0.03];               // true linear colour
  const anchor = { Y: 0.85, neutral: true };      // white wall in good light
  for (const dim of [1, 0.3, 0.1]) {
    const raw = orange.map((v) => v * dim);
    const est = passiveEstimate(raw, { gains: [1, 1, 1], anchor: { ...anchor, Y: anchor.Y * dim } });
    assert.ok(deltaELin(est.lin, orange) < 1, `dim ${dim}: ΔE ${deltaELin(est.lin, orange)}`);
    assert.equal(nameColor(...linToSrgb8(est.lin)).basicKey, 'orange');
  }
  // without a white reference the result is flagged
  const r = passiveEstimate(orange, { anchor: null });
  assert.equal(r.conf, 'low'); assert.ok(r.notes.includes('noAnchor'));
});

test('chart: patch grid from the four corner patches, any tap order and orientation', () => {
  // a virtual photo: the ColorChecker under a slight perspective, upside down, in a warm light
  const cc = CHARTS.cc24;
  const corners = [[300, 220], [90, 230], [95, 85], [292, 70]];      // TL..BL of the chart in the photo (rotated 180°)
  const pts = patchCenters(corners, cc.rows, cc.cols);
  const light = [1.15, 0.95, 0.6], expo = 0.7;
  const tone = (v) => Math.pow(Math.max(0, v), 1 / 1.08);          // camera tone curve ≠ sRGB
  const sample = (x, y) => {
    let best = -1, bd = 1e9;
    pts.forEach((p, i) => { const d = Math.hypot(p[0] - x, p[1] - y); if (d < bd) { bd = d; best = i; } });
    if (bd > 12) return [0.2, 0.2, 0.2];
    return cc.ref[best].map((v, k) => tone(Math.max(0, v) * light[k] * expo));
  };
  const taps = [corners[2], corners[0], corners[3], corners[1]];       // scrambled
  const best = orientAndFit(taps, sample, cc);
  assert.ok(best && best.fit.residual < 1.5, `residual ${best && best.fit.residual}`);
  // the fitted transform recovers an unseen colour under the same light
  const orange = [0.7, 0.22, 0.04];
  const seen = orange.map((v, k) => tone(v * light[k] * expo));
  assert.ok(deltaELin(best.fit.apply(seen), orange) < 3, `ΔE ${deltaELin(best.fit.apply(seen), orange)}`);
  // wrong taps (not on the chart) give a poor fit
  const bad = orientAndFit([[10, 10], [40, 10], [40, 40], [10, 40]], () => [0.3, 0.3, 0.3], cc);
  assert.ok(!bad || bad.fit.residual > 8);
});

test('chart: printed-card calibration through a ColorChecker in the same frame', () => {
  const light = [0.9, 1, 1.2];
  const seen = (c) => c.map((v, k) => Math.max(0, v) * light[k] * 0.8);
  const ccFit = fitChart(CC24_REF.map(seen), CC24_REF, CHARTS.cc24.neutral);
  // the real print is off from the design values
  const real = CHARTS.print14.ref.map((c, i) => c.map((v, k) => v * (1 + 0.08 * Math.sin(i * 3 + k))));
  const cal = printCalibration(ccFit, real.map(seen));
  const err = median(cal.map((c, i) => deltaELin(c, real[i])));
  assert.ok(err < 2, `calibrated print values ΔE ${err}`);
});

test('saturation calibration table: interpolates in log noise, only near calibrated levels', () => {
  let t = addSatPoint(null, 1e-4, 1.1);
  t = addSatPoint(t, 1e-3, 0.8);
  t = addSatPoint(t, 1.1e-3, 0.82); // replaces the near-duplicate
  assert.equal(t.length, 2);
  // levels 11× apart: no straight line across the gap, only the nearest level close to it
  assert.equal(satAt(t, Math.sqrt(1e-4 * 1.1e-3)), null);
  assert.equal(satAt(t, 1.5e-4), 1.1);
  // levels 3× apart: interpolated in log noise
  const t2 = addSatPoint(addSatPoint(null, 1e-4, 1.1), 3e-4, 0.8);
  assert.ok(Math.abs(satAt(t2, Math.sqrt(3e-8)) - 0.95) < 0.01);
  assert.equal(satAt(t, 1e-6), null);
  assert.equal(satAt([[1e-3, 0.8]], 1e-3 * 1.5), 0.8);
});

test('frame stats: paper in the shadow next to a lit wall is not mistaken for the wall', () => {
  // a light wall split by the object into a left and a right part; the sheet is in the object's shadow
  const W = 120, H = 90, data = new Uint8ClampedArray(W * H * 4), soft = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    let c = y < 36 || y > 56 ? [70, 60, 50] : [205, 203, 199];                 // floor / ceiling, wall band
    if (Math.abs(x - 60) < 14 && y >= 25 && y <= 68) { c = [150, 70, 30]; soft[i] = 1; } // object
    else if (x > 76 && x < 90 && y > 40 && y < 56) c = [110, 109, 106];        // paper in shadow
    data.set([c[0], c[1], c[2], 255], i * 4);
  }
  const st = frameStats({ width: W, height: H, data }, { gains: [1, 1, 1], soft, sx: 60, sy: 45 });
  assert.ok(!st.paper.found, `a piece of wall was taken as paper: ${JSON.stringify(st.paper)}`);
});

test('camera profile from a chart in good light makes white paper more accurate in other light', () => {
  // a camera with its own colour processing: extra saturation and a tone curve that is not sRGB
  const cam = (lin, light, expo) => {
    const x = lin.map((v, k) => Math.max(0, v) * light[k] * expo);
    const Y = luma(x);
    return x.map((v) => Math.pow(Math.max(0, Y + 1.25 * (v - Y)), 1 / 1.1));
  };
  const day = [1, 1, 1], lamp = [1.25, 0.95, 0.6];
  const meas = CC24_REF.map((c) => cam(c, day, 0.8));
  const prof = JSON.parse(JSON.stringify(makeProfile(meas, CHARTS.cc24, 2e-4)));   // as saved
  assert.ok(prof && prof.luts.length === 3 && prof.M.length === 3 && Math.abs(prof.sat - 1.25) < 0.2, `profile ${JSON.stringify(prof && prof.sat)}`);
  const paper = cam([0.85, 0.85, 0.85], lamp, 0.3);
  const colours = [[0.7, 0.22, 0.04], [0.1, 0.35, 0.12], [0.08, 0.12, 0.45], [0.5, 0.45, 0.1], [0.4, 0.1, 0.3]];
  let plain = 0, profiled = 0;
  for (const c of colours) {
    const raw = cam(c, lamp, 0.3);
    plain += deltaELin(paperEstimate(raw, { paper }).lin, c);
    const calib = calibrationFor({ profile: prof, sat: [] }, 2.5e-4);
    assert.ok(calib.profile, 'profile used near its own light level');
    profiled += deltaELin(paperEstimate(raw, { paper, ...calib }).lin, c);
  }
  // (not all the way: the camera clips the most saturated colours, which no profile can undo)
  assert.ok(profiled < 0.6 * plain && profiled / colours.length < 3, `paper ΔE ${(plain / 5).toFixed(2)} → ${(profiled / 5).toFixed(2)}`);
  // far from the profile's light level and with no saturation table there: not used
  assert.equal(calibrationFor({ profile: prof, sat: [] }, 5e-3).profile, null);
  // with a saturation point there: used, with the change of saturation since the profile
  const c2 = calibrationFor({ profile: prof, sat: [[5e-3, 0.7]] }, 5e-3);
  assert.ok(c2.profile && Math.abs(c2.sat - 0.7 / prof.sat) < 1e-9);
});

test('printable card SVG has 14 patches at real size', () => {
  const svg = printCardSVG();
  assert.equal((svg.match(/<rect x=/g) || []).length, 14);
  assert.match(svg, /width="\d+mm"/);
});

// ---------------- camera sequences against a simulated camera ----------------
class SimCam {
  constructor({ manualWorks = true, toneK = 1.1, ambient = [0.02, 0.018, 0.012], torch = [0.25, 0.25, 0.25], target = [0.6, 0.15, 0.05], paper = [0.85, 0.85, 0.85], torchCaps = true } = {}) {
    Object.assign(this, { manualWorks, toneK, ambient, torchLight: torch, target, paper, torchCaps });
    this.torch = false; this.manual = false; this.t = 333; this.iso = 400; this.autoT = 333;
    this.log = [];
  }
  caps() {
    return { torch: this.torchCaps, exposureMode: ['continuous', 'manual'], exposureTime: { min: 1, max: 3330, step: 1 }, iso: { min: 50, max: 3200, step: 1 },
      whiteBalanceMode: ['continuous', 'manual'], colorTemperature: { min: 2850, max: 7000, step: 50 } };
  }
  settings() { return { exposureTime: this.manual ? this.t : this.autoT }; }
  async apply(c) {
    this.log.push(c);
    if ('torch' in c) this.torch = !!c.torch;
    if (c.exposureMode === 'continuous') this.manual = false;
    if (c.exposureMode === 'manual' && this.manualWorks) { this.manual = true; if (c.exposureTime) this.t = c.exposureTime; if (c.iso) this.iso = c.iso; }
    return true;
  }
  light(rho) { return rho.map((r, k) => r * (this.ambient[k] + (this.torch ? this.torchLight[k] : 0))); }
  async read() {
    let gain;
    if (this.manual) gain = (this.t / 333) * (this.iso / 400) * 4;
    else { const y = luma(this.light([0.3, 0.3, 0.3])); gain = 0.18 / y; this.autoT = 333; }
    const out = (rho) => this.light(rho).map((v) => Math.pow(Math.min(1, v * gain), 1 / this.toneK));
    const t = out(this.target), ref = out(this.paper);
    return { t, ref, tClip: Math.max(...t) >= 1 ? 1 : 0, refClip: Math.max(...ref) >= 1 ? 1 : 0 };
  }
}
const nosleep = async () => {};

test('manual exposure check: detects a camera that ignores it and fits the tone exponent', async () => {
  const good = new SimCam({ toneK: 1.12 });
  const v = await verifyManualExposure(good, () => good.read(), nosleep);
  assert.ok(v.ok, JSON.stringify(v));
  for (const k of v.toneK) assert.ok(Math.abs(k - 1.12) < 0.03, `toneK ${v.toneK}`);
  assert.equal(good.manual, false, 'back to auto exposure afterwards');
  const fake = new SimCam({ manualWorks: false });
  const w = await verifyManualExposure(fake, () => fake.read(), nosleep);
  assert.equal(w.ok, false); assert.equal(w.reason, 'noEffect');
});

test('torch measurement with paper recovers the object colour regardless of the room light', async () => {
  for (const ambient of [[0.02, 0.018, 0.012], [0.03, 0.02, 0.004]]) {  // neutral-ish / very warm room
    const cam = new SimCam({ ambient, toneK: 1.1 });
    const res = await torchMeasure(cam, () => cam.read(), nosleep, { hasRef: true, ct: 5000 });
    assert.ok(!res.error, res.error);
    assert.equal(res.wb, 'preset');
    const tone = (c) => c.map((v) => Math.pow(v, 1.1));
    const est = torchEstimate({ on: tone(res.on), off: tone(res.off), ref: { on: tone(res.refOn), off: tone(res.refOff) } });
    assert.ok(est.ratio > 1);
    assert.ok(deltaELin(est.lin, cam.target) < 1.5, `ΔE ${deltaELin(est.lin, cam.target)} in ${ambient}`);
    assert.equal(cam.torch, false); assert.equal(cam.manual, false);
  }
  const noTorch = new SimCam({ torchCaps: false });
  assert.equal((await torchMeasure(noTorch, () => noTorch.read(), nosleep, {})).error, 'noTorch');
  assert.deepEqual(measureCaps({}).torch, false);
});

test('camera sequences: too dark to verify, and a scene that stays blown out', async () => {
  const dark = new SimCam({ ambient: [1e-6, 1e-6, 1e-6], torch: [1e-6, 1e-6, 1e-6] });
  const v = await verifyManualExposure(dark, () => dark.read(), nosleep);
  assert.equal(v.ok, false); assert.equal(v.reason, 'tooDark');
  // a dim room: with the torch on during the check there is enough light, and it goes off again
  const dim = new SimCam({ ambient: [1e-4, 1e-4, 1e-4] });
  const w = await verifyManualExposure(dim, () => dim.read(), nosleep, { torch: true });
  assert.ok(w.ok, JSON.stringify(w)); assert.equal(dim.torch, false);
  // a camera whose exposure cannot go short enough: the torch-lit paper stays clipped
  const hot = new SimCam({ torch: [40, 40, 40] });
  hot.caps = () => ({ ...SimCam.prototype.caps.call(hot), exposureTime: { min: 300, max: 3330 }, iso: { min: 400, max: 400 } });
  const r = await torchMeasure(hot, () => hot.read(), nosleep, { hasRef: true });
  assert.equal(r.error, 'clipped');
  assert.equal(hot.torch, false, 'torch switched off after an error');
});
