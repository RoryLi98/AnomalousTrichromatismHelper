// Unit tests: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { rgbToLab, deltaE2000, hexToRgb, rgbToOklch, srgbToLinear, linearToSrgb, linRgbToOklab } from '../docs/js/color.js';
import { classifyBasic, nameColor, DETAILED, describe, basicAlternative } from '../docs/js/naming.js';
import { machadoMatrix, mat3Inverse, mat3MulVec, shaderParams, processColor, simulateColor } from '../docs/js/cvd.js';

test('CIEDE2000 matches Sharma et al. reference pairs', () => {
  // Pairs from Sharma, Wu & Dalal (2005) test data
  const pairs = [
    [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
    [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
    [[50, -1.3802, -84.2814], [50, 0, -82.7485], 1.0],
    [[50, 0, 0], [50, -1, 2], 2.3669],
    [[50, 2.5, 0], [73, 25, -18], 27.1492],
    [[2.0776, 0.0795, -1.135], [0.9033, -0.0636, -0.5514], 0.9082],
  ];
  for (const [a, b, e] of pairs) assert.ok(Math.abs(deltaE2000(a, b) - e) < 1e-3, `${deltaE2000(a, b)} vs ${e}`);
});

test('sRGB→Lab sanity', () => {
  const [L, a, b] = rgbToLab(255, 255, 255);
  assert.ok(Math.abs(L - 100) < 0.01 && Math.abs(a) < 0.01 && Math.abs(b) < 0.01);
  const red = rgbToLab(255, 0, 0);
  assert.ok(Math.abs(red[0] - 53.24) < 0.1 && Math.abs(red[1] - 80.09) < 0.2);
});

test('basic categories for canonical colors', () => {
  const cases = {
    '#FF0000': 'red', '#B22222': 'red', '#8B0000': 'red', '#FFA500': 'orange', '#FF8C00': 'orange',
    '#FFFF00': 'yellow', '#FFD700': 'yellow', '#00FF00': 'green', '#008000': 'green', '#6B8E23': 'green',
    '#00FFFF': 'cyan', '#008080': 'cyan', '#0000FF': 'blue', '#000080': 'blue', '#87CEEB': 'blue',
    '#800080': 'purple', '#8A2BE2': 'purple', '#FFC0CB': 'pink', '#FF69B4': 'pink', '#8B4513': 'brown',
    '#964B00': 'brown', '#FFFFFF': 'white', '#F5F5DC': 'white', '#808080': 'gray', '#C0C0C0': 'gray',
    '#000000': 'black', '#1A1A1A': 'black',
  };
  for (const [hex, want] of Object.entries(cases)) assert.equal(classifyBasic(...hexToRgb(hex)), want, hex);
});

test('detailed names: exact entries map to themselves', () => {
  for (const e of DETAILED) {
    const r = nameColor(...e.rgb);
    assert.ok(r.dE < 1e-6, `${e.en} -> ${r.detailed.en}`);
  }
});

test('descriptions are compositional and bilingual', () => {
  assert.deepEqual(describe(...hexToRgb('#FF0000')), { zh: '鲜红色', en: 'vivid red' });
  assert.equal(describe(...hexToRgb('#708090')).en, 'bluish gray');
  assert.equal(describe(...hexToRgb('#556B2F')).zh, '橄榄绿色');
  assert.equal(describe(...hexToRgb('#8B4513')).en, 'brown');
});

test('Machado matrices: identity at 0, rows sum to 1 (gray preserved)', () => {
  for (const t of ['protan', 'deutan', 'tritan']) {
    const I = machadoMatrix(t, 0);
    assert.ok(I.every((v, i) => Math.abs(v - (i % 4 === 0 ? 1 : 0)) < 1e-6));
    for (const s of [0.3, 0.55, 1]) {
      const M = machadoMatrix(t, s);
      for (let r = 0; r < 3; r++) assert.ok(Math.abs(M[r * 3] + M[r * 3 + 1] + M[r * 3 + 2] - 1) < 1e-4);
    }
  }
});

test('inverse simulation: viewer perceives the original (in-gamut colors)', () => {
  for (const t of ['protan', 'deutan', 'tritan']) {
    const M = machadoMatrix(t, 0.6);
    const inv = mat3Inverse(M);
    const c = [0.4, 0.35, 0.3];
    const back = mat3MulVec(M, mat3MulVec(inv, c));
    back.forEach((v, k) => assert.ok(Math.abs(v - c[k]) < 1e-6));
  }
});

function dE(rgbA, rgbB) {
  const A = rgbA.map((v) => Math.round(v * 255)), B = rgbB.map((v) => Math.round(v * 255));
  return deltaE2000(rgbToLab(...A), rgbToLab(...B));
}

test('compensation keeps perceived hue and increases red/green separation for anomalous trichromats', () => {
  const red = [0.75, 0.3, 0.25], green = [0.35, 0.55, 0.25];
  for (const type of ['protan', 'deutan']) {
    for (const severity of [0.4, 0.6, 0.8]) {
      const p = shaderParams({ type, severity, method: 'compensate', strength: 1 });
      const before = dE(simulateColor(red, type, severity), simulateColor(green, type, severity));
      const after = dE(simulateColor(processColor(red, p), type, severity), simulateColor(processColor(green, p), type, severity));
      assert.ok(after > before * 1.15, `${type} ${severity}: ${before.toFixed(1)} -> ${after.toFixed(1)}`);
      // perceived hue of the compensated red should be close to the true red hue
      const perceived = simulateColor(processColor(red, p), type, severity).map((v) => Math.round(v * 255));
      const hTrue = rgbToOklch(...red.map((v) => Math.round(v * 255))).h;
      const hSeen = rgbToOklch(...perceived).h;
      assert.ok(Math.abs(hTrue - hSeen) < 12, `${type} ${severity} hue ${hTrue.toFixed(0)} vs ${hSeen.toFixed(0)}`);
    }
  }
});

test('daltonize and enhance increase separation for dichromats', () => {
  const red = [0.8, 0.15, 0.15], green = [0.2, 0.6, 0.2];
  for (const type of ['protan', 'deutan']) {
    for (const method of ['daltonize', 'enhance']) {
      const p = shaderParams({ type, severity: 1, method, strength: 1 });
      const before = dE(simulateColor(red, type, 1), simulateColor(green, type, 1));
      const after = dE(simulateColor(processColor(red, p), type, 1), simulateColor(processColor(green, p), type, 1));
      assert.ok(after > before * 1.3, `${type} ${method}: ${before.toFixed(1)} -> ${after.toFixed(1)}`);
    }
  }
  const blue = [0.2, 0.4, 0.85], greenish = [0.25, 0.65, 0.55];
  for (const method of ['compensate', 'enhance']) {
    const p = shaderParams({ type: 'tritan', severity: 1, method, strength: 1 });
    const before = dE(simulateColor(blue, 'tritan', 1), simulateColor(greenish, 'tritan', 1));
    const after = dE(simulateColor(processColor(blue, p), 'tritan', 1), simulateColor(processColor(greenish, p), 'tritan', 1));
    assert.ok(after > before * 1.2, `tritan ${method}: ${before.toFixed(1)} -> ${after.toFixed(1)}`);
  }
});

test('auto method picks balanced for anomalous, strong re-encoding for red–green dichromats', () => {
  assert.equal(shaderParams({ type: 'deutan', severity: 0.5, method: 'auto', strength: 1 }).method, 'balanced');
  assert.equal(shaderParams({ type: 'deutan', severity: 1, method: 'auto', strength: 1 }).method, 'enhance');
  assert.equal(shaderParams({ type: 'tritan', severity: 1, method: 'auto', strength: 1 }).method, 'balanced');
  // compensation is a blend: strengths above 100 % do not over-extrapolate it
  assert.equal(shaderParams({ type: 'deutan', severity: 0.6, method: 'balanced', strength: 1.5 }).strength, 1);
});

test('balanced beats pure compensation, also when type/severity are set wrong', () => {
  // red–green pairs that anomalous trichromats confuse (natural object colours)
  const pairs = [
    [[0.55, 0.45, 0.2], [0.42, 0.5, 0.2]],   // olive vs khaki-green
    [[0.75, 0.35, 0.3], [0.55, 0.5, 0.3]],   // brick vs olive
    [[0.6, 0.5, 0.45], [0.5, 0.55, 0.45]],   // pinkish gray vs greenish gray
    [[0.85, 0.55, 0.15], [0.7, 0.65, 0.15]], // orange vs yellow-green
  ];
  const sep = (cfg, obsType, obsSev) => {
    const p = shaderParams(cfg);
    return pairs.reduce((acc, [a, b]) => acc + dE(simulateColor(processColor(a, p), obsType, obsSev), simulateColor(processColor(b, p), obsType, obsSev)), 0) / pairs.length;
  };
  for (const [obsType, obsSev, cfgType, cfgSev] of [['deutan', 0.8, 'deutan', 0.8], ['deutan', 0.9, 'deutan', 0.6], ['protan', 0.7, 'deutan', 0.6]]) {
    const none = pairs.reduce((acc, [a, b]) => acc + dE(simulateColor(a, obsType, obsSev), simulateColor(b, obsType, obsSev)), 0) / pairs.length;
    const comp = sep({ type: cfgType, severity: cfgSev, method: 'compensate', strength: 1 }, obsType, obsSev);
    const bal = sep({ type: cfgType, severity: cfgSev, method: 'balanced', strength: 1 }, obsType, obsSev);
    assert.ok(bal > comp * 1.1 && bal > none * 1.5, `${obsType} ${obsSev} (set ${cfgType} ${cfgSev}): none ${none.toFixed(1)} comp ${comp.toFixed(1)} balanced ${bal.toFixed(1)}`);
  }
});

import { Segmenter } from '../docs/js/segment.js';
import { severityFromThreshold, axisDir, maxContrast, fitObserver, perceivedDE, SelfTest, processLinear, buildLadder, levelDecision } from '../docs/js/selftest.js';

function synthImage(w, h, fn) {
  const data = new Uint8ClampedArray(w * h * 4);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 8;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b] = fn(x, y);
    const p = (y * w + x) * 4;
    data[p] = r + rnd(); data[p + 1] = g + rnd(); data[p + 2] = b + rnd(); data[p + 3] = 255;
  }
  return { width: w, height: h, data };
}

