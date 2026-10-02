// Color Vision Helper — app controller.
import { t, setLang, getLang, applyI18n, detectLang } from './i18n.js';
import { LIN, linearToSrgb, rgbToHex, rgbToLab, deltaE2000 } from './color.js';
import { nameColor, BASIC } from './naming.js';
import { shaderParams, resolveMethod } from './cvd.js';
import { Segmenter, rangeToSens, sensToRange } from './segment.js';
import { estimateWB, gainsFromReference, castOfGains } from './wb.js';
import { Renderer } from './gl.js';
import { Camera, cameraErrorKey, guessFacing, lensKind, frameAspect } from './camera.js';
import { SelfTest } from './selftest.js';
import { reticleSVG, RETICLE_STYLES } from './reticle.js';
import {
  frameStats, passiveEstimate, paperEstimate, torchEstimate, chartEstimate, orientAndFit, CHARTS, fitChart,
  printCalibration, addSatPoint, printCardSVG, makeProfile, calibrationFor, blendGains, nameAmbiguity, uncertaintyOf,
  gpuParams, validateChart, defaultSatAt, luma, linToSrgb8, CC24_REF, WHITE_RHO,
} from './truecolor.js';
import { findChart } from './chartdetect.js';
import { measureCaps, verifyManualExposure, torchMeasure } from './measure.js';

export const APP_VERSION = '1.5.1';
const $ = (id) => document.getElementById(id);
const app = $('app'), video = $('video'), overlay = $('overlay');
let view = $('view');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- settings (persisted per device) ----------------
const STORE_KEY = 'cvh.settings.v1';
const DEFAULTS = {
  lang: detectLang(), set: 'detailed', bilingual: false, outline: true, dim: false,
  values: true, autoSpeak: false, mode: 'identify',
  wbMode: 'auto', wb: [1, 1, 1], wbLocked: false, wbCalibrated: false, // white balance: auto | manual | off
  segPos: 0.5,                                     // region range slider position (0..1, non-linear)
  reticle: 'gap', retSize: 'm',                    // reticle style / size (see reticle.js)
  frame: 'fit',                                    // fit = whole camera frame, fill = crop to screen
  camId: null, camFacing: 'environment', autoMainDone: false, tipsShown: false,
  cvd: { type: 'deutan', severity: 60, method: 'auto', strength: 100, tuned: false },
  split: false, preview: false, cpCollapsed: false,
  // scene: real = true colour (现实物体，估计物体本身的颜色) | screen = picture colour (拍屏幕、看图片)
  scene: 'real',
  // true colour: src = auto | camera | paper | torch | chart; preview = show the true-colour picture in
  // Identify too; defaultSat = default low-light saturation curve for cameras without a chart calibration
  tc: { src: 'auto', rho: 0.85, chart: 'cc24', cams: {}, printRef: null, preview: false, defaultSat: false },
  // display: text size m | l | xl; hints closed with × (by "scene.mode"); one-time tips already shown
  textSize: 'm', hintsOff: {}, hintTipShown: false,
};
function loadSettings() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch { saved = null; }
  const s = JSON.parse(JSON.stringify(DEFAULTS));
  if (saved && typeof saved === 'object') {
    for (const k of Object.keys(s)) if (k in saved) s[k] = k === 'cvd' || k === 'tc' ? { ...s[k], ...saved[k] } : saved[k];
    if (saved.wbOn && !('wbMode' in saved)) s.wbMode = 'manual'; // v1.0 setting
    if (s.cvd.method === 'daltonize') s.cvd.method = 'auto';      // v1.2: Daltonize was replaced by Balanced
  }
  return s;
}
const S = loadSettings();
if (S.scene !== 'real' && S.scene !== 'screen') S.scene = 'real';
/** True colour (the "real" scene) or picture colour (the "screen" scene). */
const tcOn = () => S.scene === 'real';
function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch { /* storage unavailable */ } }

// ---------------- runtime state ----------------
const R = {
  source: null, kind: 'none', // 'camera' | 'frozen' | 'photo'
  renderer: null, glOk: false, ctx2d: null,
  W: 1, H: 1, dpr: 1,
  rect: { x: 0, y: 0, w: 1, h: 1 },   // where the picture is drawn (CSS px)
  reticle: { x: 0.5, y: 0.5 }, retVer: 0,
  zoom: 1, split: 0.5,
  smooth: null, shownKey: null, pendKey: null, pendCount: 0,
  lastAnalysis: 0, lastRes: null, lastNaming: null, lastRgb: null, patch: null, colorSrc: 'point',
  autoWB: [1, 1, 1], autoCast: null, wbSeen: 0,
  worker: null, busy: false, busySince: 0, reqId: 0, reqMeta: null,
  newFrame: true, frozenCanvas: null, wakeLock: null, wasLive: false, dirty: true,
  // true colour: latest frame statistics, recent white anchors, noise index, held measurement
  // (torch / chart), chart fit on the frozen frame, corner picking in progress
  tc: {
    stats: null, anchors: [], anchor: null, noise: null, held: null, chart: null, pick: null, busy: false, last: null, screen: null, paperAt: null, paperPick: false,
    liveChart: null, lastDetect: 0, detectDone: false,  // chart found automatically (live, or once per frozen frame)
    anchorRho: null, anchorMenu: false, shadow: 'auto',  // the user's answers about the white anchor and shadows
    freezeInfo: null, amb: null, gpu: null, pendingValidate: false, photoReal: false, hintShown: false,
  },
};
/** Ask for a fresh analysis on the next frame (after the texture is up to date). */
function requestAnalysis() { R.dirty = true; }
const camera = new Camera(video);
const localSeg = new Segmenter(); // used when Web Workers are unavailable

// analysis buffers
const aCanvas = document.createElement('canvas');
const aCtx = aCanvas.getContext('2d', { willReadFrequently: true });
const PS = 16; // patch size for colour sampling
const pCanvas = document.createElement('canvas'); pCanvas.width = PS; pCanvas.height = PS;
const pCtx = pCanvas.getContext('2d', { willReadFrequently: true });
const mCanvas = document.createElement('canvas');
const mCtx = mCanvas.getContext('2d');
let maskImage = null;
const oCtx = overlay.getContext('2d');

// ---------------- renderer ----------------
function initRenderer() {
  try {
    R.renderer = new Renderer(view);
    R.glOk = true;
  } catch (e) {
    console.warn('WebGL unavailable, using 2D fallback', e);
    R.glOk = false;
    // a canvas that already handed out a WebGL context can never give a 2D one: swap it
    const fresh = view.cloneNode(false);
    view.replaceWith(fresh);
    view = fresh;
    R.ctx2d = view.getContext('2d');
  }
}

view.addEventListener('webglcontextlost', (e) => { e.preventDefault(); R.glLost = true; });
view.addEventListener('webglcontextrestored', () => {
  R.glLost = false;
  try { R.renderer = new Renderer(view); R.glOk = true; resize(); applyCorrection(); R.newFrame = true; } catch (e) { console.error(e); }
});

function sourceSize() {
  const s = R.source;
  if (!s) return [0, 0];
  if (s instanceof HTMLVideoElement) return [s.videoWidth, s.videoHeight];
  return [s.width, s.height];
}

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = app.clientWidth, h = app.clientHeight;
  R.W = w; R.H = h; R.dpr = dpr;
  const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
  if (R.glOk) R.renderer.resize(pw, ph);
  else { view.width = pw; view.height = ph; }
  overlay.width = pw; overlay.height = ph;
  layout();
}

/**
 * Decide where the picture goes. "fit": the whole camera frame, as large as the space between
 * the top bar and the toolbar allows. If it fits above the colour card it is centred there;
 * otherwise it stays large, pinned under the top bar, and the card overlays its lower edge
 * (shrinking it to fit above the card made a portrait camera frame tiny on phones whose browser
 * bars take part of the screen). "fill": cover the whole screen (crops the frame).
 */
