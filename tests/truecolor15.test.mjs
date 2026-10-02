// v1.5 true-colour improvements: shadows, torch without paper, "not sure" names, mixed light,
// where the white anchor is, the default saturation curve, automatic chart detection, validation on
// a phone, and the per-pixel (GPU) transform. Simulation fixtures as in truecolor.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LIN, deltaE2000, linearToSrgb } from '../docs/js/color.js';
import { classifyBasic } from '../docs/js/naming.js';
import { estimateWB } from '../docs/js/wb.js';
import {
  frameStats, passiveEstimate, paperEstimate, torchEstimate, chooseAnchor, blendGains, nameAmbiguity, uncertaintyOf,
  defaultSatAt, calibrationFor, gpuParams, applyGpuParams, validateChart, fitChart, chartEstimate, orientAndFit,
  CHARTS, CC24_REF, PRINT_CARD_SRGB, linToLab, linToSrgb8, deltaELin, luma,
} from '../docs/js/truecolor.js';
import { detectChart, findChart } from '../docs/js/chartdetect.js';

const FX = JSON.parse(readFileSync(new URL('./fixtures/truecolor_sim.json', import.meta.url)));
const lin8 = (c) => [LIN[c[0]], LIN[c[1]], LIN[c[2]]];
const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(p * (s.length - 1))]; };
const nameOk = (lin, f) => { const n = classifyBasic(...linToSrgb8(lin)); return n === f.truth || n === f.truthAlt; };

/** Same scene construction as truecolor.test.mjs: background bands, target, optional white card next to it. */
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
  return { img: { width: W, height: H, data }, soft, sx: W / 2, sy: H / 2 };
}
function stats(f, card) {
  const sc = sceneImage(f, card);
  const gains = estimateWB(sc.img.data, 64, 48, sc.soft).gains;
  return { gains, st: frameStats(sc.img, { gains, soft: sc.soft, sx: sc.sx, sy: sc.sy }) };
}

test('shadow: an object in a shadow next to a white surface is measured against that surface', () => {
  const de = { shadowOld: [], shadowNew: [], litOld: [], litNew: [] };
  for (const f of FX) {
    const raw = lin8(f.target);
    const { gains, st } = stats(f, true);
    const old = passiveEstimate(raw, { gains, mean: st.mean, anchor: st.anchor });
    const now = passiveEstimate(raw, { gains, mean: st.mean, anchor: st.anchor, localAnchor: st.localAnchor });
    const k = f.kt < 1 ? 'shadow' : 'lit';
    de[k + 'Old'].push(deltaE2000(linToLab(old.lin), f.truthLab)); de[k + 'New'].push(deltaE2000(linToLab(now.lin), f.truthLab));
  }
  const m = Object.fromEntries(Object.entries(de).map(([k, v]) => [k, q(v, 0.5)]));
  assert.ok(m.shadowNew < 0.7 * m.shadowOld, `shadow ${m.shadowOld.toFixed(2)} → ${m.shadowNew.toFixed(2)}`);
  assert.ok(m.litNew < m.litOld + 0.6, `lit ${m.litOld.toFixed(2)} → ${m.litNew.toFixed(2)}`);
  // the user can turn it off, and the choice is reported
  const a = { Y: 0.8, neutral: true }, la = { Y: 0.2, at: { x: 0, y: 0, w: 0.1, h: 0.1 } };
  assert.equal(chooseAnchor({ anchor: a, localAnchor: la, Y: 0.05 }).local, true);
  assert.equal(chooseAnchor({ anchor: a, localAnchor: la, Y: 0.05, shadow: 'off' }).local, false);
  assert.equal(chooseAnchor({ anchor: a, localAnchor: la, Y: 0.3 }).local, false, 'an object brighter than its neighbour is not in its shadow');
});

test('torch without paper: torch colour with the white anchor\'s lightness beats camera only', () => {
  const cam = [], hyb = [];
  for (const f of FX) {
    if (f.torchRatio < 1 || f.kt < 1) continue;
    const raw = lin8(f.target), L = f.torchLin;
    const { gains, st } = stats(f, false);
    const pe = passiveEstimate(raw, { gains, mean: st.mean, anchor: st.anchor });
    // torch calibration = torch-only colour of white paper (here: the card at the same distance)
    const white = L.c_on.map((v, k) => v - L.c_off[k]);
    const e = torchEstimate({ on: L.t_on, off: L.t_off, cal: { white }, anchorY: luma(pe.lin) });
    assert.equal(e.source, 'torch+anchor');
    cam.push(deltaE2000(linToLab(pe.lin), f.truthLab)); hyb.push(deltaE2000(linToLab(e.lin), f.truthLab));
  }
  assert.ok(q(hyb, 0.5) < 0.75 * q(cam, 0.5), `camera only ${q(cam, 0.5).toFixed(2)} → torch + anchor ${q(hyb, 0.5).toFixed(2)}`);
});