test('segmentation: region growing finds a noisy disc and its contour', () => {
  const img = synthImage(120, 120, (x, y) => (Math.hypot(x - 60, y - 60) < 30 ? [200, 30, 40] : [180, 175, 165]));
  const s = new Segmenter();
  const res = s.run(img, 60, 60, { temporal: false });
  const expect = (Math.PI * 30 * 30) / (120 * 120);
  assert.ok(Math.abs(res.area - expect) < 0.03, `area ${res.area.toFixed(3)} vs ${expect.toFixed(3)}`);
  assert.ok(res.segCount > 100, `segments ${res.segCount}`);
  const bg = s.run(img, 5, 5, { temporal: false });
  assert.ok(Math.abs(bg.area - (1 - expect)) < 0.03, `bg area ${bg.area.toFixed(3)}`);
});

test('segmentation: shading on one object stays in one region; small holes are filled', () => {
  // red disc whose brightness falls off by 35% (shading) with a small white glare spot
  const img = synthImage(120, 120, (x, y) => {
    const d = Math.hypot(x - 60, y - 60);
    if (d >= 32) return [70, 110, 160];
    if (Math.hypot(x - 52, y - 52) < 3) return [250, 250, 250];
    const k = 1 - 0.35 * (x / 120);
    return [210 * k, 35 * k, 45 * k];
  });
  const res = new Segmenter().run(img, 70, 62, { temporal: false });
  const expect = (Math.PI * 32 * 32) / (120 * 120);
  assert.ok(Math.abs(res.area - expect) < 0.03, `area ${res.area.toFixed(3)} vs ${expect.toFixed(3)}`);
});