function layout() {
  const W = R.W, H = R.H;
  const [sw, sh] = sourceSize();
  let rect = { x: 0, y: 0, w: W, h: H };
  if (S.frame === 'fit' && sw && sh) {
    const top = document.querySelector('.topbar').getBoundingClientRect().bottom;
    const toolbarTop = document.querySelector('.toolbar').getBoundingClientRect().top;
    // a fixed reserve for the colour card (or collapsed panel), so the picture never jumps
    // when the card text changes height
    const fs = TEXT_SCALE[S.textSize] || 1;
    const reserve = ((S.mode === 'identify' ? CARD_RESERVE : PANEL_RESERVE) + (R.tc.hintShown ? HINT_RESERVE : 0)) * fs;
    let ay = top, ah = toolbarTop - top;
    if (ah < H * 0.35) { ay = 0; ah = H; } // not enough room: use the whole screen
    const sa = sw / sh;
    let rw = W, rh = W / sa;
    if (rh > ah) { rh = ah; rw = ah * sa; }
    const free = ah - reserve;
    rect = { x: (W - rw) / 2, y: rh <= free ? ay + (free - rh) / 2 : ay, w: rw, h: rh };
  }
  const changed = ['x', 'y', 'w', 'h'].some((k) => Math.abs(rect[k] - R.rect[k]) > 0.5);
  R.rect = rect;
  // rounded corners for the picture when it does not fill the screen (a dark mask around it)
  const fr = $('frame');
  fr.hidden = !(R.source && S.frame === 'fit');
  Object.assign(fr.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px` });
  if (R.glOk) R.renderer.setViewport(rect.x * R.dpr, rect.y * R.dpr, rect.w * R.dpr, rect.h * R.dpr);
  // analysis resolution ≈ 80k pixels with the picture's aspect ratio
  const va = rect.w / rect.h;
  const AW = Math.max(64, Math.round(Math.sqrt(80000 * va)));
  const AH = Math.max(64, Math.round(AW / va));
  if (AW !== aCanvas.width || AH !== aCanvas.height) {
    aCanvas.width = AW; aCanvas.height = AH;
    mCanvas.width = AW; mCanvas.height = AH;
    maskImage = mCtx.createImageData(AW, AH);
    R.lastRes = null;
  }
  placeReticle();
  placeFloating();
  applySplit();
  if (changed) { R.newFrame = true; requestAnalysis(); }
}

// room kept under the picture (CSS px at text size 1): colour card or collapsed correction panel, and
// the hint strip while it is shown. Fixed per state, so the picture does not jump when text changes.
const CARD_RESERVE = 150, PANEL_RESERVE = 66, HINT_RESERVE = 62;
const TEXT_SCALE = { m: 1, l: 1.15, xl: 1.3 };
function setTextSize(v) {
  if (!TEXT_SCALE[v]) return;
  S.textSize = v; save();
  applyTextSize(); syncSettingsUI();
  requestAnimationFrame(() => { layout(); placeFloating(); });
}
function applyTextSize() { document.documentElement.style.setProperty('--fs', String(TEXT_SCALE[S.textSize] || 1)); }

/** Cover-crop of the source matching the picture rect (and digital zoom), in source pixels. */
function crop() {
  const [sw, sh] = sourceSize();
  if (!sw || !sh) return null;
  const va = R.rect.w / R.rect.h, sa = sw / sh;
  let cw, ch;
  if (sa > va) { ch = sh; cw = sh * va; } else { cw = sw; ch = sw / va; }
  const z = hwZoomActive() ? 1 : R.zoom;
  cw /= z; ch /= z;
  return { x: (sw - cw) / 2, y: (sh - ch) / 2, w: cw, h: ch, sw, sh };
}

function mirrored() { return R.kind !== 'photo' && camera.mirrored; }
function hwZoomActive() { return R.kind === 'camera' && !!camera.zoomRange; }

function render() {
  const c = crop();
  if (!c) return;
  if (R.glOk) {
    const r = R.renderer;
    if (R.newFrame) {
      try { r.upload(R.source); } catch (e) { /* frame not ready */ }
      R.newFrame = R.kind === 'camera' && !('requestVideoFrameCallback' in HTMLVideoElement.prototype);
    }
    r.setCrop([c.x / c.sw, c.y / c.sh, c.w / c.sw, c.h / c.sh], mirrored());
    r.draw();
  } else {
    const ctx = R.ctx2d, d = R.dpr, rc = R.rect;
    ctx.fillStyle = '#0e1116'; ctx.fillRect(0, 0, view.width, view.height);
    ctx.save();
    ctx.translate(rc.x * d, rc.y * d);
    if (mirrored()) { ctx.translate(rc.w * d, 0); ctx.scale(-1, 1); }
    ctx.drawImage(R.source, c.x, c.y, c.w, c.h, 0, 0, rc.w * d, rc.h * d);
    ctx.restore();
  }
}

// ---------------- white balance ----------------
function wbGains() {
  if (S.wbMode === 'manual') return S.wb;
  if (S.wbMode === 'auto') return R.autoWB;
  return [1, 1, 1];
}
function applyWB() { if (R.glOk) R.renderer.setWB(wbGains()); }

function applySplit() {
  if (!R.glOk) return;
  const on = S.mode === 'correct' && S.split;
  R.renderer.setSplit(on ? (R.rect.x + R.split * R.rect.w) * R.dpr : -1);
  const labels = $('splitLabels');
  labels.hidden = !on;
  labels.style.setProperty('--split', (R.rect.x + R.split * R.rect.w) + 'px');
  labels.style.top = (R.rect.y + 8) + 'px';
}

function applyCorrection() {
  if (!R.glOk) return;
  const on = S.mode === 'correct';
  const cfg = { type: S.cvd.type, severity: S.cvd.severity / 100, method: S.cvd.method, strength: S.cvd.strength / 100 };
  R.renderer.setParams(on ? shaderParams(cfg) : null);
  R.renderer.setPreview(on && S.preview);
  applySplit();
  applyWB();
}

// ---------------- colour sampling ----------------
function median(arr, n) {
  const a = Array.from(arr.subarray(0, n)).sort((x, y) => x - y);
  return a[n >> 1];
}
const chR = new Float32Array(PS * PS), chG = new Float32Array(PS * PS), chB = new Float32Array(PS * PS);

/**
 * Sample a small disc around the reticle at full source resolution.
 * Clipped (blown-out) and near-black pixels are left out of the median when enough others remain.
 * Returns {lin (WB applied), raw (no WB), clipped, Y}.
 */
function samplePatch(c, cssSize = 18) { return samplePatchAt(c, R.reticle, cssSize); }
/** Same, at any point of the picture (pos in fractions of the displayed picture). */
function samplePatchAt(c, pos, cssSize = 18) {
  const mir = mirrored();
  const rx = mir ? 1 - pos.x : pos.x;
  const size = Math.max(4, cssSize * (c.w / R.rect.w));
  let cx = c.x + rx * c.w, cy = c.y + pos.y * c.h;
  cx = Math.max(size / 2, Math.min(c.sw - size / 2, cx));
  cy = Math.max(size / 2, Math.min(c.sh - size / 2, cy));
  let d;
  if (R.glOk) {
    d = R.renderer.read([(cx - size / 2) / c.sw, (cy - size / 2) / c.sh, size / c.sw, size / c.sh], false, PS, PS).data;
  } else {
    pCtx.drawImage(R.source, cx - size / 2, cy - size / 2, size, size, 0, 0, PS, PS);
    d = pCtx.getImageData(0, 0, PS, PS).data;
  }
  let n = 0, clipped = 0, total = 0;
  const r0 = PS / 2 - 0.5, rad2 = (PS / 2) * (PS / 2);
  const take = (skipBad) => {
    n = 0;
    for (let y = 0; y < PS; y++) for (let x = 0; x < PS; x++) {
      if ((x - r0) ** 2 + (y - r0) ** 2 > rad2) continue;
      const p = (y * PS + x) * 4;
      const bad = d[p] >= 250 || d[p + 1] >= 250 || d[p + 2] >= 250 || (d[p] + d[p + 1] + d[p + 2] < 9);
      if (!skipBad) { total++; if (d[p] >= 250 || d[p + 1] >= 250 || d[p + 2] >= 250) clipped++; }
      if (skipBad && bad) continue;
      chR[n] = LIN[d[p]]; chG[n] = LIN[d[p + 1]]; chB[n] = LIN[d[p + 2]]; n++;
    }
  };
  take(false);
  const allN = n;
  take(true);
  if (n < allN * 0.3) take(false); // mostly glare/black: use everything
  const raw = [median(chR, n), median(chG, n), median(chB, n)];
  const g = wbGains();
  const lin = raw.map((v, k) => Math.min(1, v * g[k]));
  return { lin, raw, clipped: clipped / Math.max(1, total), Y: 0.2126 * raw[0] + 0.7152 * raw[1] + 0.0722 * raw[2] };
}

function readAnalysisFrame(c) {
  const AW = aCanvas.width, AH = aCanvas.height;
  if (R.glOk) return R.renderer.read([c.x / c.sw, c.y / c.sh, c.w / c.sw, c.h / c.sh], mirrored(), AW, AH);
  aCtx.save();
  if (mirrored()) { aCtx.translate(AW, 0); aCtx.scale(-1, 1); }
  aCtx.drawImage(R.source, c.x, c.y, c.w, c.h, 0, 0, AW, AH);
  aCtx.restore();
  return aCtx.getImageData(0, 0, AW, AH);
}

/** Colour identification (reticle, card, region) only runs in Identify mode, and pauses while
 *  the white-balance panel is open so the picture stays clear for aiming at the white card. */
function idVisible() { return S.mode === 'identify' && (!wbOpen() || tcOn()); }
function wbOpen() { return !$('wbPop').hidden; }
function setWBOpen(open) {
  $('wbPop').hidden = !open;
  app.classList.toggle('wb-open', open);
  syncWBUI();
  R.smooth = null; R.shownKey = null;
  drawOverlay();
  placeReticle(); updateZoomChips(); placeFloating();
  requestAnalysis();
}

// ---------------- analysis (patch on the main thread, region + auto WB in a worker) ----------------
function initWorker() {
  try {
    const w = new Worker(new URL('./analysis-worker.js', import.meta.url), { type: 'module' });
    w.onmessage = (e) => onRegionResult(e.data);
    w.onerror = (e) => { console.warn('analysis worker failed, running on main thread', e); R.worker = null; R.busy = false; };
    R.worker = w;
  } catch (e) {
    R.worker = null;
  }
}

function analyze() {
  const c = crop();
  if (!c) return;
  const wantRegion = idVisible();
  if (wantRegion) R.patch = samplePatch(c);
  const wantWB = S.wbMode === 'auto';
  // true colour needs the frame statistics in Identify, and in Correct for the true-colour picture
  const wantTC = tcOn() && (wantRegion || (S.mode === 'correct' && R.glOk));
  const busy = R.busy && performance.now() - R.busySince < 1500;
  // a still picture is analysed only on request: keep the request until the worker is free
  if (busy && R.kind !== 'camera') R.dirty = true;
  if ((wantRegion || wantWB || wantTC) && !busy) {
    const img = readAnalysisFrame(c);
    const buf = new Uint8Array(img.data); // copy: the read-back buffer is reused
    // look for a colour chart: twice a second on live video, once on a frozen frame or photo
    const now = performance.now();
    const detect = tcOn() && wantRegion && !R.tc.paperPick
      && (R.tc.pick ? R.tc.autoPick && R.kind !== 'camera' : S.tc.src === 'auto' || S.tc.src === 'chart')
      && (R.kind === 'camera' ? now - R.tc.lastDetect > 500 : !R.tc.detectDone);
    if (detect) { R.tc.lastDetect = now; if (R.kind !== 'camera') R.tc.detectDone = true; }
    const msg = {
      id: ++R.reqId, buf, w: img.width, h: img.height,
      segment: wantRegion, wb: wantWB,
      sx: R.reticle.x * img.width - 0.5, sy: R.reticle.y * img.height - 0.5,
      sens: posToSens(S.segPos), gains: wbGains(), temporal: R.kind === 'camera', wantAlpha: S.dim,
      tc: wantTC, paperAt: tcOn() ? R.tc.paperAt : null, detect,
    };
    R.reqMeta = { id: msg.id, retVer: R.retVer, w: img.width, h: img.height, gains: msg.gains.slice(), kind: R.kind };
    if (R.worker) {
      R.busy = true; R.busySince = performance.now();
      R.worker.postMessage(msg, [buf.buffer]);
    } else {
      onRegionResult(runLocal(msg));
    }
  }
  if (!wantRegion) { R.lastRes = null; drawOverlay(); return; }
  updateNaming();
}

let localPrevLuma = null;
function runLocal(m) {
  const out = { id: m.id, w: m.w, h: m.h, wb: null, res: null, tc: null };
  let soft = null;
  if (m.segment) {
    const r = localSeg.run({ width: m.w, height: m.h, data: m.buf }, m.sx, m.sy, { sens: m.sens, gains: m.gains, temporal: m.temporal });
    soft = r.soft;
    out.res = { area: r.area, bbox: r.bbox, segCount: r.segCount, segs: r.segments.slice(0, r.segCount * 4), color: r.color, tol: r.tol, w: r.w, h: r.h };
    if (m.wantAlpha) { const a = new Uint8ClampedArray(soft.length); for (let i = 0; i < soft.length; i++) a[i] = soft[i] * 255; out.res.alpha = a; }
  }
  if (m.wb) out.wb = estimateWB(m.buf, m.w, m.h, soft);
  if (m.tc) {
    const st = frameStats({ width: m.w, height: m.h, data: m.buf }, { gains: m.gains, soft, sx: m.sx, sy: m.sy, prev: m.temporal ? localPrevLuma : null, paperAt: m.paperAt });
    localPrevLuma = st.lumaSmall; delete st.lumaSmall;
    out.tc = st;
  }
  if (m.detect) out.chart = findChart({ width: m.w, height: m.h, data: m.buf });
  return out;
}

function onRegionResult(out) {
  R.busy = false;
  const meta = R.reqMeta;
  // auto white balance: smooth the estimate (fast at first, then slowly)
  if (out.wb && out.wb.ok && S.wbMode === 'auto') {
    const a = R.wbSeen < 3 ? 0.6 : 0.12;
    R.autoWB = R.autoWB.map((v, k) => v + (out.wb.gains[k] - v) * a);
    R.wbSeen++;
    const cast = castOfGains(R.autoWB);
    if (cast !== R.autoCast) { R.autoCast = cast; if (wbOpen()) syncWBUI(); }
    applyWB();
  }
  if (!meta || out.id !== meta.id) return;
  if (meta.retVer !== R.retVer || meta.kind !== R.kind || out.w !== aCanvas.width || out.h !== aCanvas.height) { requestAnalysis(); return; }
  if (out.res) { out.res.gains = meta.gains; R.lastRes = out.res; }
  if (out.tc) onTCStats(out.tc);
  if (out.chart !== undefined && meta.kind === R.kind) onChartDetected(out.chart);
  updateGpuTC();
  R.resCount = (R.resCount || 0) + 1;
  drawOverlay();
  if (idVisible()) updateNaming();
}

function pickColor() {
  const p = R.patch;
  if (!p) return null;
  const rc = R.lastRes && R.lastRes.color;
  if (rc && rc.pixels >= 120 && R.lastRes.area < 0.97) {
    const toRgb = (lin) => lin.map((v) => Math.round(linearToSrgb(v) * 255));
    const dE = deltaE2000(rgbToLab(...toRgb(p.lin)), rgbToLab(...rc.rgb));
    if (dE < 22 || p.clipped > 0.3) {
      const g = R.lastRes.gains || [1, 1, 1];
      return { lin: rc.lin, raw: rc.lin.map((v, k) => v / g[k]), src: 'region' };
    }
  }
  return { lin: p.lin, raw: p.raw, src: 'point' };
}

function updateNaming() {
  const pick = pickColor();
  if (!pick) return;
  const live = R.kind === 'camera';
  let lin = pick.lin, src = pick.src, tc = null;
  if (tcOn()) {
    tc = trueEstimate(pick);
    if (tc) { lin = tc.lin.map((v) => Math.max(0, Math.min(1, v))); src = 'tc:' + tc.source; }
    R.tc.screen = nameColor(...pick.lin.map((v) => Math.round(linearToSrgb(v) * 255)));
  }
  R.tc.last = tc;
  // the bar's message depends on the estimate (anchor, shadow, chart): refresh it when that changes
  const barKey = tc ? [tc.source, tc.anchorLocal, !!(tc.anchor && tc.anchor.at), tc.anchor && tc.anchor.neutral, tc.shadowSuspect, !!activeChart()].join() : '';
  if (barKey !== R.tc.barKey) { R.tc.barKey = barKey; syncTCBar(); }
  if (!R.smooth || !live || src !== R.colorSrc || (tc && tc.held)) R.smooth = lin;
  else {
    const diff = Math.abs(lin[0] - R.smooth[0]) + Math.abs(lin[1] - R.smooth[1]) + Math.abs(lin[2] - R.smooth[2]);
    const a = diff > 0.12 ? 0.75 : 0.35;
    R.smooth = R.smooth.map((v, k) => v + (lin[k] - v) * a);
  }
  R.colorSrc = src;
  const rgb = R.smooth.map((v) => Math.round(linearToSrgb(v) * 255));
  const naming = nameColor(rgb[0], rgb[1], rgb[2]);
  // how sure: does the basic name change within the typical error of this source?
  R.tc.amb = tc ? nameAmbiguity(R.smooth, uncertaintyOf(tc, { residual: tc.residual, calibrated: tc.calibrated })) : null;
  // hysteresis on the displayed name to avoid flicker
  const key = S.set === 'basic' ? naming.basicKey : naming.detailed.en;
  if (key === R.shownKey || !live || R.shownKey === null) { R.pendCount = 0; R.shownKey = key; R.lastNaming = naming; }
  else if (key === R.pendKey) { if (++R.pendCount >= 2) { R.shownKey = key; R.lastNaming = naming; R.pendCount = 0; onNameChanged(); } }
  else { R.pendKey = key; R.pendCount = 0; }
  if (!R.lastNaming) R.lastNaming = naming;
  R.lastRgb = rgb;
  updateCard();
}

function drawOverlay() {
  const ctx = oCtx, W = overlay.width, H = overlay.height;
  ctx.clearRect(0, 0, W, H);
  if (S.mode === 'identify') drawTCMarks(ctx);
  const res = R.lastRes;
  if (!res || res.area <= 0 || !idVisible()) return;
  const d = R.dpr, rc = R.rect;
  const ox = rc.x * d, oy = rc.y * d, sx = (rc.w * d) / res.w, sy = (rc.h * d) / res.h;
  if (S.dim && res.alpha && maskImage && maskImage.width === res.w) {
    const m = maskImage.data, a = res.alpha;
    for (let i = 0, p = 0; i < a.length; i++, p += 4) { m[p] = 255; m[p + 1] = 255; m[p + 2] = 255; m[p + 3] = a[i]; }
    mCtx.putImageData(maskImage, 0, 0);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(ox, oy, rc.w * d, rc.h * d);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(mCanvas, ox, oy, rc.w * d, rc.h * d);
    ctx.globalCompositeOperation = 'source-over';
  }
  if (S.outline && res.segCount) {
    const s = res.segs;
    ctx.beginPath();
    for (let k = 0; k < res.segCount; k++) {
      const o = k * 4;
      ctx.moveTo(ox + (s[o] + 0.5) * sx, oy + (s[o + 1] + 0.5) * sy);
      ctx.lineTo(ox + (s[o + 2] + 0.5) * sx, oy + (s[o + 3] + 0.5) * sy);
    }
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.lineWidth = 5 * d; ctx.stroke();
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2.2 * d; ctx.stroke();
  }
}

// ---------------- info card ----------------
function colorTexts(naming) {
  const lang = getLang(), other = lang === 'zh' ? 'en' : 'zh';
  const amb = ambOf(naming);
  if (S.set === 'basic') {
    if (amb) {
      const a = BASIC[amb.main][lang], b = BASIC[amb.alt][lang];
      return { name: t('tc.amb.or', { a, b }), alt: S.bilingual ? t('tc.amb.or', { a: BASIC[amb.main][other], b: BASIC[amb.alt][other] }) : '', speak: t('tc.amb.speak', { a, b }) };
    }
    return { name: naming.basic[lang], alt: S.bilingual ? naming.basic[other] : '', speak: naming.basic[lang] };
  }
  const d = naming.detailed;
  const approx = naming.dE > 12 ? '≈ ' : '';
  const fam = t('card.family', { x: BASIC[naming.basicKey][lang].replace(/色$/, '') });
  const parts = [];
  if (S.bilingual) parts.push(d[other]);
  parts.push(naming.desc[lang], fam);
  const speakAmb = amb ? (lang === 'zh' ? '，' : ', ') + t('tc.amb.speakAlt', { b: BASIC[amb.alt][lang] }) : '';
  return { name: approx + d[lang], alt: parts.join(' · '), speak: `${d[lang]}，${naming.desc[lang]}${speakAmb}` };
}
/** The true-colour ambiguity, when it belongs to the name shown. */
function ambOf(naming) {
  const a = tcOn() ? R.tc.amb : null;
  return a && naming && a.main === naming.basicKey ? a : null;
}

const WARN_SVG = '<svg class="ic ic-s"><use href="#i-warn"/></svg>';
function setHTML(el, html) { if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; } }
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function updateCard() {
  const naming = R.lastNaming, rgb = R.lastRgb;
  if (!naming || !rgb) return;
  const lang = getLang();
  const hex = rgbToHex(...rgb);
  $('swatch').style.background = hex;
  const tx = colorTexts(naming);
  $('colorName').textContent = tx.name;
  $('colorAlt').textContent = tx.alt;
  // status: a chip that says where the colour comes from (tap: how it works), then at most a couple
  // of short messages; what the hint strip already says is not repeated here
  const st = [];
  const p = R.patch;
  const tc = tcOn() ? R.tc.last : null;
  const chip = (text) => `<button class="tag-chip"><svg class="ic"><use href="#i-info"/></svg><span>${esc(text)}</span></button>`;
  const SHOWN_NOTES = ['noAnchor', 'shadow', 'paperClip', 'torchDist', 'torchWeak', 'chartPoor', 'torchAnchor'];
  if (tcOn()) {
    // the top bar already says "true colour": the chip says the source and how sure
    st.push(chip(tc ? t('tc.tagShort', { src: t('tc.tag.' + tc.source), conf: t('tc.conf.' + tc.conf) }) : t('tc.on')));
    const amb = ambOf(naming);
    if (amb) st.push(`<b class="tc-amb">${esc(t('tc.amb.short', { b: BASIC[amb.alt][lang] }))}</b>`);
    const notes = (tc ? tc.notes : []).filter((n) => SHOWN_NOTES.includes(n));
    if (notes.length) st.push(WARN_SVG + esc(t('tc.note.' + notes[0])));
    if (p && p.clipped > 0.35) st.push(WARN_SVG + esc(t('warn.over')));
    if (naming.alt && !amb) st.push(esc(t('card.maybe', { x: naming.alt[lang] })));
    const sc = R.tc.screen;
    if (sc && sc.basicKey !== naming.basicKey) st.push(esc(t('tc.screen', { x: sc.basic[lang] })));
  } else {
    st.push(chip(t('tag.screen')));
    if (p && p.clipped > 0.35) st.push(WARN_SVG + esc(t('warn.over')));
    else if (p && p.Y < 0.012) st.push(WARN_SVG + esc(t('warn.dark')));
    if (naming.alt) st.push(esc(t('card.maybe', { x: naming.alt[lang] })));
  }
  // only touch the DOM when something changed: a button that is replaced every frame cannot be tapped
  setHTML($('colorStatus'), st[0]);
  setHTML($('colorMsgs'), st.slice(1).join(' · '));
  $('card').classList.toggle('tc-card', tcOn());
  syncGuide();
  // one line with the values only
  setHTML($('colorSub'), S.values ? `<span class="hex" data-hex="${hex}">${hex}</span> · <span class="rgb">RGB ${rgb.join(', ')}</span>` : '');
}

function speakText(text) {
  if (!('speechSynthesis' in window) || !text) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = getLang() === 'zh' ? 'zh-CN' : 'en-US';
    u.rate = 1;
    speechSynthesis.speak(u);
  } catch { /* ignore */ }
}
function speakCurrent() { if (R.lastNaming) speakText(colorTexts(R.lastNaming).speak); }
function onNameChanged() { if (S.autoSpeak) speakCurrent(); }

// ---------------- true colour (真色) ----------------
// The colour card can show the object's own colour instead of the picture's. Sources: camera only
// (white anchor), white paper next to the object, torch difference, colour chart. See truecolor.js.
const TC_SRCS = ['auto', 'camera', 'paper', 'torch', 'chart'];
function camKey() { return camera.deviceId || 'default'; }
function camCal() { return (S.tc.cams[camKey()] ||= {}); }

function onTCStats(st) {
  R.tc.stats = st;
  const now = performance.now();
  if (st.anchor) R.tc.anchors.push({ t: now, ...st.anchor });
  R.tc.anchors = R.tc.anchors.filter((a) => now - a.t < 1500);
  // the brightest neutral seen over the last moment, so aiming close at the object keeps the anchor
  const neutral = R.tc.anchors.filter((a) => a.neutral);
  R.tc.anchor = neutral.length ? neutral.reduce((a, b) => (b.Y > a.Y ? b : a)) : (st.anchor || null);
  if (Number.isFinite(st.noise)) R.tc.noise = R.tc.noise == null ? st.noise : R.tc.noise + 0.25 * (st.noise - R.tc.noise);
  if (wbOpen() && tcOn()) syncTCStatus();
  const pf = paperUsable(st);
  if (pf !== R.tc.paperFound) { R.tc.paperFound = pf; if (S.tc.src === 'paper') syncTCBar(); }
}

/** This lens's chart calibration (profile and low-light saturation), not for gallery photos. */
function calibNow() {
  return R.kind !== 'photo' ? calibrationFor(S.tc.cams[camKey()], R.tc.noise, { defaultSat: S.tc.defaultSat }) : { profile: null, sat: null, satFrom: null };
}
/** A chart in use: fitted on the frozen frame, or found in the live picture within the last second. */
function activeChart() {
  if (R.tc.chart && R.kind !== 'camera') return R.tc.chart;
  const lc = R.tc.liveChart;
  if (lc && R.kind === 'camera' && (S.tc.src === 'auto' || S.tc.src === 'chart') && performance.now() - lc.at < 1300) return lc;
  return null;
}
/** Camera-only estimate with the anchor, shadow and mixed-light choices. */
function cameraEstimate(raw, calib = calibNow()) {
  const st = R.tc.stats;
  const bg = blendGains(wbGains(), st && st.localWB);
  const e = passiveEstimate(raw, { gains: bg.gains, mean: st && st.mean, anchor: R.tc.anchor, localAnchor: st && st.localAnchor, shadow: R.tc.shadow, anchorRho: R.tc.anchorRho, ...calib });
  e.mixed = bg.mixed;
  return e;
}

function paperUsable(st) { return !!(st && st.paper && st.paper.found && !st.paper.clipped); }

/** True-colour estimate for the picked colour ({raw, lin, src}). */
function trueEstimate(pick) {
  const h = R.tc.held;
  if (h && h.retVer === R.retVer && h.kind === R.kind) return { ...h.est, held: true };
  const ch = activeChart();
  if (ch) {
    const e = chartEstimate(pick.raw, ch.fit, ch.residual);
    if (ch.kind === 'print14') e.source = S.tc.printRef ? 'printCal' : 'print';
    e.residual = ch.residual; e.chartLive = R.kind === 'camera';
    return e;
  }
  const st = R.tc.stats;
  const calib = calibNow();
  const notes = [];
  let e = null;
  if ((S.tc.src === 'auto' || S.tc.src === 'paper') && paperUsable(st)) {
    e = paperEstimate(pick.raw, { paper: st.paper.rgb, mean: st.mean, rho: S.tc.rho, ...calib });
  }
  if (!e) {
    e = cameraEstimate(pick.raw, calib);
    if (S.tc.src === 'paper') notes.push(st && st.paper && st.paper.clipped ? 'paperClip' : 'paperMissing');
  }
  e.calibrated = !!(calib.sat || calib.profile); e.satFrom = calib.satFrom;
  if (S.tc.src === 'torch') notes.push(torchState().ok ? 'torchHint' : 'torchNo');
  if (S.tc.src === 'chart') notes.push('chartHint');
  e.notes = [...notes, ...e.notes];
  return e;
}

/** Can this camera do a torch measurement? {ok, torch, manual: 'ok'|'fail'|'unknown'|'no'} */
function torchState() {
  if (R.kind !== 'camera' || !camera.live) return { ok: false, torch: false, manual: 'no', live: false };
  const mc = measureCaps(camera.caps);
  const v = (S.tc.cams[camKey()] || {}).manual;
  const manual = !mc.manualListed ? 'no' : !v ? 'unknown' : v.ok ? 'ok' : 'fail';
  return { ok: mc.torch && (manual === 'ok' || manual === 'unknown'), torch: mc.torch, manual, live: true, cal: !!(S.tc.cams[camKey()] || {}).torch };
}

// camera adapter for measure.js (advanced constraints only: a new basic set would drop the size)
const camAdapter = {
  caps: () => camera.caps,
  settings: () => camera.settings,
  apply: async (c) => {
    const tr = camera.track;
    if (!tr) return false;
    try { await tr.applyConstraints({ advanced: [c] }); return true; } catch { return false; }
  },
};

function nextVideoFrame() {
  return new Promise((res) => {
    if (R.kind === 'camera' && 'requestVideoFrameCallback' in HTMLVideoElement.prototype) {
      let done = false;
      const to = setTimeout(() => { done = true; res(); }, 150);
      video.requestVideoFrameCallback(() => { if (!done) { done = true; clearTimeout(to); res(); } });
    } else setTimeout(res, 40);
  });
}

/** Reader for measure.js: linear means of the target (and the paper) over n fresh frames. */
function makeReader(paper) {
  return async (n) => {
    const ts = [], rs = [];
    let tClip = 0, refClip = 0;
    for (let k = 0; k < n; k++) {
      await nextVideoFrame();
      if (R.glOk && R.kind === 'camera') { try { R.renderer.upload(video); } catch { /* not ready */ } }
      const c = crop();
      if (!c) continue;
      const p = samplePatchAt(c, R.reticle, 18);
      ts.push(p.raw); tClip = Math.max(tClip, p.clipped);
      if (paper) { const q = samplePatchAt(c, paper, paper.size); rs.push(q.raw); refClip = Math.max(refClip, q.clipped); }
    }
    const avg = (a) => (a.length ? [0, 1, 2].map((k) => a.reduce((s, v) => s + v[k], 0) / a.length) : [0, 0, 0]);
    return { t: avg(ts), ref: paper ? avg(rs) : null, tClip, refClip };
  };
}

/** Reticle (picture fractions) -> pointsOfInterest (fractions of the whole camera frame). */
function poiOf(pos) {
  const c = crop();
  if (!c) return { x: 0.5, y: 0.5 };
  const x = mirrored() ? 1 - pos.x : pos.x;
  return { x: (c.x + x * c.w) / c.sw, y: (c.y + pos.y * c.h) / c.sh };
}

async function ensureManualVerified() {
  const cal = camCal();
  if (cal.manual) return cal.manual.ok;
  showHud(t('tc.hud.verify'), 6000);
  const v = await verifyManualExposure(camAdapter, makeReader(null), sleep, { torch: true });
  // "too dark" says nothing about the camera: check again next time
  if (v.reason !== 'tooDark') cal.manual = { ok: v.ok, ratios: v.ratios, reason: v.reason, at: Date.now() };
  if (v.toneK) cal.toneK = v.toneK;
  save();
  if (!v.ok) toast(t(v.reason === 'tooDark' ? 'tc.toast.verifyDark' : 'tc.toast.manualFail'), 6000);
  return v.ok;
}

function torchPrecheck() {
  if (R.tc.busy) return false;
  const ts = torchState();
  if (!ts.live) { toast(t('tc.toast.needLive')); return false; }
  if (!ts.torch) { toast(t('tc.toast.noTorch'), 5000); return false; }
  if (ts.manual === 'no') { toast(t('tc.toast.noManual'), 6000); return false; }
  if (ts.manual === 'fail') { toast(t('tc.toast.manualFail'), 6000); return false; }
  return true;
}

async function withTorchBusy(fn) {
  R.tc.busy = true; syncTCBar();
  try { return await fn(); } finally {
    R.tc.busy = false; camera.torchOn = false;
    if (S.wbMode === 'manual' && S.wbLocked) await camera.lockWB();
    $('hud').hidden = true;
    updateToolbar(); syncTCBar(); syncTCUI();
  }
}

const toneOf = (cal) => (c) => (c && cal.toneK ? c.map((v, i) => Math.pow(Math.max(0, v), cal.toneK[i])) : c);

/** ③ Torch measurement of the object under the reticle (with the paper next to it when found). */
async function measureTorch() {
  if (!torchPrecheck()) return;
  await withTorchBusy(async () => {
    if (!(await ensureManualVerified())) return;
    const cal = camCal(), tone = toneOf(cal);
    const st = R.tc.stats;
    const paper = paperUsable(st) ? { x: st.paper.cx, y: st.paper.cy, size: Math.max(10, Math.min(36, st.paper.r * Math.max(R.rect.w, R.rect.h) * 1.2)) } : null;
    if (!paper && !(cal.torch && cal.torch.wb === 'preset')) { toast(t('tc.toast.needCal'), 6000); return; }
    // without paper the torch gives the colour; lightness comes from the white anchor when there is one
    let anchorY = null;
    const pk0 = pickColor();
    if (!paper && pk0) {
      const pe = cameraEstimate(pk0.raw);
      if (pe.anchor && (pe.anchor.neutral || R.tc.anchorRho)) anchorY = luma(pe.lin);
    }
    showHud(t('tc.hud.hold'), 8000);
    const res = await torchMeasure(camAdapter, makeReader(paper), sleep, { hasRef: !!paper, poi: poiOf(R.reticle), ct: 5000 });
    if (res.error) { toast(t('tc.toast.' + res.error), 5000); return; }
    const est = paper
      ? torchEstimate({ on: tone(res.on), off: tone(res.off), ref: { on: tone(res.refOn), off: tone(res.refOff) }, rhoPaper: S.tc.rho })
      : res.wb === 'preset' ? torchEstimate({ on: tone(res.on), off: tone(res.off), cal: cal.torch, expo: res.expo, anchorY }) : null;
    if (!est) { toast(t('tc.toast.needCal'), 6000); return; }
    if (res.ratio < 1) { toast(t('tc.toast.torchWeak'), 5000); return; } // the live estimate stays
    R.tc.held = { est, retVer: R.retVer, kind: R.kind, at: Date.now() };
    R.smooth = null; R.shownKey = null; updateNaming(); onNameChanged();
    toast(t('tc.toast.measured', { src: t('tc.tag.' + est.source) }));
  });
}

/** One-time torch calibration on white paper at ~25 cm in a dim place. */
async function calibrateTorch() {
  if (!torchPrecheck()) return;
  await withTorchBusy(async () => {
    if (!(await ensureManualVerified())) return;
    const cal = camCal(), tone = toneOf(cal);
    showHud(t('tc.hud.cal'), 8000);
    const res = await torchMeasure(camAdapter, makeReader(null), sleep, { hasRef: false, poi: poiOf(R.reticle), ct: 5000 });
    if (res.error) { toast(t('tc.toast.' + res.error), 5000); return; }
    if (res.wb !== 'preset') { toast(t('tc.toast.calNoPreset'), 6000); return; }
    const D = tone(res.on).map((v, k) => v - tone(res.off)[k]);
    const mx = Math.max(...D), mn = Math.min(...D);
    if (res.ratio < 2 || mx < 0.04) { toast(t('tc.toast.calTooBright'), 6000); return; }
    if ((mx - mn) / mx > 0.45) { toast(t('tc.toast.calNotWhite'), 6000); return; }
    cal.torch = { white: D, expo: res.expo, wb: res.wb, at: Date.now() };
    save();
    toast(t('tc.toast.calDone'), 4000);
  });
}

// ---- ④ colour chart: tap the centres of the four corner patches on a frozen frame ----
function chartFor(kind, nominal = false) {
  if (kind === 'print14' && S.tc.printRef && !nominal) return { ...CHARTS.print14, ref: S.tc.printRef };
  return CHARTS[kind];
}

async function startChartPick(purpose = 'measure', { auto = true } = {}) {
  if (!R.source) return;
  if (wbOpen()) setWBOpen(false);
  if (R.kind === 'camera') { R.tc.noiseAtFreeze = R.tc.noise; await freeze(); }
  R.tc.chart = null; R.tc.held = null;
  R.tc.pick = { kind: purpose === 'validate' ? 'cc24' : S.tc.chart, purpose, pts: [], stage: 0, ccFit: null };
  syncTCBar(); drawOverlay();
  // try to find the chart automatically first (the user can still tap the corners)
  if (purpose !== 'printCal' && auto) { R.tc.detectDone = false; R.tc.autoPick = true; requestAnalysis(); }
}

/** Patch colours at full resolution from patch centres (picture fractions, chart order). */
function sampleChartAt(pts, chart) {
  const c = crop();
  const W = R.rect.w, H = R.rect.h;
  const step = Math.min(Math.hypot((pts[1][0] - pts[0][0]) * W, (pts[1][1] - pts[0][1]) * H), Math.hypot((pts[chart.cols][0] - pts[0][0]) * W, (pts[chart.cols][1] - pts[0][1]) * H));
  const meas = pts.map(([x, y]) => { const p = samplePatchAt(c, { x, y }, Math.max(4, 0.56 * step)); return p.clipped > 0.5 ? null : p.raw; });
  return meas.some((m) => !m) ? null : meas;
}

/** A chart found by the analysis worker (or null). */
function onChartDetected(ch) {
  if (!tcOn()) return;
  if (R.kind === 'camera') {
    if (ch) {
      const chart = chartFor(ch.kind);
      const fit = fitChart(ch.meas, chart.ref, chart.neutral);
      const was = !!R.tc.liveChart;
      if (fit) R.tc.liveChart = { fit, residual: fit.residual, kind: ch.kind, pts: ch.pts, meas: ch.meas, at: performance.now(), auto: true };
      if (!was) { R.smooth = null; syncTCBar(); }
    } else if (R.tc.liveChart && performance.now() - R.tc.liveChart.at > 1300) { R.tc.liveChart = null; R.smooth = null; syncTCBar(); }
    return;
  }
  // frozen frame or photo: only while choosing a chart
  const pk = R.tc.pick;
  if (!pk || !R.tc.autoPick) return;
  R.tc.autoPick = false;
  if (!ch || (pk.purpose === 'validate' && ch.kind !== 'cc24')) {
    toast(t(pk.purpose === 'validate' ? 'val.notFound' : 'tc.toast.chartManual'), 4500);
    return;
  }
  if (pk.purpose !== 'validate') pk.kind = ch.kind;
  applyChartPoints(ch.pts, true);
}

function finishChartPick() {
  const pk = R.tc.pick;
  const kind = pk.purpose === 'printCal' ? (pk.stage === 0 ? 'cc24' : 'print14') : pk.kind;
  const chart = chartFor(kind, pk.purpose === 'printCal');
  const W = R.rect.w, H = R.rect.h;
  const c = crop();
  // in picture px, so the grid geometry is isotropic
  const sample = (x, y, r) => {
    if (x < 0 || y < 0 || x > W || y > H) return null;
    const p = samplePatchAt(c, { x: x / W, y: y / H }, Math.max(4, 2 * r));
    return p.clipped > 0.5 ? null : p.raw;
  };
  const best = orientAndFit(pk.pts.map(([x, y]) => [x * W, y * H]), sample, chart);
  if (!best || best.fit.residual > 10) {
    pk.pts = [];
    toast(t('tc.toast.chartFail'), 4500);
    syncTCBar(); drawOverlay();
    return;
  }
  applyChartPoints(best.pts.map(([x, y]) => [x / W, y / H]), false);
}

/** Use a chart whose patch centres (picture fractions, chart order) are known. */
function applyChartPoints(pts, auto) {
  const pk = R.tc.pick;
  const kind = pk.purpose === 'printCal' ? (pk.stage === 0 ? 'cc24' : 'print14') : pk.kind;
  const chart = chartFor(kind, pk.purpose === 'printCal');
  const meas = sampleChartAt(pts, chart);
  const fit = meas && fitChart(meas, chart.ref, chart.neutral);
  if (!fit || fit.residual > 10) {
    pk.pts = [];
    toast(t(auto ? 'tc.toast.chartManual' : 'tc.toast.chartFail'), 4500);
    syncTCBar(); drawOverlay();
    return;
  }
  const best = { fit, meas, pts };
  if (pk.purpose === 'validate') { R.tc.pick = null; runValidation(meas, pts, fit); syncTCBar(); drawOverlay(); return; }
  if (pk.purpose === 'printCal') {
    if (pk.stage === 0) {
      pk.ccFit = best.fit; pk.stage = 1; pk.pts = [];
      toast(t('tc.toast.printCalNext'), 4000);
      syncTCBar(); drawOverlay();
      return;
    }
    S.tc.printRef = printCalibration(pk.ccFit, best.meas); save();
    R.tc.pick = null;
    toast(t('tc.toast.printCalDone'), 4000);
    syncTCBar(); drawOverlay();
    return;
  }
  R.tc.pick = null;
  R.tc.chart = { fit: best.fit, residual: best.fit.residual, kind, pts: best.pts, auto };
  // a chart photographed with this lens also calibrates the lens: how much it desaturates at this
  // noise level, and (from the best-lit chart so far) its colour processing, for paper / camera only.
  // Only with true reference colours: a ColorChecker, or the printed card once it is calibrated.
  let saved = false;
  if (R.kind === 'frozen' && R.tc.noiseAtFreeze != null && (kind === 'cc24' || S.tc.printRef)) {
    const cal = camCal(), noise = R.tc.noiseAtFreeze;
    cal.sat = addSatPoint(cal.sat, noise, best.fit.sat);
    if (best.fit.residual <= 3 && (!cal.profile || !(cal.profile.noise > 0) || noise < cal.profile.noise * 1.25)) {
      const pf = makeProfile(best.meas, chart, noise);
      if (pf) { cal.profile = pf; saved = true; }
    }
    save();
  }
  toast(t(saved ? 'tc.toast.profileSaved' : auto ? 'tc.toast.chartAuto' : 'tc.toast.chartDone', { e: best.fit.residual.toFixed(1) }), 4000);
  R.smooth = null; R.shownKey = null;
  syncTCBar(); drawOverlay(); requestAnalysis();
}

function cancelChartPick() { R.tc.pick = null; R.tc.autoPick = false; syncTCBar(); drawOverlay(); }
function undoChartTap() { const pk = R.tc.pick; if (pk && pk.pts.length) { pk.pts.pop(); syncTCBar(); drawOverlay(); } }

/** A tap while picking chart corners (picture fractions). */
function chartTap(x, y) {
  const pk = R.tc.pick;
  if (!pk) return;
  R.tc.autoPick = false; // the user is placing the corners: an automatic result arriving now must not override them
  pk.pts.push([x, y]);
  syncTCBar(); drawOverlay();
  if (pk.pts.length === 4) finishChartPick();
}

function clearTCHold() { R.tc.held = null; R.tc.chart = null; R.tc.pick = null; R.tc.paperPick = false; }

/** Paper chosen by a tap (e.g. paper in the object's shadow, which automatic search skips). */
function startPaperPick() { R.tc.paperPick = true; R.tc.pick = null; if (wbOpen()) setWBOpen(false); syncTCBar(); }
function setPaperAt(x, y) {
  R.tc.paperAt = { x, y, r: 0.035 };
  R.tc.paperPick = false;
  toast(t('tc.toast.paperSet'), 3500);
  R.smooth = null; syncTCBar(); requestAnalysis();
}
function clearPaperAt() { R.tc.paperAt = null; R.tc.paperPick = false; syncTCBar(); if (wbOpen()) syncTCUI(); requestAnalysis(); }

function downloadPrintCard() {
  const svg = printCardSVG({ title: t('tc.card.title'), note: t('tc.card.note') });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  a.download = 'color-vision-helper-card.svg';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function drawTCMarks(ctx) {
  const d = R.dpr, rc = R.rect;
  const P = (x, y) => [(rc.x + x * rc.w) * d, (rc.y + y * rc.h) * d];
  const ring = (x, y, r, fill) => {
    const [px, py] = P(x, y);
    ctx.beginPath(); ctx.arc(px, py, r * d, 0, Math.PI * 2);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    ctx.lineWidth = 4 * d; ctx.strokeStyle = 'rgba(0,0,0,0.75)'; ctx.stroke();
    ctx.lineWidth = 2 * d; ctx.strokeStyle = '#fff'; ctx.stroke();
  };
  const fs = TEXT_SCALE[S.textSize] || 1;
  const label = (text, x, y) => {
    const fh = 12.5 * fs * d, h = fh + 9 * d;
    ctx.font = `700 ${fh}px sans-serif`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    const w = ctx.measureText(text).width + 14 * d;
    ctx.fillStyle = 'rgba(0,0,0,0.72)';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y - h - 3 * d, w, h, 7 * d); else ctx.rect(x, y - h - 3 * d, w, h);
    ctx.fill();
    ctx.fillStyle = '#fff'; ctx.fillText(text, x + 7 * d, y - h / 2 - 3 * d);
  };
  const box = (at, text) => {
    const [x0, y0] = P(at.x, at.y), [x1, y1] = P(at.x + at.w, at.y + at.h);
    ctx.save(); ctx.setLineDash([7 * d, 5 * d]);
    ctx.lineWidth = 3.5 * d; ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    ctx.lineWidth = 1.6 * d; ctx.strokeStyle = '#fff'; ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    ctx.restore();
    if (text) label(text, Math.max(rc.x * d + 2, Math.min(x0, (rc.x + rc.w) * d - 150 * d)), Math.max((rc.y + 20) * d, y0));
  };
  const pk = R.tc.pick;
  if (pk) {
    pk.pts.forEach(([x, y], i) => {
      ring(x, y, 9);
      const [px, py] = P(x, y);
      ctx.font = `800 ${12 * d}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.lineWidth = 3 * d; ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.strokeText(String(i + 1), px, py - 18 * d);
      ctx.fillStyle = '#fff'; ctx.fillText(String(i + 1), px, py - 18 * d);
    });
  }
  if (!tcOn() || S.mode !== 'identify') return;
  const ch = activeChart();
  if (ch) { for (const [x, y] of ch.pts) ring(x, y, 4); return; }
  const st = R.tc.stats, e = R.tc.last;
  if (!pk && paperUsable(st) && (S.tc.src === 'auto' || S.tc.src === 'paper' || S.tc.src === 'torch')) {
    // show where the paper was found (a dashed circle)
    const [px, py] = P(st.paper.cx, st.paper.cy);
    ctx.save(); ctx.setLineDash([6 * d, 5 * d]);
    ctx.beginPath(); ctx.arc(px, py, Math.max(12, st.paper.r * Math.max(rc.w, rc.h)) * d, 0, Math.PI * 2);
    ctx.lineWidth = 3.5 * d; ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.stroke();
    ctx.lineWidth = 1.6 * d; ctx.strokeStyle = '#fff'; ctx.stroke();
    ctx.restore();
    return;
  }
  // camera only: the surface taken as white (a dashed box), so the user can judge it
  if (!pk && e && e.source === 'camera' && e.anchor && e.anchor.at && !e.held) {
    // the label explains the box; once the hint is closed the box alone is enough
    const key = R.tc.anchorRho ? 'tc.mark.user' : e.anchorLocal ? 'tc.mark.local' : e.anchor.neutral ? 'tc.mark.white' : 'tc.mark.bright';
    box(e.anchor.at, hintClosed() && !R.tc.anchorMenu ? '' : t(key, { p: Math.round((R.tc.anchorRho || 0) * 100) }));
  }
}