test('"not sure" names: flagged readings are the uncertain ones, and the second name is often right', () => {
  let n = 0, flagged = 0, okFlagged = 0, okUnflagged = 0, wrong = 0, wrongCovered = 0;
  for (const f of FX) {
    const raw = lin8(f.target);
    const { gains, st } = stats(f, false);
    const e = passiveEstimate(raw, { gains, mean: st.mean, anchor: st.anchor, localAnchor: st.localAnchor });
    const amb = nameAmbiguity(e.lin, uncertaintyOf(e));
    const ok = nameOk(e.lin, f);
    n++;
    if (amb) { flagged++; if (ok) okFlagged++; } else if (ok) okUnflagged++;
    if (!ok) { wrong++; if (amb && (amb.alt === f.truth || amb.alt === f.truthAlt)) wrongCovered++; }
  }
  const accF = okFlagged / flagged, accU = okUnflagged / (n - flagged);
  assert.ok(flagged / n > 0.1 && flagged / n < 0.5, `flagged ${flagged}/${n}`);
  assert.ok(accF < accU - 0.15, `accuracy flagged ${accF.toFixed(2)} vs not ${accU.toFixed(2)}`);
  assert.ok(wrongCovered >= 0.4 * wrong, `second name right in ${wrongCovered}/${wrong} wrong readings`);
  // a colour far from any boundary is not flagged
  assert.equal(nameAmbiguity([0.02, 0.05, 0.6], [0.3, 0.25]), null);
});

/** A warm lamp on the left part of the view, daylight on the right; the object is on the lamp side. */
function mixedScene(target, split, seedIn = 5) {
  const W = 120, H = 90, enc = (v) => Math.round(linearToSrgb(Math.max(0, Math.min(1, v))) * 255);
  const lamp = [1.25, 0.95, 0.5], day = [0.85, 1, 1.25];
  let seed = seedIn; const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const data = new Uint8ClampedArray(W * H * 4), soft = new Float32Array(W * H);
  const blocks = Array.from({ length: 48 }, () => Math.floor(rng() * 24));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, bi = Math.floor(y / 15) * 8 + Math.floor(x / 15);
    let refl = bi % 3 === 0 ? [0.85, 0.85, 0.85] : CC24_REF[blocks[bi]].map((v) => Math.max(0.01, v));
    if (Math.abs(x - 30) < 9 && Math.abs(y - 45) < 9) { refl = target; soft[i] = 1; }
    const L = x < split * W ? lamp : day;
    for (let k = 0; k < 3; k++) data[i * 4 + k] = enc(refl[k] * L[k] * 0.7);
    data[i * 4 + 3] = 255;
  }
  const raw = target.map((v, k) => LIN[enc(v * lamp[k] * 0.7)]);
  return { img: { width: W, height: H, data }, soft, raw };
}

test('mixed light: the light next to the object is used when it clearly differs from the rest', () => {
  const g = [], b = [];
  CC24_REF.slice(0, 18).forEach((tg0, i) => {
    const tg = tg0.map((v) => Math.max(0.01, v));
    const { img, soft, raw } = mixedScene(tg, 0.5, 5 + i);
    const gains = estimateWB(img.data, img.width, img.height, soft).gains;
    const st = frameStats(img, { gains, soft, sx: 30, sy: 45 });
    const bl = blendGains(gains, st.localWB);
    g.push(deltaELin(passiveEstimate(raw, { gains, mean: st.mean, anchor: st.anchor }).lin, tg));
    b.push(deltaELin(passiveEstimate(raw, { gains: bl.gains, mean: st.mean, anchor: st.anchor }).lin, tg));
  });
  assert.ok(q(b, 0.5) < 0.7 * q(g, 0.5), `mixed light ${q(g, 0.5).toFixed(2)} → ${q(b, 0.5).toFixed(2)}`);
  // one light: (almost) never switches, and no harm
  let switched = 0, n = 0; const d0 = [], d1 = [];
  for (const f of FX) {
    const raw = lin8(f.target);
    const { gains, st } = stats(f, false);
    const bl = blendGains(gains, st.localWB); n++; if (bl.mixed) switched++;
    d0.push(deltaE2000(linToLab(passiveEstimate(raw, { gains, mean: st.mean, anchor: st.anchor }).lin), f.truthLab));
    d1.push(deltaE2000(linToLab(passiveEstimate(raw, { gains: bl.gains, mean: st.mean, anchor: st.anchor }).lin), f.truthLab));
  }
  assert.ok(switched < 0.15 * n, `switched in ${switched}/${n} one-light scenes`);
  assert.ok(q(d1, 0.5) < q(d0, 0.5) + 0.3, `one light ${q(d0, 0.5).toFixed(2)} → ${q(d1, 0.5).toFixed(2)}`);
});