test('self-test: implied severity grows with the measured threshold', () => {
  for (const axis of ['protan', 'deutan', 'tritan']) {
    const m = maxContrast(axisDir(axis));
    let prev = -1;
    for (const k of [32, 16, 8, 4, 2, 1]) {
      const s = severityFromThreshold(axis, m / k, false);
      assert.ok(s >= prev, `${axis} non-monotonic at 1/${k}`);
      prev = s;
    }
    assert.equal(severityFromThreshold(axis, m / 32, false), 0);
    assert.equal(severityFromThreshold(axis, m, true), 1);
  }
});

test('self-test: joint fit recovers type and severity of model observers', () => {
  const thresholdsFor = (type, sev, criterion = 3.5) => {
    const th = {};
    for (const axis of ['protan', 'deutan', 'tritan']) {
      const max = maxContrast(axisDir(axis));
      if (perceivedDE(axis, max, type, sev) <= criterion) { th[axis] = { c: max, failed: true }; continue; }
      let lo = 0, hi = max;
      for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (perceivedDE(axis, mid, type, sev) > criterion) hi = mid; else lo = mid; }
      th[axis] = { c: hi, failed: false };
    }
    return th;
  };
  assert.equal(fitObserver(thresholdsFor('deutan', 0, 3.5)).severity, 0);
  assert.equal(fitObserver(thresholdsFor('deutan', 0, 6)).severity, 0, 'a less sensitive normal observer is still normal');
  for (const [type, sev] of [['deutan', 0.6], ['protan', 0.8], ['tritan', 0.9], ['deutan', 1]]) {
    const fit = fitObserver(thresholdsFor(type, sev));
    assert.equal(fit.type, type, `${type} ${sev} -> ${fit.type}`);
    assert.ok(Math.abs(fit.severity - sev) <= 0.15, `${type} ${sev} -> ${fit.severity}`);
  }
});