/** Real (true colour) or screen (picture colour). Both have Identify and Correct. */
function setScene(scene) {
  if (scene !== 'real' && scene !== 'screen') return;
  S.scene = scene; save();
  if (scene === 'screen') { clearTCHold(); R.tc.liveChart = null; R.tc.anchorMenu = false; }
  R.smooth = null; R.shownKey = null; R.tc.last = null; R.tc.amb = null;
  syncSceneUI(); syncWBUI(); syncTCBar(); updateCard(); syncGuide(); drawOverlay(); updateGpuTC(); requestAnalysis();
}
/** Old switch, kept for tests. */
function setTC(on) { setScene(on ? 'real' : 'screen'); }
function syncSceneUI() {
  $('sceneReal').setAttribute('aria-selected', String(tcOn()));
  $('sceneScreen').setAttribute('aria-selected', String(!tcOn()));
  app.classList.toggle('tc-on', tcOn());
  app.classList.toggle('scene-screen', !tcOn());
}
function setTCSource(src) {
  if (!TC_SRCS.includes(src)) return;
  S.tc.src = src; save();
  if (src !== 'chart' && R.tc.pick && R.tc.pick.purpose === 'measure') R.tc.pick = null;
  R.smooth = null; R.shownKey = null;
  syncTCUI(); syncTCBar(); syncGuide(); requestAnalysis();
}