test('frame stats: where the white anchor is (for the dashed box)', () => {
  const W = 120, H = 90, data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let c = [90, 70, 50];
    if (x >= 80 && x < 110 && y >= 10 && y < 40) c = [220, 218, 214]; // a white sheet, upper right
    data.set([...c, 255], (y * W + x) * 4);
  }
  const st = frameStats({ width: W, height: H, data }, { gains: [1, 1, 1] });
  const at = st.anchor.at;
  assert.ok(st.anchor.neutral && at, 'anchor found with a position');
  assert.ok(Math.abs(at.cx - 95 / 120) < 0.05 && Math.abs(at.cy - 25 / 90) < 0.06, `centre ${at.cx}, ${at.cy}`);
  assert.ok(at.w > 0.2 && at.w < 0.32 && at.h > 0.28 && at.h < 0.42, `size ${at.w} × ${at.h}`);
  // "this is light gray, not white": the object gets darker by the same factor
  const raw = [0.1, 0.05, 0.02];
  const w = passiveEstimate(raw, { anchor: st.anchor }), g = passiveEstimate(raw, { anchor: st.anchor, anchorRho: 0.6 });
  assert.ok(Math.abs(luma(g.lin) / luma(w.lin) - 0.6 / 0.85) < 0.01 && g.notes.includes('anchorUser'));
});

test('default low-light saturation curve: off in good light, half the loss in dim light, only when asked', () => {
  assert.equal(defaultSatAt(1e-5), null);
  assert.ok(Math.abs(defaultSatAt(1e-3) - 0.825) < 1e-6);
  assert.ok(defaultSatAt(2e-4) > 0.825 && defaultSatAt(2e-4) < 1);
  assert.equal(calibrationFor({}, 1e-3).sat, null);
  const c = calibrationFor({}, 1e-3, { defaultSat: true });
  assert.ok(Math.abs(c.sat - 0.825) < 1e-6 && c.satFrom === 'default');
  // a chart calibration wins over the default
  assert.equal(calibrationFor({ sat: [[1e-3, 0.7]] }, 1e-3, { defaultSat: true }).satFrom, 'chart');
});

// ---------------- automatic chart detection ----------------
const W = 327, H = 245;
function chartFrame({ chart = 'cc24', ang = 0, cx = 160, cy = 120, P = 16, gap = 4, bg = [90, 85, 80], gapc = [20, 20, 20], light = [1, 1, 1], noise = 2, tiles = false, seed0 = 9 } = {}) {
  let seed = seed0; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const d = new Uint8ClampedArray(W * H * 4);
  const cols = chart === 'cc24' ? 6 : 7, rows = chart === 'cc24' ? 4 : 2;
  const cols8 = chart === 'cc24' ? CC24_REF.map((c) => linToSrgb8(c.map((v, k) => Math.max(0, v) * light[k]))) : PRINT_CARD_SRGB;
  const pitch = P + gap, wTot = cols * pitch + gap, hTot = rows * pitch + gap;
  const ca = Math.cos(ang), sa = Math.sin(ang);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let c = bg;
    if (tiles) { c = (x % 20 < 3 || y % 20 < 3) ? [60, 60, 60] : [180 + ((Math.floor(x / 20) * 7 + Math.floor(y / 20) * 3) % 5) * 8, 170, 160]; }
    else if (chart) {
      const u = ca * (x - cx) + sa * (y - cy) + wTot / 2, v = -sa * (x - cx) + ca * (y - cy) + hTot / 2;
      if (u >= 0 && v >= 0 && u < wTot && v < hTot) {
        c = gapc;
        const iu = Math.floor((u - gap) / pitch), iv = Math.floor((v - gap) / pitch);
        if (u - gap - iu * pitch < P && v - gap - iv * pitch < P && iu >= 0 && iv >= 0 && iu < cols && iv < rows) c = cols8[iv * cols + iu];
      }
    }
    for (let k = 0; k < 3; k++) d[(y * W + x) * 4 + k] = c[k] + (rnd() - 0.5) * 2 * noise;
    d[(y * W + x) * 4 + 3] = 255;
  }
  return { width: W, height: H, data: d };
}