test('tuner: ladder escalates and level decisions stop early', () => {
  const lad = buildLadder('deutan', 60);
  assert.deepEqual(lad.map((c) => c.method), ['auto', 'balanced', 'enhance', 'enhance']);
  assert.ok(lad[1].severity > 60 && lad[3].strength > lad[2].strength);
  assert.deepEqual(buildLadder('protan', 95).map((c) => c.method + c.strength), ['auto100', 'enhance200'], 'no duplicate steps');
  assert.equal(levelDecision(3, 3), 'pass');
  assert.equal(levelDecision(0, 2), 'fail');
  assert.equal(levelDecision(1, 2), null);
  assert.equal(levelDecision(2, 4), 'fail');
});

test('tuner: model observers get a verified correction that reveals sub-threshold plates', () => {
  const el = () => ({ hidden: false, textContent: '', innerHTML: '', classList: { toggle() {} }, addEventListener() {}, appendChild() {} });
  const els = {};
  const root = { querySelector: (q) => (els[q] ||= el()), querySelectorAll: () => [] };
  const ctx = new Proxy({}, { get: (o, k) => (k in o ? o[k] : () => {}), set: (o, k, v) => { o[k] = v; return true; } });
  const prevDoc = globalThis.document;
  globalThis.document = { createElement: () => ({ className: '', innerHTML: '' }) };
  const st = new SelfTest({ root, canvas: { width: 600, height: 600, getContext: () => ctx }, t: (k) => k, onApply() {} });
  const to8 = (lin) => lin.map((v) => Math.round((v <= 0.0031308 ? v * 12.92 : 1.055 * Math.max(0, Math.min(1, v)) ** (1 / 2.4) - 0.055) * 255));
  // deterministic observer: sees the gap iff the simulated ΔE exceeds its criterion
  const run = (type, sev, crit = 3.5) => {
    st.start();
    for (let guard = 0; !els['#testRun'].hidden && guard < 200; guard++) {
      const { dir, c, params } = st.plate;
      const bg = processLinear([0.18, 0.18, 0.18], params), tg = processLinear(dir.map((d) => (0.2 + c * d) * 0.92), params);
      const M = machadoMatrix(type, sev);
      const d = deltaE2000(rgbToLab(...to8(mat3MulVec(M, bg))), rgbToLab(...to8(mat3MulVec(M, tg))));
      st.answer(d > crit ? st.dirAns : -1);
    }
    return st;
  };
  try {
    for (const [type, sev] of [['deutan', 0.7], ['protan', 0.9], ['deutan', 1]]) {
      const r = run(type, sev);
      assert.ok(r.result, `${type} ${sev}: no result`);
      assert.ok(r.result.verified, `${type} ${sev}: correction not verified`);
      assert.equal(r.verify.rawOk, 0, `${type} ${sev}: uncorrected plates should be invisible`);
      assert.ok(['protan', 'deutan'].includes(r.result.type));
    }
    assert.equal(run('deutan', 0).result, null, 'normal vision: nothing to apply');
  } finally { globalThis.document = prevDoc; }
});