// ---------------- hint strip and the explanation sheet ----------------
// One strip above the colour card shows either
//  - a step that needs the user now (choosing a chart, tapping the paper, a measurement running, a
//    held torch result, "how gray is it?"): always shown, no close button; or
//  - a hint: what is being measured and how, with at most one optional action. A hint closed with ×
//    stays closed for this scene and mode. The ⓘ chip on the colour card (or ⓘ on the correction
//    panel) opens the full explanation in a sheet, and Settings → "Show tips again" brings hints back.

/** Actions for buttons in the strip and in the sheet (data-act="..."). */
const ACT = {
  undo: () => undoChartTap(), cancel: () => cancelChartPick(),
  done: () => { clearTCHold(); resumeLive(); syncTCBar(); },
  again: () => measureTorch(), measure: () => { closeInfo(); measureTorch(); },
  live: () => { R.tc.held = null; R.smooth = null; R.shownKey = null; syncTCBar(); requestAnalysis(); },
  pick: () => { closeInfo(); startChartPick('measure'); },
  cancelPaper: () => { R.tc.paperPick = false; syncTCBar(); },
  pickPaper: () => { closeInfo(); startPaperPick(); }, paperAuto: () => clearPaperAt(),
  notWhite: () => { R.tc.anchorMenu = true; syncTCBar(); },
  rhoLight: () => setAnchorRho(0.6), rhoMid: () => setAnchorRho(0.35), rhoWhite: () => setAnchorRho(null),
  rhoCancel: () => { R.tc.anchorMenu = false; syncTCBar(); },
  noShadow: () => setShadow('off'), shadowAuto: () => setShadow('auto'),
  saveLens: () => saveLiveChartCalibration(),
  validate: () => { closeInfo(); startValidation(); },
  light: () => { closeInfo(); setWBOpen(true); },
};
function setAnchorRho(v) { R.tc.anchorRho = v; R.tc.anchorMenu = false; R.smooth = null; R.shownKey = null; syncTCBar(); updateGpuTC(); requestAnalysis(); }
function setShadow(v) { R.tc.shadow = v; R.smooth = null; syncTCBar(); requestAnalysis(); }
const hintKey = () => `${S.scene}.${S.mode}`;
const hintClosed = () => !!(S.hintsOff && S.hintsOff[hintKey()]);

/** What the strip shows now: {kind: 'step' | 'hint' | null, line, acts: [[act, labelKey, primary?]]}. */
function hintState() {
  if (!R.source) return { kind: null };
  const step = (key, vars, acts = []) => ({ kind: 'step', line: t(key, vars), acts });
  if (tcOn() && S.mode === 'identify') {
    const pk = R.tc.pick, h = R.tc.held, lc = activeChart();
    if (R.tc.busy || R.freezing) return step(R.freezing ? 'tc.bar.freezing' : 'tc.bar.busy');
    if (R.tc.paperPick) return step('tc.bar.pickPaper', null, [['cancelPaper', 'tc.btn.cancel']]);
    if (pk) {
      const key = pk.purpose === 'printCal' ? (pk.stage === 0 ? 'tc.bar.pickCC' : 'tc.bar.pickPrint') : pk.purpose === 'validate' ? 'tc.bar.pickVal' : 'tc.bar.pick';
      return step(R.tc.autoPick ? 'tc.bar.looking' : key, { n: pk.pts.length }, [['undo', 'tc.btn.undo'], ['cancel', 'tc.btn.cancel']]);
    }
    if (R.tc.chart && R.kind !== 'camera') return step(R.tc.chart.auto ? 'tc.bar.chartAuto' : 'tc.bar.chart', { e: R.tc.chart.residual.toFixed(1) }, [['done', 'tc.btn.done', true]]);
    if (h && h.retVer === R.retVer && h.kind === R.kind) return step('tc.bar.held', { src: t('tc.tag.' + h.est.source) }, [['again', 'tc.btn.again'], ['live', 'tc.btn.live']]);
    if (R.tc.anchorMenu) return step('tc.bar.anchorAsk', null, [['rhoLight', 'tc.btn.rhoLight'], ['rhoMid', 'tc.btn.rhoMid'], ['rhoWhite', 'tc.btn.rhoWhite'], ['rhoCancel', 'tc.btn.cancel']]);
    // sources the user chose that need an action of their own
    if (!lc && S.tc.src === 'torch') { const ok = torchState().ok; return step(ok ? 'tc.bar.torch' : 'tc.bar.torchNo', null, ok ? [['measure', 'tc.btn.measure', true]] : []); }
    if (!lc && S.tc.src === 'chart') return step('tc.bar.chartStart', null, [['pick', 'tc.btn.pick', true]]);
    if (!lc && S.tc.src === 'paper' && !paperUsable(R.tc.stats) && !R.tc.paperAt) return step('tc.bar.paperMissing', null, [['pickPaper', 'tc.btn.pickPaper', true]]);
  }
  if (hintClosed()) return { kind: null };
  return { kind: 'hint', line: guideContent().line, acts: hintActs() };
}

/** The one optional action that goes with the current hint (camera only, paper, chart in view). */
function hintActs() {
  if (!tcOn() || S.mode !== 'identify') return [];
  const e = R.tc.last, lc = activeChart();
  if (lc) return R.kind === 'camera' && (lc.kind === 'cc24' || S.tc.printRef) && lc.residual <= 3 ? [['saveLens', 'tc.btn.saveLens']] : [];
  if (!e) return [];
  if (e.source === 'paper') return [[R.tc.paperAt ? 'paperAuto' : 'pickPaper', R.tc.paperAt ? 'tc.btn.paperAuto' : 'tc.btn.pickPaper']];
  if (e.source !== 'camera') return [];
  if (R.tc.anchorRho) return [['rhoWhite', 'tc.btn.rhoReset']];
  if (e.anchorLocal) return [['noShadow', 'tc.btn.noShadow']];
  if (R.tc.shadow === 'off' && e.shadowSuspect) return [['shadowAuto', 'tc.btn.shadowAuto']];
  return e.anchor && e.anchor.at ? [['notWhite', 'tc.btn.notWhite']] : [];
}

const actBtn = ([act, key, primary], vars) => `<button class="act-btn${primary ? ' primary-sm' : ''}" data-act="${act}">${esc(t(key, vars))}</button>`;