test('chart detection: ColorChecker and printed card in any orientation, and nothing in a tiled wall', () => {
  const cases = [
    [{}, 'cc24'], [{ ang: 0.35 }, 'cc24'], [{ ang: Math.PI }, 'cc24'], [{ P: 10, gap: 3 }, 'cc24'],
    [{ light: [1.0, 0.8, 0.45], gapc: [235, 235, 230] }, 'cc24'], [{ light: [1.2, 0.9, 0.5], gapc: [235, 235, 230] }, 'cc24'], [{ noise: 6 }, 'cc24'],
    [{ chart: 'print14', gapc: [245, 245, 245], P: 18 }, 'print14'], [{ chart: 'print14', gapc: [245, 245, 245], P: 18, ang: -0.3 }, 'print14'],
  ];
  for (const [opt, kind] of cases) {
    const img = chartFrame(opt);
    const r = findChart(img);
    assert.ok(r && r.kind === kind, `${JSON.stringify(opt)}: ${r && r.kind}`);
    assert.ok(r.residual < 1.5, `${JSON.stringify(opt)}: fit ${r.residual}`);
    assert.equal(r.meas.length, kind === 'cc24' ? 24 : 14);
  }
  assert.equal(detectChart(chartFrame({ tiles: true, chart: null })), null, 'tiled wall');
  assert.equal(detectChart(chartFrame({ chart: null })), null, 'plain wall');
});

// ---------------- validation and the GPU transform ----------------
/** A phone camera: warm light, exposure, its own extra saturation and tone curve. */
const camModel = (c, light = [1.15, 1, 0.7], expo = 0.4) => {
  const x = c.map((v, k) => Math.max(0, v) * light[k] * expo); const Y = luma(x);
  return x.map((v) => Math.pow(Math.max(0, Y + 1.15 * (v - Y)), 1 / 1.1));
};

test('validation on a phone: every source scored on the 24 patches, chart leave-one-out', () => {
  const meas = CC24_REF.map((c) => camModel(c));
  const gains = [0.9, 1, 1.3];
  const anchor = { Y: luma(camModel([0.9, 0.9, 0.9]).map((v, k) => v * gains[k])), neutral: true };
  const r = validateChart(meas, { gains, mean: [0.1, 0.1, 0.08], anchor, paper: null, defaultSat: 0.9 });
  const s = r.summary;
  assert.equal(r.paperFrom, 'chart');
  for (const k of ['picture', 'camera', 'cameraDefaultSat', 'paper', 'chart']) assert.ok(s[k], k);
  assert.equal(s.paper.n, 23, 'the white patch is the paper, so it is not scored itself');
  assert.ok(s.chart.median < s.paper.median && s.paper.median < s.picture.median && s.camera.median < s.picture.median,
    JSON.stringify(Object.fromEntries(Object.entries(s).map(([k, v]) => [k, +v.median.toFixed(2)]))));
  assert.ok(s.chart.names >= 22 && s.picture.names < s.chart.names);
});

test('GPU transform: the same numbers as the per-colour estimates', () => {
  const gains = [0.9, 1, 1.3], mean = [0.1, 0.1, 0.08];
  const anchor = { Y: 0.3, neutral: true }, paper = camModel([0.85, 0.85, 0.85]);
  const fit = fitChart(CC24_REF.map((c) => camModel(c)), CC24_REF, CHARTS.cc24.neutral);
  for (const tg of [[0.7, 0.22, 0.04], [0.1, 0.35, 0.12], [0.08, 0.12, 0.45], [0.4, 0.4, 0.38]]) {
    const raw = camModel(tg);
    const close = (a, b, what) => assert.ok(a.every((v, k) => Math.abs(v - Math.min(1, Math.max(0, b[k]))) < 1e-6), `${what}: ${a} vs ${b}`);
    close(applyGpuParams(gpuParams('camera', { gains, mean, anchor }), raw), passiveEstimate(raw, { gains, mean, anchor }).lin, 'camera');
    close(applyGpuParams(gpuParams('camera', { gains, mean, anchor, sat: 0.8 }), raw), passiveEstimate(raw, { gains, mean, anchor, sat: 0.8 }).lin, 'camera + sat');
    close(applyGpuParams(gpuParams('paper', { paper, mean }), raw), paperEstimate(raw, { paper, mean }).lin, 'paper');
    close(applyGpuParams(gpuParams('chart', { fit }), raw), chartEstimate(raw, fit, fit.residual).lin, 'chart');
  }
});