test('Ishihara-type plate: invisible to a deuteranope, readable through Strong at 200 %', () => {
  // pseudo-isochromatic plate as dot colours: background olive/khaki with lightness noise,
  // figure shifted along the deutan confusion line (so a dichromat sees no difference)
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const pal = [[150, 158, 92], [172, 168, 98], [128, 148, 88], [160, 150, 104]].map((c) => c.map((v) => srgbToLinear(v / 255)));
  const u = axisDir('deutan');
  const dots = [];
  for (let i = 0; i < 600; i++) {
    const fig = i < 120, base = pal[i % 4].map((v) => v * (0.68 + 0.44 * rnd()));
    const lin = fig ? base.map((v, k) => v - 0.2 * u[k]) : base;
    dots.push({ fig, rgb: lin.map((v) => Math.round(linearToSrgb(Math.max(0, Math.min(1, v))) * 255) / 255) });
  }
  const dprime = (cfg, obsSev) => {
    const p = cfg && shaderParams(cfg);
    const P = dots.map((d) => { const o = p ? processColor(d.rgb, p) : d.rgb; return linRgbToOklab(...simulateColor(o, 'deutan', obsSev).map(srgbToLinear)).map((v) => v * 100); });
    // Fisher discriminant along the best direction (pooled covariance + 1-JND floor)
    const A = P.filter((_, i) => dots[i].fig), B = P.filter((_, i) => !dots[i].fig);
    const mean = (Q) => [0, 1, 2].map((k) => Q.reduce((x, q) => x + q[k], 0) / Q.length);
    const ma = mean(A), mb = mean(B), S = [];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      let v = 0; for (const [Q, m] of [[A, ma], [B, mb]]) for (const q of Q) v += (q[i] - m[i]) * (q[j] - m[j]);
      S.push(v / (P.length - 2) + (i === j ? 0.6 ** 2 : 0));
    }
    const Si = mat3Inverse(S), d = ma.map((v, k) => v - mb[k]);
    const Sd = mat3MulVec(Si, d);
    return Math.sqrt(d[0] * Sd[0] + d[1] * Sd[1] + d[2] * Sd[2]);
  };
  const normal = dprime(null, 0), blind = dprime(null, 1);
  const strong = dprime({ type: 'deutan', severity: 0.6, method: 'enhance', strength: 2 }, 1);
  assert.ok(blind < 1 && normal > 2, `normal ${normal.toFixed(1)}, deuteranope ${blind.toFixed(1)}`);
  const strong100 = dprime({ type: 'deutan', severity: 0.6, method: 'enhance', strength: 1 }, 1);
  assert.ok(strong > normal && strong > strong100 * 1.15, `deuteranope: Strong 100 % ${strong100.toFixed(1)}, 200 % ${strong.toFixed(1)}; normal vision ${normal.toFixed(1)}`);
});

import { estimateWB, gainsFromReference, castOfGains } from '../docs/js/wb.js';

test('segmentation: strong shading (3× darker side) stays one object', () => {
  // green ball lit from the left: linear intensity falls from 1 to 0.33 across it
  const img = synthImage(140, 140, (x, y) => {
    if (Math.hypot(x - 70, y - 70) >= 40) return [205, 200, 192];
    const k = 1 - 0.67 * ((x - 30) / 80);
    const lin = [0.05, 0.35, 0.08].map((v) => v * k);
    return lin.map((v) => Math.round((v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055) * 255));
  });
  const res = new Segmenter().run(img, 50, 70, { temporal: false });
  const expect = (Math.PI * 40 * 40) / (140 * 140);
  assert.ok(Math.abs(res.area - expect) < 0.03, `area ${res.area.toFixed(3)} vs ${expect.toFixed(3)}`);
  assert.equal(nameColor(...res.color.rgb).basicKey, 'green');
});

test('segmentation: does not leak through a thin contact into a look-alike neighbour', () => {
  // red disc touching an orange-brown table area along a 2-px bridge
  const img = synthImage(160, 120, (x, y) => {
    const inDisc = Math.hypot(x - 50, y - 60) < 30;
    const bridge = x >= 80 && x < 100 && Math.abs(y - 60) <= 1;
    if (inDisc || bridge) return [170, 40, 25];
    if (x >= 100) return [190, 110, 60];
    return [60, 60, 66];
  });
  const res = new Segmenter().run(img, 50, 60, { temporal: false });
  const disc = (Math.PI * 30 * 30) / (160 * 120);
  assert.ok(res.area < disc + 0.02, `leaked: area ${res.area.toFixed(3)} vs disc ${disc.toFixed(3)}`);
});

test('segmentation: textured surface (fabric noise) is not fragmented', () => {
  let seed = 3;
  const rnd = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
  const img = synthImage(120, 120, (x, y) => {
    if (x < 20 || x >= 100 || y < 20 || y >= 100) return [230, 228, 220];
    const k = 0.7 + 0.6 * rnd(); // strong per-pixel texture
    return [40 * k, 70 * k, 150 * k];
  });
  const res = new Segmenter().run(img, 60, 60, { temporal: false });
  assert.ok(Math.abs(res.area - 0.444) < 0.05, `area ${res.area.toFixed(3)}`);
  assert.equal(nameColor(...res.color.rgb).basicKey, 'blue');
});