function syncHint() {
  const el = $('hint');
  if (!el) return;
  const st = hintState();
  const show = !!st.kind && !wbOpen();
  el.hidden = !show;
  if (show) {
    el.classList.toggle('step', st.kind === 'step');
    if ($('hintLine').textContent !== st.line) $('hintLine').textContent = st.line;
    const html = st.acts.map((a) => actBtn(a)).join('');
    if ($('hintActions').dataset.html !== html) { $('hintActions').innerHTML = html; $('hintActions').dataset.html = html; }
    $('hintClose').hidden = st.kind !== 'hint';
  }
  if (show !== R.tc.hintShown) { R.tc.hintShown = show; requestAnimationFrame(layout); }
  syncInfo();
  requestAnimationFrame(placeFloating);
}
function closeHint() {
  (S.hintsOff ||= {})[hintKey()] = true; save();
  syncHint(); drawOverlay();
  if (!S.hintTipShown) { S.hintTipShown = true; save(); toast(t('hint.closedTip'), 4200); }
}
function resetHints() { S.hintsOff = {}; S.hintTipShown = false; S.tipsShown = false; save(); syncHint(); drawOverlay(); toast(t('settings.hintsDone')); }
// old names, used all over
function syncTCBar() { syncHint(); }
function syncGuide() { syncHint(); }

/** Explanation sheet: the current line, what can be adjusted, the principle, the numbers, tips. */
function openInfo() { $('toast').classList.remove('show'); $('infoSheet').hidden = false; R.tc.infoAt = 0; syncInfo(true); }
function closeInfo() { $('infoSheet').hidden = true; }
function infoActs() {
  const acts = [];
  if (!tcOn()) return acts;
  const e = R.tc.last, lc = activeChart();
  if (S.mode === 'identify' && e && e.source === 'camera' && e.anchor) {
    acts.push({ label: 'info.adj.anchor', btns: [['rhoWhite', 'tc.btn.rhoWhite', !R.tc.anchorRho], ['rhoLight', 'tc.btn.rhoLight', R.tc.anchorRho === 0.6], ['rhoMid', 'tc.btn.rhoMid', R.tc.anchorRho === 0.35]] });
    if (e.shadowSuspect || R.tc.shadow === 'off') acts.push({ label: 'info.adj.shadow', btns: [['shadowAuto', 'tc.btn.shadowAuto', R.tc.shadow !== 'off'], ['noShadow', 'tc.btn.noShadow', R.tc.shadow === 'off']] });
  }
  if (S.mode === 'identify' && (S.tc.src === 'auto' || S.tc.src === 'paper' || S.tc.src === 'torch')) {
    acts.push({ label: 'info.adj.paper', btns: R.tc.paperAt ? [['paperAuto', 'tc.btn.paperAuto'], ['pickPaper', 'tc.btn.pickPaper']] : [['pickPaper', 'tc.btn.pickPaper']] });
  }
  if (lc && R.kind === 'camera' && (lc.kind === 'cc24' || S.tc.printRef) && lc.residual <= 3) acts.push({ label: 'info.adj.lens', btns: [['saveLens', 'tc.btn.saveLens']] });
  if (S.mode === 'identify' && S.tc.src === 'torch' && torchState().ok) acts.push({ label: 'info.adj.torch', btns: [['measure', 'tc.btn.measure']] });
  acts.push({ label: 'info.adj.more', btns: [['light', 'info.btn.light'], ['validate', 'tc.btn.validate']] });
  return acts;
}
function syncInfo(force = false) {
  const sh = $('infoSheet');
  if (!sh || sh.hidden) return;
  // the numbers change every frame: redraw at most once a second, and keep the scroll position
  const now = performance.now();
  if (!force && now - (R.tc.infoAt || 0) < 1000) return;
  R.tc.infoAt = now;
  const { line, more } = guideContent();
  $('infoLine').textContent = line;
  const acts = infoActs().map((g) => `<div class="info-act"><div class="info-act-label">${esc(t(g.label))}</div><div class="info-act-btns">${g.btns.map(([a, k, on]) => `<button class="act-btn${on ? ' on' : ''}" data-act="${a}">${esc(t(k))}</button>`).join('')}</div></div>`).join('');
  if ($('infoActions').dataset.html !== acts) { $('infoActions').innerHTML = acts; $('infoActions').dataset.html = acts; }
  const body = $('infoBody');
  if (body.dataset.html !== more) { const top = sh.querySelector('.sheet-inner').scrollTop; body.innerHTML = more; body.dataset.html = more; sh.querySelector('.sheet-inner').scrollTop = top; }
}

/** A chart seen in the live picture, with low error: keep it as this lens's calibration. */
function saveLiveChartCalibration() {
  const lc = R.tc.liveChart;
  if (!lc || R.kind !== 'camera' || !Number.isFinite(R.tc.noise)) { toast(t('tc.toast.saveLensNo')); return; }
  const chart = chartFor(lc.kind), cal = camCal(), noise = R.tc.noise;
  cal.sat = addSatPoint(cal.sat, noise, lc.fit.sat);
  let saved = false;
  if (!cal.profile || !(cal.profile.noise > 0) || noise < cal.profile.noise * 1.25) {
    const pf = makeProfile(lc.meas, chart, noise);
    if (pf) { cal.profile = pf; saved = true; }
  }
  save();
  toast(t(saved ? 'tc.toast.lensSaved' : 'tc.toast.lensSatOnly'), 4000);
  syncTCUI(); syncGuide();
}

/** True-colour part of the light popover. */
function syncTCUI() {
  $('wbBox').hidden = tcOn();
  $('tcBox').hidden = !tcOn();
  $('lightTitle').textContent = t(tcOn() ? 'light.title' : 'light.titleScreen');
  document.querySelectorAll('#tcSrc button').forEach((b) => b.classList.toggle('on', b.dataset.src === S.tc.src));
  document.querySelectorAll('#tcRho button').forEach((b) => b.setAttribute('aria-selected', String(+b.dataset.rho === S.tc.rho)));
  document.querySelectorAll('#tcChart button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.chart === S.tc.chart)));
  const src = S.tc.src;
  $('tcPaperRow').hidden = !(src === 'paper' || src === 'auto' || src === 'torch');
  $('tcTorchRow').hidden = src !== 'torch';
  $('tcChartRow').hidden = src !== 'chart';
  $('btnPrintCal').hidden = S.tc.chart !== 'print14';
  $('btnPaperAuto').hidden = !R.tc.paperAt;
  $('btnTorchRecheck').hidden = !(src === 'torch' && torchState().manual === 'fail');
  $('optTcPreview').checked = S.tc.preview; $('optTcDefSat').checked = S.tc.defaultSat;
  const cal = S.tc.cams[camKey()];
  $('btnTCReset').hidden = !(cal && (cal.profile || (cal.sat && cal.sat.length) || cal.torch || cal.manual));
  syncTCStatus();
}

/** Live status line in the popover: what the current source can use right now. */
function syncTCStatus() {
  const el = $('tcDesc');
  if (!el) return;
  const src = S.tc.src, st = R.tc.stats;
  const parts = [t('tc.desc.' + src)];
  if (src === 'auto' || src === 'paper' || src === 'torch') {
    parts.push(R.tc.paperAt ? t('tc.stat.paperManual') : paperUsable(st) ? t('tc.stat.paperYes') : st && st.paper && st.paper.clipped ? t('tc.stat.paperClip') : t('tc.stat.paperNo'));
  }
  if (src === 'auto' || src === 'camera') parts.push(R.tc.anchor && R.tc.anchor.neutral ? t('tc.stat.anchorYes') : t('tc.stat.anchorNo'));
  if (src === 'torch') {
    const ts = torchState();
    parts.push(!ts.live ? t('tc.stat.needLive') : !ts.torch ? t('tc.stat.noTorch')
      : t('tc.stat.torch', { m: t('tc.manual.' + ts.manual), c: t(ts.cal ? 'tc.cal.yes' : 'tc.cal.no') }));
  }
  if (src === 'chart' && S.tc.chart === 'print14') parts.push(t(S.tc.printRef ? 'tc.stat.printCal' : 'tc.stat.printNominal'));
  const calib = calibNow();
  if (src !== 'chart' && src !== 'torch') {
    if (calib.profile) parts.push(t('tc.stat.profile'));
    else if (calib.satFrom === 'chart') parts.push(t('tc.stat.sat'));
    else if (calib.satFrom === 'default') parts.push(t('tc.stat.defSat'));
  }
  el.textContent = parts.join('');
}

// ---------------- what the hint line and the explanation sheet say ----------------
const pct = (v) => Math.round((Math.exp(v) - 1) * 100);
/** {line, more} for the current state. `more` is HTML: the principle, the numbers in use, tips. */
function guideContent() {
  const lang = getLang();
  const P = (k, v) => `<p>${esc(t(k, v))}</p>`;
  const H = (k) => `<h4>${esc(t(k))}</h4>`;
  const li = (k, v) => `<li>${esc(t(k, v))}</li>`;
  if (!tcOn()) {
    const line = t(S.mode === 'correct' ? 'g.screen.cor' : 'g.screen.id');
    return { line, more: H('g.h.how') + P('g.screen.p1') + P('g.screen.p2') + H('g.h.tips') + P('g.screen.tips') };
  }
  const e = R.tc.last;
  const st = R.tc.stats;
  const calib = calibNow();
  const facts = [];
  let line, principle, tips;
  const srcName = e ? t('tc.tag.' + e.source) : t('tc.src.' + S.tc.src);
  if (S.mode === 'correct') {
    const gp = R.tc.gpu;
    const k = !gp ? 'g.real.corWait' : activeChart() ? 'g.real.corChart' : paperUsable(st) && S.tc.src !== 'camera' ? 'g.real.corPaper' : 'g.real.corCamera';
    line = t(k);
    principle = P('g.real.cor.p1') + P(k + '.p');
    tips = P('g.real.cor.tips');
  } else if (!e) {
    line = t('g.real.wait'); principle = P('g.why'); tips = P('g.tips.paper');
  } else {
    const s = e.source;
    if (s === 'camera') {
      line = t(e.anchorLocal ? 'g.cam.local' : R.tc.anchorRho ? 'g.cam.user' : e.anchor && e.anchor.neutral ? 'g.cam.line' : 'g.cam.noWhite');
      principle = P('g.cam.p1') + P('g.cam.p2') + (e.anchorLocal ? P('g.cam.pLocal') : '') + P('g.cam.p3');
      tips = P('g.tips.paper') + P('g.tips.notWhite');
    } else if (s === 'paper') {
      line = t('g.paper.line'); principle = P('g.paper.p1') + P('g.paper.p2'); tips = P(e.profiled ? 'g.tips.paperDone' : 'g.tips.lens');
    } else if (s.startsWith('torch')) {
      line = t(e.held ? 'g.torch.held' : 'g.torch.line', { src: srcName });
      principle = P('g.torch.p1') + P(s === 'torch+paper' ? 'g.torch.pPaper' : s === 'torch+anchor' ? 'g.torch.pAnchor' : 'g.torch.pCal');
      tips = P('g.tips.torch');
    } else {
      line = t(e.chartLive ? 'g.chart.live' : 'g.chart.line', { e: (e.residual || 0).toFixed(1) });
      principle = P('g.chart.p1') + P('g.chart.p2'); tips = P('g.tips.chart');
    }
    if (S.tc.src === 'torch' && !s.startsWith('torch')) line = t(torchState().ok ? 'g.torch.ready' : 'g.torch.no');
    // the numbers in use
    if (s === 'camera' && e.anchor) facts.push(li(e.anchorLocal ? 'g.f.anchorLocal' : R.tc.anchorRho ? 'g.f.anchorUser' : e.anchor.neutral ? 'g.f.anchor' : 'g.f.anchorBright', { y: (e.anchor.Y * 100).toFixed(1), p: Math.round((R.tc.anchorRho || 0) * 100) }));
    if (s === 'paper') facts.push(li(R.tc.paperAt ? 'g.f.paperTap' : 'g.f.paper', { y: st && st.paper && st.paper.Y ? (st.paper.Y * 100).toFixed(1) : '?' }));
    if (e.mixed) facts.push(li('g.f.mixed'));
    if (e.residual) facts.push(li('g.f.chart', { e: e.residual.toFixed(1) }));
    if (s === 'camera' || s === 'paper') {
      facts.push(li(calib.profile ? 'g.f.profile' : 'g.f.noProfile'));
      facts.push(li(calib.satFrom === 'chart' ? 'g.f.satChart' : calib.satFrom === 'default' ? 'g.f.satDefault' : 'g.f.satNone', { s: calib.sat ? Math.round(100 / calib.sat) : 100 }));
    }
    if (Number.isFinite(R.tc.noise) && R.kind !== 'photo') facts.push(li('g.f.noise', { n: R.tc.noise.toExponential(1) }));
    const [dL, dC] = uncertaintyOf(e, { residual: e.residual, calibrated: e.calibrated });
    facts.push(li('g.f.range', { l: pct(dL), c: pct(dC) }));
    if (R.tc.amb) facts.push(li('g.f.amb', { a: BASIC[R.tc.amb.main][lang], b: BASIC[R.tc.amb.alt][lang] }));
  }
  if (R.kind === 'frozen' && R.tc.freezeInfo) {
    const fi = R.tc.freezeInfo;
    line += t('g.frozen', { n: fi.frames });
    facts.push(li('g.f.frozen', { n: fi.frames, d: fi.dropped }));
  }
  if (R.kind === 'photo') { line += t('g.photo'); facts.push(li('g.f.photo')); }
  const more = H('g.h.how') + principle + (facts.length ? H('g.h.now') + `<ul>${facts.join('')}</ul>` : '')
    + H('g.h.tips') + tips + H('g.h.why') + P('g.why');
  return { line, more };
}
// ---------------- validation on this phone (ColorChecker, results stay on the phone) ----------------
const VAL_KEY = 'cvh.validation.v1';
function loadRuns() { try { return JSON.parse(localStorage.getItem(VAL_KEY) || '[]'); } catch { return []; } }
function saveRuns(runs) { try { localStorage.setItem(VAL_KEY, JSON.stringify(runs.slice(-50))); } catch { toast(t('val.storeFail')); } }

async function startValidation() {
  if (!tcOn() || !R.source) return;
  if (S.mode !== 'identify') setMode('identify');
  await startChartPick('validate');
  toast(t('val.looking'), 3500);
}

function runValidation(meas, pts, fit) {
  const st = R.tc.stats;
  const paper = paperUsable(st) ? st.paper.rgb : null;
  const noise = R.tc.noiseAtFreeze ?? R.tc.noise;
  const res = validateChart(meas, {
    gains: wbGains(), mean: st && st.mean, anchor: R.tc.anchor, localAnchor: st && st.localAnchor,
    paper, rho: S.tc.rho, calib: calibNow(), defaultSat: defaultSatAt(noise),
  });
  const r5 = (v) => Math.round(v * 1e5) / 1e5;
  const run = {
    at: new Date().toISOString(), app: APP_VERSION, lens: camera.label || '', kind: R.kind, noise, frames: R.tc.freezeInfo ? R.tc.freezeInfo.frames : 1,
    chartFit: +fit.residual.toFixed(2), paperFrom: res.paperFrom, gains: wbGains().map(r5),
    anchor: R.tc.anchor ? { Y: r5(R.tc.anchor.Y), neutral: R.tc.anchor.neutral } : null,
    meas: meas.map((m) => m.map(r5)), pts: pts.map((p) => p.map(r5)),
    summary: Object.fromEntries(Object.entries(res.summary).map(([k, v]) => [k, { n: v.n, median: +v.median.toFixed(2), p90: +v.p90.toFixed(2), names: v.names }])),
  };
  const runs = loadRuns(); runs.push(run); saveRuns(runs);
  R.tc.chart = { fit, residual: fit.residual, kind: 'cc24', pts, auto: false };
  openValidation(run);
}

function openValidation(latest = null) {
  const runs = loadRuns();
  const run = latest || runs[runs.length - 1];
  const SRC = ['picture', 'camera', 'cameraDefaultSat', 'paper', 'chart'];
  let html = '';
  if (run) {
    html += `<p class="desc">${esc(t('val.meta', { at: run.at.replace('T', ' ').slice(0, 16), lens: run.lens || '—', f: run.frames, e: run.chartFit, n: run.noise ? (+run.noise).toExponential(1) : '—' }))}</p>`;
    html += `<table class="val-table"><thead><tr><th>${esc(t('val.col.src'))}</th><th>${esc(t('val.col.med'))}</th><th>${esc(t('val.col.p90'))}</th><th>${esc(t('val.col.names'))}</th></tr></thead><tbody>`;
    for (const k of SRC) {
      const v = run.summary[k];
      if (!v) continue;
      const label = t('val.src.' + k) + (k === 'paper' ? t(run.paperFrom === 'sheet' ? 'val.paperSheet' : 'val.paperChart') : '');
      html += `<tr><td>${esc(label)}</td><td>${v.median.toFixed(1)}</td><td>${v.p90.toFixed(1)}</td><td>${v.names}/${v.n}</td></tr>`;
    }
    html += '</tbody></table>';
    html += `<p class="desc">${esc(t('val.read'))}</p>`;
  } else html += `<p class="desc">${esc(t('val.none'))}</p>`;
  if (runs.length > 1) {
    html += `<h4>${esc(t('val.history', { n: runs.length }))}</h4><table class="val-table small"><thead><tr><th>${esc(t('val.col.when'))}</th><th>${esc(t('val.src.picture'))}</th><th>${esc(t('val.src.camera'))}</th><th>${esc(t('val.src.paper'))}</th><th>${esc(t('val.src.chart'))}</th></tr></thead><tbody>`;
    for (const r of runs.slice(-8).reverse()) {
      const c = (k) => (r.summary[k] ? r.summary[k].median.toFixed(1) : '—');
      html += `<tr><td>${esc(r.at.slice(5, 16).replace('T', ' '))}</td><td>${c('picture')}</td><td>${c('camera')}</td><td>${c('paper')}</td><td>${c('chart')}</td></tr>`;
    }
    html += '</tbody></table>';
  }
  $('valBody').innerHTML = html;
  $('btnValExport').disabled = !runs.length;
  $('valSheet').hidden = false;
}

function exportValidation() {
  const runs = loadRuns();
  if (!runs.length) return;
  const blob = new Blob([JSON.stringify({ app: 'Color Vision Helper', version: APP_VERSION, exported: new Date().toISOString(), note: t('val.exportNote'), runs }, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `cvh-validation-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
let valClearArmed = 0;
function clearValidation() {
  const btn = $('btnValClear');
  if (performance.now() - valClearArmed > 4000) { valClearArmed = performance.now(); btn.textContent = t('val.clearConfirm'); return; }
  try { localStorage.removeItem(VAL_KEY); } catch { /* ignore */ }
  btn.textContent = t('val.clear');
  openValidation();
}

// ---------------- true colour on the GPU: the whole picture, for Correct mode (and preview) ----------------
function gpuParamsNow() {
  const ch = activeChart();
  if (ch) return gpuParams('chart', { fit: ch.fit });
  const st = R.tc.stats;
  if (!st) return null;
  const calib = calibNow();
  if ((S.tc.src === 'auto' || S.tc.src === 'paper' || S.tc.src === 'torch') && paperUsable(st)) {
    return gpuParams('paper', { paper: st.paper.rgb, mean: st.mean, rho: S.tc.rho, ...calib });
  }
  return gpuParams('camera', { gains: wbGains(), mean: st.mean, anchor: R.tc.anchor, anchorRho: R.tc.anchorRho, ...calib });
}
function updateGpuTC() {
  if (!R.glOk || !R.renderer) return;
  const active = tcOn() && !!R.source && (S.mode === 'correct' || S.tc.preview);
  let P = active ? gpuParamsNow() : null;
  const prev = R.tc.gpu;
  // smooth the exposure-like gain so the picture does not pump from frame to frame
  if (P && prev && !!P.luts === !!prev.luts && P.luts === prev.luts) {
    P = { ...P, gain: P.gain.map((v, k) => Math.exp(Math.log(prev.gain[k]) + 0.3 * (Math.log(v) - Math.log(prev.gain[k])))) };
  }
  R.tc.gpu = P;
  R.renderer.setTrueColor(P);
  if (S.mode === 'correct') syncGuide();
}

// ---------------- main loop ----------------
function frame(now) {
  if (R.source && !R.glLost) {
    try { render(); } catch (e) { console.error(e); }
    // live video: analyse ~14×/s; still images only when something changed
    if (R.dirty || (R.kind === 'camera' && now - R.lastAnalysis > 70)) {
      R.lastAnalysis = now; R.dirty = false;
      try { analyze(); } catch (e) { console.error(e); }
    }
  }
  requestAnimationFrame(frame);
}

function watchVideoFrames() {
  if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) return;
  const cb = () => { if (R.kind === 'camera') R.newFrame = true; video.requestVideoFrameCallback(cb); };
  video.requestVideoFrameCallback(cb);
}

// ---------------- sources ----------------
async function startCamera(opts = {}) {
  const startedAt = performance.now();
  const errEl = $('startError');
  errEl.hidden = true;
  // the camera that was running, to go back to if the one the user picked cannot be opened
  const prev = R.kind === 'camera' && camera.deviceId ? { deviceId: camera.deviceId, facing: camera.facing } : null;
  try {
    const want = { deviceId: opts.deviceId !== undefined ? opts.deviceId : S.camId, facing: opts.facing || S.camFacing, strict: !!opts.strict };
    await camera.start(want);
    if (R.kind === 'photo' && R.photoAt > startedAt) { camera.stop(); return false; }
    R.source = video; R.kind = 'camera'; R.newFrame = true; R.smooth = null; R.shownKey = null; R.zoom = 1;
    if (R.camFail) delete R.camFail[camera.deviceId];
    S.camId = camera.deviceId; S.camFacing = camera.facing; save();
    $('start').hidden = true;
    if (S.wbMode === 'manual' && S.wbLocked) camera.lockWB();
    layout();
    updateToolbar(); updateZoomChips();
    requestWakeLock();
    if (!S.tipsShown) { S.tipsShown = true; save(); setTimeout(() => toast(t('hint.first'), 4500), 800); }
    // first run: if the browser opened a telephoto / ultra-wide by default, use the main camera
    if (!S.autoMainDone) {
      S.autoMainDone = true; save();
      const main = await camera.preferredMain();
      if (main) {
        const from = t(lensKeyOf(camera.label));
        if (await startCamera({ deviceId: main })) toast(t('cam.switchedMain', { from }));
      }
    }
    return true;
  } catch (err) {
    if (err.name === 'SupersededError') return false; // replaced by a newer request
    console.warn(err);
    if (opts.strict) {
      // keep the user informed and go back to the camera that worked
      (R.camFail ||= {})[opts.deviceId] = err.name;
      toast(t('cam.openFail', { name: opts.name || '', why: t(camWhyKey(err)) }), 5000);
      if (prev && prev.deviceId !== opts.deviceId) await startCamera({ deviceId: prev.deviceId, facing: prev.facing });
      return false;
    }
    const key = cameraErrorKey(err);
    R.lastErr = { key, msg: err.message || err.name };
    errEl.textContent = t(key, { msg: R.lastErr.msg });
    errEl.hidden = false;
    if (R.kind === 'none') $('start').hidden = false;
    else toast(errEl.textContent);
    return false;
  }
}

/**
 * Freeze the picture. In the true-colour scene the frozen picture is the average of up to 8 frames,
 * which lowers the sensor noise (the main reason dim colours turn grey and patches look grainy);
 * frames that moved (the hand shook) are left out.
 */
async function freeze() {
  if (R.kind !== 'camera' || R.freezing) return;
  const [w, h] = sourceSize();
  if (!w) return;
  const c = R.frozenCanvas || (R.frozenCanvas = document.createElement('canvas'));
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, w, h);
  let info = { frames: 1, dropped: 0 };
  if (tcOn()) {
    R.freezing = true; syncTCBar();
    try { info = await averageFrames(ctx, w, h); } catch (e) { console.warn('frame averaging failed', e); } finally { R.freezing = false; }
    if (R.kind !== 'camera') { syncTCBar(); return; } // switched away meanwhile
  }
  R.tc.freezeInfo = info; R.tc.detectDone = false; R.tc.liveChart = null;
  R.source = c; R.kind = 'frozen'; R.newFrame = true; R.smooth = null; R.shownKey = null; requestAnalysis();
  updateToolbar(); updateZoomChips(); syncTCBar(); syncGuide();
}

/** Average the next frames into ctx (which holds the first one). Returns {frames, dropped}. */
async function averageFrames(ctx, w, h, n = 8) {
  const base = ctx.getImageData(0, 0, w, h);
  const bd = base.data, N = w * h;
  const sum = new Uint32Array(N * 3);
  for (let i = 0; i < N; i++) { sum[i * 3] = bd[i * 4]; sum[i * 3 + 1] = bd[i * 4 + 1]; sum[i * 3 + 2] = bd[i * 4 + 2]; }
  // motion check on 8 × 8 block means (block means are nearly free of noise, so any change is movement)
  const B = 8, bw = Math.floor(w / B), bh = Math.floor(h / B);
  const blocks = (d) => {
    const out = new Float32Array(bw * bh);
    for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
      let s = 0;
      for (let y = by * B; y < by * B + B; y += 2) for (let x = bx * B; x < bx * B + B; x += 2) { const p = (y * w + x) * 4; s += d[p] + 2 * d[p + 1] + d[p + 2]; }
      out[by * bw + bx] = s / 64;
    }
    return out;
  };
  const ref = blocks(bd);
  const tmp = document.createElement('canvas'); tmp.width = w; tmp.height = h;
  const tctx = tmp.getContext('2d', { willReadFrequently: true });
  let frames = 1, dropped = 0;
  for (let k = 1; k < n; k++) {
    await nextVideoFrame();
    if (R.kind !== 'camera') break;
    tctx.drawImage(video, 0, 0, w, h);
    const d = tctx.getImageData(0, 0, w, h).data;
    const bl = blocks(d);
    let diff = 0;
    for (let i = 0; i < bl.length; i++) diff += Math.abs(bl[i] - ref[i]);
    if (diff / bl.length > 3) { dropped++; continue; }
    for (let i = 0; i < N; i++) { sum[i * 3] += d[i * 4]; sum[i * 3 + 1] += d[i * 4 + 1]; sum[i * 3 + 2] += d[i * 4 + 2]; }
    frames++;
  }
  if (frames > 1) {
    for (let i = 0; i < N; i++) { bd[i * 4] = Math.round(sum[i * 3] / frames); bd[i * 4 + 1] = Math.round(sum[i * 3 + 1] / frames); bd[i * 4 + 2] = Math.round(sum[i * 3 + 2] / frames); }
    ctx.putImageData(base, 0, 0);
  }
  return { frames, dropped };
}

function resumeLive() {
  R.tc.chart = null; R.tc.pick = null; R.tc.freezeInfo = null; R.tc.pendingValidate = false; // a chart fit belongs to the frozen frame
  if (camera.live) {
    R.source = video; R.kind = 'camera'; R.newFrame = true; R.smooth = null; R.shownKey = null;
    video.play().catch(() => {});
    updateToolbar(); updateZoomChips(); layout(); syncTCBar();
  } else startCamera();
}

async function loadPhoto(file) {
  if (!file) return;
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    const long = 1600, s = Math.min(1, long / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    camera.cancelPending();
    camera.stop();
    R.photoAt = performance.now();
    R.source = c; R.kind = 'photo'; R.newFrame = true; R.zoom = 1; R.smooth = null; R.shownKey = null;
    clearTCHold(); R.tc.stats = null; R.tc.anchors = []; R.tc.liveChart = null; R.tc.detectDone = false; R.tc.freezeInfo = null;
    $('start').hidden = true;
    layout(); requestAnalysis();
    updateToolbar(); updateZoomChips(); syncGuide();
    // a photo can be of a real object (true colour applies, without torch or lens calibration) or of
    // a screen / a screenshot (its pixels are the colours): ask in the true-colour scene
    if (tcOn()) $('photoAsk').hidden = false;
    else toast(t('toast.photo'));
  } catch (e) {
    console.error(e);
    toast(t('toast.photoFail'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function requestWakeLock() {
  try { if ('wakeLock' in navigator && !R.wakeLock) { R.wakeLock = await navigator.wakeLock.request('screen'); R.wakeLock.addEventListener('release', () => { R.wakeLock = null; }); } } catch { /* ignore */ }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    // release the camera whenever we are not visible (also while showing a frozen frame)
    R.wasLive = R.kind === 'camera';
    if (camera.active) camera.stop();
  } else if (R.wasLive) {
    R.wasLive = false;
    startCamera();
  }
});
// the track can end on its own (another app took the camera, phone call, OS interruption)
camera.onEnded = () => { if (R.kind === 'camera' && !document.hidden) startCamera(); };
// iOS may leave the <video> paused after an interruption
video.addEventListener('pause', () => { if (R.kind === 'camera' && !document.hidden && camera.live) video.play().catch(() => {}); });
video.addEventListener('resize', () => layout()); // stream size changes (rotation, camera switch)

// ---------------- camera sheet ----------------
const LENS_KEY = { main: 'cam.main', ultra: 'cam.ultra', tele: 'cam.tele', macro: 'cam.macro', depth: 'cam.depth', ir: 'cam.ir', multi: 'cam.multi' };
function lensKeyOf(label) {
  if (guessFacing(label) === 'user') return 'cam.front';
  return LENS_KEY[lensKind(label)];
}

/** Human names: iOS labels name the lens ("Back Ultra Wide Camera"); Android's are generic ("camera2 2, facing back"). */
function friendlyNames(cams) {
  const counters = { user: 0, environment: 0, other: 0 };
  return cams.map((c) => {
    const lbl = c.label.trim();
    const kind = lensKind(lbl);
    const plain = /^(back|front|rear) camera$|^(后置|前置|後置)(相机|相機|摄像头)$/i.test(lbl);
    const named = kind !== 'main' || plain;
    const f = c.facing || 'other';
    const n = ++counters[f];
    if (!lbl) return t('cam.unknownN', { n: c.index + 1 });
    if (f === 'user') return named ? t('cam.front') : t('cam.frontN', { n });
    if (f === 'environment') return named ? t(LENS_KEY[kind]) : t('cam.rearN', { n });
    return t('cam.unknownN', { n: c.index + 1 });
  });
}

async function openCamSheet() {
  $('camSheet').hidden = false;
  syncFrameUI();
  const list = $('camList');
  const cams = await camera.list();
  const names = friendlyNames(cams);
  list.innerHTML = '';
  if (!cams.length || cams.every((c) => !c.label)) {
    const p = document.createElement('p'); p.className = 'desc'; p.textContent = t('cam.noLabels'); list.appendChild(p);
  }
  // rear cameras first
  const order = cams.map((c, i) => i).sort((a, b) => (cams[a].facing === 'user') - (cams[b].facing === 'user'));
  for (const i of order) {
    const c = cams[i];
    const b = document.createElement('button');
    b.className = 'cam-item';
    const cur = R.kind === 'camera' && c.deviceId && c.deviceId === camera.deviceId;
    b.setAttribute('aria-pressed', String(cur));
    b.innerHTML = `<span class="cam-name">${esc(names[i])}${cur ? ` <em>${esc(t('cam.current'))}</em>` : ''}</span><small>${esc(c.label || c.deviceId.slice(0, 8))}</small>`;
    const why = R.camFail && R.camFail[c.deviceId];
    if (why && !cur) {
      b.classList.add('failed');
      b.insertAdjacentHTML('beforeend', `<small class="cam-fail">${esc(t('cam.failedTag'))}</small>`);
    }
    b.addEventListener('click', async () => {
      if (cur) return;
      list.querySelectorAll('.cam-item').forEach((x) => { x.disabled = true; });
      b.classList.add('busy');
      b.querySelector('.cam-name').insertAdjacentHTML('beforeend', ` <em>${esc(t('cam.opening'))}</em>`);
      const ok = await startCamera({ deviceId: c.deviceId, facing: c.facing || undefined, strict: true, name: names[i] });
      if (ok) { S.camId = camera.deviceId; save(); }
      openCamSheet();
    });
    list.appendChild(b);
  }
  const z = camera.zoomRange, vw = video.videoWidth, vh = video.videoHeight;
  const ar = frameAspect(vw, vh);
  const arText = ar < 1.05 ? '1:1' : Math.abs(ar - 4 / 3) < 0.05 ? (vw < vh ? '3:4' : '4:3') : Math.abs(ar - 16 / 9) < 0.06 ? (vw < vh ? '9:16' : '16:9') : ar.toFixed(2);
  $('camInfo').textContent = R.kind === 'camera' && vw
    ? t('cam.info', { res: `${vw}×${vh}`, ar: arText, zoom: z ? t('cam.zoomInfo', { min: +z.min.toFixed(1), max: +z.max.toFixed(1) }) : '' })
      + (camera.fullSensor === false ? ' ' + t('cam.cropped') : '')
    : '';
  // what this browser lets a web page do with the camera
  const limited = R.kind === 'camera' && !z && !camera.torchSupported;
  $('camLimits').hidden = !limited;
  if (limited) $('camLimits').textContent = t('cam.limited');
}

/** Short reason for a camera that would not open. */
function camWhyKey(err) {
  switch (err && err.name) {
    case 'NotReadableError': case 'AbortError': return 'cam.why.blocked';
    case 'NotFoundError': case 'OverconstrainedError': return 'cam.why.gone';
    case 'WrongCameraError': return 'cam.why.wrong';
    case 'NotAllowedError': return 'err.denied';
    default: return 'cam.why.other';
  }
}

function syncFrameUI() {
  document.querySelectorAll('#frameSeg button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.frame === S.frame)));
}

// ---------------- zoom ----------------
function zoomLevels() {
  if (R.kind !== 'camera') return [];
  const z = camera.zoomRange;
  if (!z) return [1, 2, 4];
  const out = [];
  if (z.min < 0.95) out.push(+z.min.toFixed(1));
  if (z.min <= 1 && z.max >= 1) out.push(1);
  for (const v of [2, 3, 5, 10]) if (v <= z.max && out.length < 4) out.push(v);
  return out;
}
function currentZoom() { return hwZoomActive() ? camera.zoom : R.zoom; }

function updateZoomChips() {
  const box = $('zoomChips');
  const levels = zoomLevels();
  const show = levels.length > 1 && (wbOpen() || !(S.mode === 'correct' && !S.cpCollapsed));
  box.hidden = !show;
  if (!show) return;
  const cur = currentZoom();
  const nearest = levels.reduce((a, b) => (Math.abs(b - cur) < Math.abs(a - cur) ? b : a), levels[0]);
  box.innerHTML = levels.map((v) => `<button data-z="${v}" class="${v === nearest && Math.abs(v - cur) < 0.15 ? 'on' : ''}">${v}×</button>`).join('');
  placeFloating();
}

let zoomBusy = false, zoomWant = null;
async function setZoom(v) {
  if (hwZoomActive()) {
    zoomWant = v;
    if (zoomBusy) return;
    zoomBusy = true;
    while (zoomWant !== null) { const w = zoomWant; zoomWant = null; await camera.setZoom(w); }
    zoomBusy = false;
  } else {
    R.zoom = Math.max(1, Math.min(5, v));
  }
  showHud(`${(+currentZoom()).toFixed(1)}×`);
  updateZoomChips();
  requestAnalysis();
}

let hudTimer = 0;
function showHud(text, ms = text.length > 8 ? 2200 : 1100) {
  const h = $('hud');
  h.textContent = text; h.hidden = false;
  clearTimeout(hudTimer);
  hudTimer = setTimeout(() => { h.hidden = true; }, ms);
}

// ---------------- region range control ----------------
// The slider is non-linear (geometric): the lower half covers tolerance 0.1–0.224, the upper half
// 0.224–2.0, and the default (middle) is 0.224.
const posToSens = rangeToSens, sensToPos = sensToRange; // mapping lives in segment.js (unit-tested)
function setRangePos(p, hud = true) {
  S.segPos = Math.max(0, Math.min(1, p));
  save();
  $('rangeKnob').style.bottom = `calc(${(S.segPos * 100).toFixed(1)}% - 8px)`;
  $('rangeFill').style.height = `${(S.segPos * 100).toFixed(1)}%`;
  $('rangeTrack').setAttribute('aria-valuenow', String(Math.round(S.segPos * 100)));
  if (hud) showHud(t('range.hud.' + rangeLevel(S.segPos)));
  requestAnalysis();
}
/** Words for the slider position, so the HUD says what it does rather than a percentage. */
function rangeLevel(p) {
  if (p < 0.25) return 'xs';
  if (p < 0.42) return 's';
  if (p <= 0.58) return 'm';
  if (p <= 0.78) return 'l';
  return 'xl';
}
/** For tests: set the tolerance multiplier directly. */
function setSens(v) { setRangePos(sensToPos(v), false); }

/** Position the range slider (right edge) and zoom chips (left edge) on the visible part of the
 *  picture, i.e. above the colour card / panel that may overlay its lower edge. */
function placeFloating() {
  const rc = R.rect;
  // top of the bottom stack (colour card, white-balance popover or correction panel)
  const stack = [...document.querySelectorAll('.bottom > *')].filter((el) => el.offsetParent);
  const stackTop = stack.length ? stack[0].getBoundingClientRect().top : R.H - 80;
  const visTop = Math.max(rc.y, document.querySelector('.topbar').getBoundingClientRect().bottom);
  const visBottom = Math.max(visTop + 120, Math.min(rc.y + rc.h, stackTop - 6));
  const mid = (visTop + visBottom) / 2;
  const rng = $('rangeCtl');
  rng.hidden = !(R.source && idVisible() && (S.outline || S.dim));
  rng.style.top = `${mid}px`;
  rng.style.right = `${Math.max(6, R.W - (rc.x + rc.w) + 6)}px`;
  const chips = $('zoomChips');
  chips.style.top = `${mid}px`;
  chips.style.left = `${Math.max(6, rc.x + 6)}px`;
  $('hud').style.top = `${visTop + 12}px`;
}

// ---------------- UI wiring ----------------
function setIcon(btn, id, labelKey) {
  btn.querySelector('use').setAttribute('href', '#' + id);
  const span = btn.querySelector('span');
  span.dataset.i18n = labelKey;
  span.textContent = t(labelKey);
}

function updateToolbar() {
  const bF = $('btnFreeze');
  if (R.kind === 'photo') setIcon(bF, 'i-camera', 'tool.camera');
  else if (R.kind === 'frozen') setIcon(bF, 'i-play', 'tool.resume');
  else setIcon(bF, 'i-pause', 'tool.freeze');
  bF.classList.toggle('on', R.kind === 'frozen');
  const torch = $('btnTorch');
  torch.disabled = !(R.kind === 'camera' && camera.torchSupported);
  torch.classList.toggle('on', camera.torchOn && !torch.disabled);
  $('wbBadge').textContent = tcOn() ? t('wb.badge.tc') : t('wb.badge.' + S.wbMode);
  $('btnWBTool').classList.toggle('on', !$('wbPop').hidden);
}

function setMode(mode) {
  if (mode === 'correct' && !R.glOk) { toast(t('err.webgl')); mode = 'identify'; }
  S.mode = mode; save();
  app.classList.toggle('mode-correct', mode === 'correct');
  app.classList.toggle('mode-identify', mode === 'identify');
  $('modeIdentify').setAttribute('aria-selected', String(mode === 'identify'));
  $('modeCorrect').setAttribute('aria-selected', String(mode === 'correct'));
  applyCorrection();
  syncTCBar(); updateGpuTC(); syncGuide();
  requestAnimationFrame(() => { layout(); updateZoomChips(); });
  requestAnalysis();
}

function sevLabelKey(v) {
  if (v >= 95) return 'sev.dichromat';
  if (v >= 70) return 'sev.strong';
  if (v >= 35) return 'sev.moderate';
  return 'sev.mild';
}

function syncCorrectUI() {
  const c = S.cvd;
  document.querySelectorAll('#typeSeg button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.type === c.type)));
  document.querySelectorAll('#methodChips button').forEach((b) => b.classList.toggle('on', b.dataset.method === c.method));
  $('severity').value = c.severity;
  $('sevOut').textContent = `${c.severity}% · ${t(sevLabelKey(c.severity))}`;
  const resolved = resolveMethod(c.method, c.severity / 100, c.type);
  // pure compensation is a blend (max 100 %); the re-encoding methods can be pushed further,
  // Strong up to 200 % (for reading colour-plate figures)
  const strMax = resolved === 'compensate' ? 100 : resolved === 'enhance' ? 200 : 150;
  $('strength').max = strMax;
  $('strength').value = Math.min(c.strength, strMax);
  $('strOut').textContent = `${Math.min(c.strength, strMax)}%`;
  $('methodDesc').textContent = c.method === 'auto'
    ? t('m.desc.auto', { m: t('m.' + resolved) }) : t('m.desc.' + c.method);
  $('optSplit').checked = S.split; $('optPreview').checked = S.preview;
  $('cpSummary').textContent = `${t('cvd.' + c.type)} · ${c.severity}% · ${t('m.' + resolved)}`;
  $('correctPanel').classList.toggle('collapsed', S.cpCollapsed);
  $('cpToggle').setAttribute('aria-expanded', String(!S.cpCollapsed));
  $('strength').disabled = resolved === 'simulate';
  $('btnTest').classList.toggle('attn', !c.tuned);
}

function syncSettingsUI() {
  document.querySelectorAll('#setSeg button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.set === S.set)));
  $('appVersion').textContent = 'v' + APP_VERSION;
  document.querySelectorAll('#retStyle button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.ret === S.reticle)));
  document.querySelectorAll('#retSize button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.size === S.retSize)));
  $('optBilingual').checked = S.bilingual; $('optOutline').checked = S.outline; $('optDim').checked = S.dim;
  $('optValues').checked = S.values; $('optAutoSpeak').checked = S.autoSpeak;
  document.querySelectorAll('#textSizeSeg button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.size === S.textSize)));
}

function syncWBUI() {
  document.querySelectorAll('#wbSeg button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.wb === S.wbMode)));
  let desc = t('wb.desc.' + S.wbMode);
  if (S.wbMode === 'auto' && R.autoCast) desc = t('cast.' + R.autoCast) + (getLang() === 'zh' ? '。' : '. ') + desc;
  if (S.wbMode === 'manual' && S.wbCalibrated) desc = t('wb.desc.manualDone', { lock: S.wbLocked ? t('wb.locked') : '' });
  $('wbDesc').textContent = desc;
  // before the first white-card calibration the hint sits on the picture next to the target
  $('wbDesc').hidden = S.wbMode === 'manual' && !S.wbCalibrated;
  $('btnWBCal').hidden = S.wbMode !== 'manual';
  app.classList.toggle('wb-manual', S.wbMode === 'manual' && !tcOn());
  syncSceneUI();
  syncTCUI();
  updateToolbar();
}

async function setWBMode(mode) {
  if (S.wbMode === 'manual' && mode !== 'manual') { await camera.unlockWB(); S.wbLocked = false; }
  S.wbMode = mode;
  if (mode === 'auto') { R.wbSeen = 0; }
  save();
  applyWB(); syncWBUI();
  R.smooth = null; R.shownKey = null; requestAnalysis();
}

function setLanguage(lang) {
  S.lang = lang; save();
  setLang(lang);
  applyI18n();
  buildReticlePicker();
  syncCorrectUI(); syncSettingsUI(); syncWBUI(); syncTCBar(); updateToolbar(); updateCard(); syncGuide();
  if (!$('valSheet').hidden) openValidation();
  if (!R.lastNaming) $('colorName').textContent = t('card.waiting');
  if (R.lastErr && !$('startError').hidden) $('startError').textContent = t(R.lastErr.key, { msg: R.lastErr.msg });
  if (!$('camSheet').hidden) openCamSheet();
}

let toastTimer = 0;
function toast(msg, ms = 2600) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function renderReticle() {
  $('retShape').innerHTML = reticleSVG(S.reticle, S.retSize);
}
function buildReticlePicker() {
  const box = $('retStyle');
  box.innerHTML = RETICLE_STYLES.map((st) => `<button data-ret="${st}">${reticleSVG(st, 'm')}<span>${esc(t('ret.' + st))}</span></button>`).join('');
  box.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { S.reticle = b.dataset.ret; save(); renderReticle(); syncSettingsUI(); }));
}

function placeReticle() {
  const r = $('reticle'), rc = R.rect;
  r.style.left = `${rc.x + R.reticle.x * rc.w}px`;
  r.style.top = `${rc.y + R.reticle.y * rc.h}px`;
  $('btnRecenter').hidden = Math.abs(R.reticle.x - 0.5) < 0.01 && Math.abs(R.reticle.y - 0.5) < 0.01;
}
function setReticle(x, y) {
  R.reticle.x = Math.max(0.02, Math.min(0.98, x));
  R.reticle.y = Math.max(0.02, Math.min(0.98, y));
  R.retVer++;
  R.smooth = null; R.shownKey = null;
  placeReticle();
  if (R.tc.held) syncTCBar(); // a torch result belongs to the point it was measured at
  requestAnalysis();
}

async function calibrateWB() {
  if (!R.source) return;
  const btn = $('btnWBCal');
  btn.disabled = true;
  btn.querySelector('span').textContent = t('wb.calibrating');
  let locked = false;
  try {
    if (R.kind === 'camera' && camera.wbLockSupported) {
      await camera.unlockWB();
      locked = await camera.lockWB();
      if (locked) { await sleep(700); R.newFrame = true; await sleep(80); }
    }
    const c = crop();
    if (!c) return;
    const p = samplePatch(c, 30);
    const mx = Math.max(...p.raw), mn = Math.min(...p.raw);
    if (p.Y < 0.04 || p.clipped > 0.5 || (mx - mn) / mx > 0.45) {
      if (locked) await camera.unlockWB();
      toast(t('toast.wbBad'));
      return;
    }
    S.wb = gainsFromReference(p.raw);
    S.wbMode = 'manual'; S.wbLocked = locked; S.wbCalibrated = true; save();
    applyWB(); syncWBUI();
    R.smooth = null; R.shownKey = null; requestAnalysis();
    toast(t('toast.wbDone'));
    setWBOpen(false); // done: give the picture back to colour identification
  } finally {
    btn.disabled = false;
    btn.querySelector('span').textContent = t('wb.calibrate');
  }
}

function bind() {
  $('btnStart').addEventListener('click', () => startCamera());
  $('btnStartPhoto').addEventListener('click', () => $('fileInput').click());
  $('btnStartLang').addEventListener('click', () => setLanguage(getLang() === 'zh' ? 'en' : 'zh'));
  $('fileInput').addEventListener('change', (e) => { loadPhoto(e.target.files[0]); e.target.value = ''; });

  $('sceneReal').addEventListener('click', () => setScene('real'));
  $('sceneScreen').addEventListener('click', () => setScene('screen'));
  // hint strip, explanation sheet, buttons with data-act (strip and sheet)
  $('hintText').addEventListener('click', openInfo);
  $('hintClose').addEventListener('click', closeHint);
  $('btnInfoClose').addEventListener('click', closeInfo);
  $('infoSheet').addEventListener('click', (e) => { if (e.target.id === 'infoSheet') closeInfo(); });
  $('btnCpInfo').addEventListener('click', openInfo);
  // fade the bottom edge of the correction panel body while there is more to scroll to
  const cpBody = document.querySelector('#correctPanel .cp-body');
  const cpFade = () => cpBody.classList.toggle('more', cpBody.scrollHeight - cpBody.scrollTop - cpBody.clientHeight > 4);
  cpBody.addEventListener('scroll', cpFade, { passive: true });
  if (window.ResizeObserver) { const ro = new ResizeObserver(cpFade); ro.observe(cpBody); for (const c of cpBody.children) ro.observe(c); }
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('[data-act]');
    if (b && ACT[b.dataset.act]) { ACT[b.dataset.act](); return; }
    if (e.target.closest && e.target.closest('#colorStatus')) openInfo();
  });
  // display settings
  document.querySelectorAll('#textSizeSeg button').forEach((b) => b.addEventListener('click', () => setTextSize(b.dataset.size)));
  $('btnLangSet').addEventListener('click', () => setLanguage(getLang() === 'zh' ? 'en' : 'zh'));
  $('btnHintsReset').addEventListener('click', resetHints);
  $('photoReal').addEventListener('click', () => { $('photoAsk').hidden = true; R.tc.photoReal = true; toast(t('photo.realDone'), 3500); syncGuide(); requestAnalysis(); });
  $('photoScreen').addEventListener('click', () => { $('photoAsk').hidden = true; setScene('screen'); toast(t('photo.screenDone'), 3500); });
  $('btnValClose').addEventListener('click', () => { $('valSheet').hidden = true; });
  $('btnValExport').addEventListener('click', exportValidation);
  $('btnValClear').addEventListener('click', clearValidation);
  $('modeIdentify').addEventListener('click', () => setMode('identify'));
  $('modeCorrect').addEventListener('click', () => setMode('correct'));
  $('btnLang').addEventListener('click', () => setLanguage(getLang() === 'zh' ? 'en' : 'zh'));
  $('btnSettings').addEventListener('click', () => { syncSettingsUI(); $('settings').hidden = false; });
  $('btnSettingsClose').addEventListener('click', () => { $('settings').hidden = true; });
  $('settings').addEventListener('click', (e) => { if (e.target.id === 'settings') $('settings').hidden = true; });

  $('btnFreeze').addEventListener('click', () => {
    if (R.kind === 'camera') freeze();
    else resumeLive();
  });
  $('btnPhoto').addEventListener('click', () => $('fileInput').click());
  $('btnLens').addEventListener('click', () => openCamSheet());
  $('btnCamClose').addEventListener('click', () => { $('camSheet').hidden = true; });
  $('camSheet').addEventListener('click', (e) => { if (e.target.id === 'camSheet') $('camSheet').hidden = true; });
  document.querySelectorAll('#frameSeg button').forEach((b) => b.addEventListener('click', () => {
    S.frame = b.dataset.frame; save(); syncFrameUI(); layout();
  }));
  $('btnTorch').addEventListener('click', async () => { await camera.setTorch(!camera.torchOn); updateToolbar(); });
  $('btnSpeak').addEventListener('click', speakCurrent);
  $('btnRecenter').addEventListener('click', () => setReticle(0.5, 0.5));
  $('colorSub').addEventListener('click', (e) => {
    const hex = e.target.dataset && e.target.dataset.hex;
    if (hex && navigator.clipboard) navigator.clipboard.writeText(hex).then(() => toast(t('toast.copied', { x: hex })), () => {});
  });

  // white balance popover
  $('btnWBTool').addEventListener('click', () => setWBOpen(!wbOpen()));
  $('wbClose').addEventListener('click', () => setWBOpen(false));
  document.querySelectorAll('#wbSeg button').forEach((b) => b.addEventListener('click', () => setWBMode(b.dataset.wb)));
  $('btnWBCal').addEventListener('click', calibrateWB);
  // true colour
  $('optTcPreview').addEventListener('change', (e) => { S.tc.preview = e.target.checked; save(); updateGpuTC(); });
  $('optTcDefSat').addEventListener('change', (e) => { S.tc.defaultSat = e.target.checked; save(); R.smooth = null; syncTCStatus(); syncGuide(); requestAnalysis(); });
  $('btnValidate').addEventListener('click', () => { setWBOpen(false); startValidation(); });
  $('btnValidateLog').addEventListener('click', () => openValidation());
  document.querySelectorAll('#tcSrc button').forEach((b) => b.addEventListener('click', () => setTCSource(b.dataset.src)));
  document.querySelectorAll('#tcRho button').forEach((b) => b.addEventListener('click', () => { S.tc.rho = +b.dataset.rho; save(); syncTCUI(); R.smooth = null; requestAnalysis(); }));
  document.querySelectorAll('#tcChart button').forEach((b) => b.addEventListener('click', () => { S.tc.chart = b.dataset.chart; save(); syncTCUI(); }));
  $('btnTorchMeasure').addEventListener('click', () => { setWBOpen(false); measureTorch(); });
  $('btnTorchCal').addEventListener('click', () => { setWBOpen(false); calibrateTorch(); });
  $('btnPickChart').addEventListener('click', () => startChartPick('measure'));
  $('btnPickPaper').addEventListener('click', startPaperPick);
  $('btnTorchRecheck').addEventListener('click', () => { delete camCal().manual; save(); syncTCUI(); syncTCBar(); toast(t('tc.toast.recheck')); });
  $('btnTCReset').addEventListener('click', () => { delete S.tc.cams[camKey()]; save(); R.smooth = null; syncTCUI(); syncTCBar(); requestAnalysis(); toast(t('tc.toast.resetCal')); });
  $('btnPaperAuto').addEventListener('click', clearPaperAt);
  $('btnPrintCard').addEventListener('click', downloadPrintCard);
  $('btnPrintCal').addEventListener('click', () => startChartPick('printCal'));

  // zoom chips & range control
  $('zoomChips').addEventListener('click', (e) => { const z = e.target.dataset && e.target.dataset.z; if (z) setZoom(+z); });
  $('rangePlus').addEventListener('click', () => setRangePos(S.segPos + 0.06));
  $('rangeMinus').addEventListener('click', () => setRangePos(S.segPos - 0.06));
  const track = $('rangeTrack');
  const fromY = (e) => { const r = track.getBoundingClientRect(); setRangePos(1 - (e.clientY - r.top) / r.height); };
  track.addEventListener('pointerdown', (e) => { track.setPointerCapture(e.pointerId); track.dataset.drag = '1'; fromY(e); });
  track.addEventListener('pointermove', (e) => { if (track.dataset.drag) fromY(e); });
  const stop = () => { delete track.dataset.drag; };
  track.addEventListener('pointerup', stop); track.addEventListener('pointercancel', stop);

  const setSet = (v) => {
    if (v !== S.set) showHud(t('set.hud.' + v), 2600); // say what the switch does
    S.set = v; save(); R.shownKey = null; syncSettingsUI(); requestAnalysis();
  };
  document.querySelectorAll('#setSeg button').forEach((b) => b.addEventListener('click', () => setSet(b.dataset.set)));
  $('btnUpdate').addEventListener('click', checkUpdate);
  buildReticlePicker();
  document.querySelectorAll('#retSize button').forEach((b) => b.addEventListener('click', () => { S.retSize = b.dataset.size; save(); renderReticle(); syncSettingsUI(); }));
  $('btnReset').addEventListener('click', resetSettings);

  const bindToggle = (id, key, after) => $(id).addEventListener('change', (e) => { S[key] = e.target.checked; save(); if (after) after(); });
  bindToggle('optBilingual', 'bilingual', updateCard);
  bindToggle('optOutline', 'outline', () => { placeFloating(); requestAnalysis(); });
  bindToggle('optDim', 'dim', () => { placeFloating(); requestAnalysis(); });
  bindToggle('optValues', 'values', updateCard);
  bindToggle('optAutoSpeak', 'autoSpeak', () => {
    // iOS only allows speech after one utterance started inside a user gesture
    if (S.autoSpeak && 'speechSynthesis' in window) { try { speechSynthesis.speak(new SpeechSynthesisUtterance('')); } catch { /* ignore */ } }
  });

  // correction panel
  $('methodDesc').addEventListener('click', () => $('methodDesc').classList.toggle('open'));
  $('cpToggle').addEventListener('click', () => { S.cpCollapsed = !S.cpCollapsed; save(); syncCorrectUI(); updateZoomChips(); });
  document.querySelectorAll('#typeSeg button').forEach((b) => b.addEventListener('click', () => { S.cvd.type = b.dataset.type; save(); syncCorrectUI(); applyCorrection(); }));
  document.querySelectorAll('#methodChips button').forEach((b) => b.addEventListener('click', () => { S.cvd.method = b.dataset.method; save(); syncCorrectUI(); applyCorrection(); }));
  $('severity').addEventListener('input', (e) => { S.cvd.severity = +e.target.value; save(); syncCorrectUI(); applyCorrection(); });
  $('strength').addEventListener('input', (e) => { S.cvd.strength = +e.target.value; save(); syncCorrectUI(); applyCorrection(); });
  bindToggle('optSplit', 'split', applyCorrection);
  bindToggle('optPreview', 'preview', applyCorrection);

  // self-test
  const test = new SelfTest({
    root: $('test'), canvas: $('testCanvas'), t,
    onApply: ({ type, severity, method, strength }) => {
      S.cvd = { ...S.cvd, type, severity, method, strength, tuned: true }; save();
      syncCorrectUI(); applyCorrection(); $('test').hidden = true;
      if (S.mode !== 'correct') setMode('correct');
    },
  });
  $('btnTest').addEventListener('click', () => { $('test').hidden = false; test.reset(); });
  $('btnTestClose').addEventListener('click', () => { $('test').hidden = true; test.stop(); });

  bindGestures();
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 250));
  // top bar / toolbar size changes (language, safe areas): re-place the picture
  if ('ResizeObserver' in window) {
    let raf = 0;
    const ro = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(layout); });
    ro.observe(document.querySelector('.topbar')); ro.observe(document.querySelector('.toolbar'));
  }
}

// ---------------- gestures ----------------
// tap = move reticle, double-tap = recenter, vertical swipe = region range,
// pinch = zoom, drag near the divider = move the split
function bindGestures() {
  const pts = new Map();
  let tap = null, lastTap = 0, pinch = null, dragSplit = false, swipe = null;
  const isView = (e) => e.target === view || e.target === video || e.target === overlay || e.target === app || e.target.id === 'view';
  const inRect = (x, y) => { const r = R.rect; return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h; };
  app.addEventListener('pointerdown', (e) => {
    if (!isView(e) || !R.source) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { app.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    if (pts.size === 1) {
      const splitOn = S.mode === 'correct' && S.split;
      dragSplit = splitOn && Math.abs(e.clientX - (R.rect.x + R.split * R.rect.w)) < 32;
      tap = { x: e.clientX, y: e.clientY, t: performance.now() };
      swipe = { x: e.clientX, y: e.clientY, pos: S.segPos, on: false };
    } else if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z: currentZoom() };
      tap = null; dragSplit = false; swipe = null;
    }
  });
  app.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pts.size === 2 && R.kind !== 'photo') {
      const [a, b] = [...pts.values()];
      const z = pinch.z * Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, pinch.d);
      const zr = camera.zoomRange;
      setZoom(hwZoomActive() ? Math.max(zr.min, Math.min(zr.max, z)) : z);
    } else if (dragSplit) {
      R.split = Math.max(0.05, Math.min(0.95, (e.clientX - R.rect.x) / R.rect.w));
      applySplit();
    } else if (swipe && pts.size === 1) {
      const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y;
      if (!swipe.on && Math.abs(dy) > 18 && Math.abs(dy) > 1.5 * Math.abs(dx) && idVisible()) swipe.on = true;
      if (swipe.on) setRangePos(swipe.pos - dy / 420);
    }
    if (tap && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > 12) tap = null;
  });
  const end = (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (pts.size === 0) {
      if (tap && !dragSplit && performance.now() - tap.t < 400) {
        const now = performance.now();
        if (R.tc.paperPick && S.mode === 'identify') {
          if (inRect(tap.x, tap.y)) setPaperAt((tap.x - R.rect.x) / R.rect.w, (tap.y - R.rect.y) / R.rect.h);
          tap = null; return;
        }
        if (R.tc.pick && S.mode === 'identify') {
          // picking the corners of a colour chart
          if (inRect(tap.x, tap.y)) chartTap((tap.x - R.rect.x) / R.rect.w, (tap.y - R.rect.y) / R.rect.h);
          tap = null; return;
        }
        if (S.mode === 'correct' && !S.cpCollapsed && !wbOpen()) {
          // first tap on the picture just tucks the correction panel away
          S.cpCollapsed = true; save(); syncCorrectUI(); updateZoomChips(); tap = null; return;
        }
        if (wbOpen() && S.wbMode !== 'manual') setWBOpen(false);
        if (!idVisible() && !wbOpen()) { tap = null; return; } // Correct mode: no reticle (except to aim the white card)
        if (now - lastTap < 320) { setReticle(0.5, 0.5); lastTap = 0; }
        else if (inRect(tap.x, tap.y)) { setReticle((tap.x - R.rect.x) / R.rect.w, (tap.y - R.rect.y) / R.rect.h); lastTap = now; }
      }
      tap = null; dragSplit = false; swipe = null;
    }
  };
  app.addEventListener('pointerup', end);
  app.addEventListener('pointercancel', end);
  // keep the page from scrolling/zooming on touch devices
  document.addEventListener('gesturestart', (e) => e.preventDefault());
}

// ---------------- boot ----------------
async function boot() {
  applyTextSize();
  setLang(S.lang);
  applyI18n();
  renderReticle();
  initRenderer();
  if (!R.glOk) app.classList.add('no-gl');
  initWorker();
  resize();
  bind();
  syncCorrectUI();
  syncSettingsUI();
  syncWBUI();
  syncSceneUI();
  syncTCBar();
  syncGuide();
  setRangePos(S.segPos, false);
  setMode(S.mode);
  updateToolbar();
  watchVideoFrames();
  requestAnimationFrame(frame);

  // auto-start the camera if permission was granted before
  try {
    if (navigator.permissions && navigator.permissions.query) {
      const p = await navigator.permissions.query({ name: 'camera' });
      if (p.state === 'granted') startCamera();
    }
  } catch { /* not supported */ }

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

// ---------------- settings: update & reset ----------------
/** Ask the server for the deployed version; if it is newer, drop every cached copy and reload. */
async function checkUpdate() {
  const btn = $('btnUpdate');
  btn.disabled = true;
  try {
    const res = await fetch('sw.js?check=' + Date.now(), { cache: 'no-store' });
    const m = res.ok && (await res.text()).match(/cvh-v([\d.]+)/);
    const remote = m ? m[1] : null;
    if (!remote) throw new Error('no version');
    if (remote === APP_VERSION) { toast(t('settings.updateNone', { v: APP_VERSION })); return; }
    toast(t('settings.updateFound', { v: remote }), 4000);
    try {
      const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
      if (reg) await reg.update();
      if (window.caches) await Promise.all((await caches.keys()).map((k) => caches.delete(k)));
      // refresh the browser's HTTP cache too, then load the new version
      await Promise.all(APP_FILES.map((f) => fetch(f, { cache: 'reload' }).catch(() => {})));
    } catch { /* reload anyway */ }
    location.reload();
  } catch {
    toast(t('settings.updateFail'));
  } finally {
    btn.disabled = false;
  }
}
const APP_FILES = ['./', 'index.html', 'css/style.css', 'js/main.js', 'js/i18n.js', 'js/color.js', 'js/naming.js', 'js/cvd.js',
  'js/machado.js', 'js/segment.js', 'js/gl.js', 'js/camera.js', 'js/selftest.js', 'js/wb.js', 'js/analysis-worker.js', 'js/reticle.js',
  'js/truecolor.js', 'js/measure.js', 'js/chartdetect.js'];

let resetArmed = 0;
function resetSettings() {
  const btn = $('btnReset');
  if (performance.now() - resetArmed > 4000) {
    // first tap only arms the button, so a stray tap cannot wipe the tuning result
    resetArmed = performance.now();
    btn.textContent = t('settings.resetConfirm');
    btn.classList.add('armed');
    setTimeout(() => { if (performance.now() - resetArmed >= 3900) { btn.textContent = t('settings.reset'); btn.classList.remove('armed'); } }, 4000);
    return;
  }
  try { localStorage.removeItem(STORE_KEY); } catch { /* ignore */ }
  location.reload();
}

// expose a tiny hook for automated tests
window.__cvh = {
  S, R, analyze, setReticle, setMode, freeze, setLanguage, setSens, setWBMode, calibrateWB, camera, layout,
  setTC, setTCSource, startChartPick, chartTap, measureTorch, calibrateTorch, resumeLive, startPaperPick, setPaperAt,
  setScene, startValidation, openValidation, loadRuns, guideContent, updateGpuTC, trueEstimate,
};

boot();