test('auto white balance: removes a warm cast using gray pixels, ignores the measured object', () => {
  const cast = [1.0, 0.82, 0.58]; // tungsten-like light, linear
  const toS = (v) => Math.round((v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055) * 255);
  const w = 200, h = 150, data = new Uint8ClampedArray(w * h * 4), excl = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    let lin;
    if (x < 80) lin = [0.6, 0.6, 0.6];                    // white wall
    else if (x < 120) lin = [0.18, 0.18, 0.18];           // gray floor
    else { lin = [0.5, 0.25, 0.05]; excl[i] = 1; }        // orange object being measured
    const c = lin.map((v, k) => toS(Math.min(1, v * cast[k])));
    data.set([c[0], c[1], c[2], 255], i * 4);
  }
  const est = estimateWB(data, w, h, excl);
  assert.ok(est.ok);
  assert.equal(est.cast, 'warm');
  // corrected wall should be close to neutral: residual ratio within ~12% (80 % strength)
  const wall = [0.6, 0.6, 0.6].map((v, k) => v * cast[k] * est.gains[k]);
  assert.ok(Math.max(...wall) / Math.min(...wall) < 1.15, wall.map((v) => v.toFixed(3)).join(','));
  assert.equal(castOfGains(est.gains), 'warm');
  // a white-card reference gives exact neutral
  const g = gainsFromReference([0.6, 0.492, 0.348]);
  const c = [0.6, 0.492, 0.348].map((v, k) => v * g[k]);
  assert.ok(Math.max(...c) - Math.min(...c) < 1e-6);
});

test('auto white balance: no gray pixels -> no estimate', () => {
  const w = 100, h = 100, data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([220, 60, 30, 255], i * 4);
  assert.equal(estimateWB(data, w, h).ok, false);
});

test('ambiguous colours get a "may also be" category', () => {
  assert.equal(basicAlternative(214, 99, 64), 'red');      // burnt orange (a NASA suit in the shade)
  assert.equal(basicAlternative(255, 0, 0), null);         // pure red is unambiguous
  assert.equal(basicAlternative(0, 0, 255), null);
  assert.equal(classifyBasic(214, 99, 64), 'orange');
});

import { guessFacing, lensKind } from '../docs/js/camera.js';
test('camera labels: facing and lens type (iOS en/zh, Android)', () => {
  const cases = [
    ['Back Camera', 'environment', 'main'], ['Back Ultra Wide Camera', 'environment', 'ultra'],
    ['Back Telephoto Camera', 'environment', 'tele'], ['Back Dual Wide Camera', 'environment', 'multi'],
    ['Back Triple Camera', 'environment', 'multi'], ['Front Camera', 'user', 'main'],
    ['后置相机', 'environment', 'main'], ['后置超广角相机', 'environment', 'ultra'], ['后置长焦相机', 'environment', 'tele'],
    ['后置双广角相机', 'environment', 'multi'], ['前置相机', 'user', 'main'],
    ['camera2 0, facing back', 'environment', 'main'], ['camera2 1, facing front', 'user', 'main'],
  ];
  for (const [label, facing, kind] of cases) {
    assert.equal(guessFacing(label), facing, label);
    assert.equal(lensKind(label), kind, label);
  }
});

test('app default range (≈0.6) still keeps shaded and textured objects whole, and does not leak', () => {
  const toS = (v) => Math.round((v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055) * 255);
  const ball = synthImage(140, 140, (x, y) => {
    if (Math.hypot(x - 70, y - 70) >= 40) return [205, 200, 192];
    const k = 1 - 0.67 * ((x - 30) / 80);
    return [0.05, 0.35, 0.08].map((v) => toS(v * k));
  });
  const a = new Segmenter().run(ball, 50, 70, { sens: 0.6, temporal: false }).area;
  assert.ok(Math.abs(a - 0.256) < 0.02, `shaded ball ${a.toFixed(3)}`);
  const leak = synthImage(160, 120, (x, y) => {
    const inDisc = Math.hypot(x - 50, y - 60) < 30, bridge = x >= 80 && x < 100 && Math.abs(y - 60) <= 1;
    if (inDisc || bridge) return [170, 40, 25];
    return x >= 100 ? [190, 110, 60] : [60, 60, 66];
  });
  const b = new Segmenter().run(leak, 50, 60, { sens: 0.6, temporal: false }).area;
  assert.ok(b < 0.17, `leak ${b.toFixed(3)}`);
});
