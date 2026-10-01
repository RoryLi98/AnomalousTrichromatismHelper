// Color Vision Helper — app controller.
import { t, setLang, getLang, applyI18n, detectLang } from './i18n.js';
import { LIN, linearToSrgb, rgbToHex, rgbToLab, deltaE2000 } from './color.js';
import { nameColor, BASIC } from './naming.js';
import { shaderParams, resolveMethod } from './cvd.js';
import { Segmenter } from './segment.js';
import { estimateWB, gainsFromReference, castOfGains } from './wb.js';
import { Renderer } from './gl.js';
import { Camera, cameraErrorKey, guessFacing, lensKind } from './camera.js';
import { SelfTest } from './selftest.js';

const $ = (id) => document.getElementById(id);
const app = $('app'), video = $('video'), overlay = $('overlay');
let view = $('view');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- settings (persisted per device) ----------------
const STORE_KEY = 'cvh.settings.v1';
const DEFAULTS = {
  lang: detectLang(), set: 'basic', bilingual: false, outline: true, dim: false,
  values: true, autoSpeak: false, mode: 'identify',
  wbMode: 'auto', wb: [1, 1, 1], wbLocked: false, wbCalibrated: false, // white balance: auto | manual | off
  segSens: 1,                                      // region range multiplier
  frame: 'fit',                                    // fit = whole camera frame, fill = crop to screen
  camId: null, camFacing: 'environment', autoMainDone: false, tipsShown: false,
  cvd: { type: 'deutan', severity: 60, method: 'auto', strength: 100 },
  split: false, preview: false, showId: true, cpCollapsed: false,
};
function loadSettings() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch { saved = null; }
  const s = JSON.parse(JSON.stringify(DEFAULTS));
  if (saved && typeof saved === 'object') {
    for (const k of Object.keys(s)) if (k in saved) s[k] = k === 'cvd' ? { ...s.cvd, ...saved.cvd } : saved[k];
    if (saved.wbOn && !('wbMode' in saved)) s.wbMode = 'manual'; // v1.0 setting
  }
  return s;
}
const S = loadSettings();
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
 * Decide where the picture goes. "fit": the whole camera frame, letterboxed into the space
 * between the top bar and the colour card. "fill": cover the whole screen (crops the frame).
 */
function layout() {
  const W = R.W, H = R.H;
  const [sw, sh] = sourceSize();
  let rect = { x: 0, y: 0, w: W, h: H };
  if (S.frame === 'fit' && sw && sh) {
    const top = document.querySelector('.topbar').getBoundingClientRect().bottom;
    // a fixed reserve above the toolbar for the colour card, so the picture does not jump
    // whenever the card text changes height
    const toolbarTop = document.querySelector('.toolbar').getBoundingClientRect().top;
    const reserve = !idVisible() ? 8 : S.mode === 'identify' ? CARD_RESERVE : CARD_RESERVE_COMPACT;
    const bottom = toolbarTop - reserve;
    let ay = top, ah = bottom - top;
    if (ah < H * 0.35) { ay = 0; ah = H; } // not enough room: use the whole screen
    const sa = sw / sh;
    let rw = W, rh = W / sa;
    if (rh > ah) { rh = ah; rw = ah * sa; }
    rect = { x: (W - rw) / 2, y: ay + (ah - rh) / 2, w: rw, h: rh };
  }
  const changed = ['x', 'y', 'w', 'h'].some((k) => Math.abs(rect[k] - R.rect[k]) > 0.5);
  R.rect = rect;
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

const CARD_RESERVE = 172, CARD_RESERVE_COMPACT = 120;

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
function samplePatch(c, cssSize = 18) {
  const mir = mirrored();
  const rx = mir ? 1 - R.reticle.x : R.reticle.x;
  const size = Math.max(4, cssSize * (c.w / R.rect.w));
  let cx = c.x + rx * c.w, cy = c.y + R.reticle.y * c.h;
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

function idVisible() { return !(S.mode === 'correct' && !S.showId); }

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
  R.patch = samplePatch(c);
  const wantRegion = idVisible();
  const wantWB = S.wbMode === 'auto';
  if ((wantRegion || wantWB) && !(R.busy && performance.now() - R.busySince < 1500)) {
    const img = readAnalysisFrame(c);
    const buf = new Uint8Array(img.data); // copy: the read-back buffer is reused
    const msg = {
      id: ++R.reqId, buf, w: img.width, h: img.height,
      segment: wantRegion, wb: wantWB,
      sx: R.reticle.x * img.width - 0.5, sy: R.reticle.y * img.height - 0.5,
      sens: S.segSens, gains: wbGains(), temporal: R.kind === 'camera', wantAlpha: S.dim,
    };
    R.reqMeta = { id: msg.id, retVer: R.retVer, w: img.width, h: img.height };
    if (R.worker) {
      R.busy = true; R.busySince = performance.now();
      R.worker.postMessage(msg, [buf.buffer]);
    } else {
      onRegionResult(runLocal(msg));
    }
  }
  if (!wantRegion) { R.lastRes = null; drawOverlay(); }
  updateNaming();
}

function runLocal(m) {
  const out = { id: m.id, w: m.w, h: m.h, wb: null, res: null };
  let soft = null;
  if (m.segment) {
    const r = localSeg.run({ width: m.w, height: m.h, data: m.buf }, m.sx, m.sy, { sens: m.sens, gains: m.gains, temporal: m.temporal });
    soft = r.soft;
    out.res = { area: r.area, bbox: r.bbox, segCount: r.segCount, segs: r.segments.slice(0, r.segCount * 4), color: r.color, tol: r.tol, w: r.w, h: r.h };
    if (m.wantAlpha) { const a = new Uint8ClampedArray(soft.length); for (let i = 0; i < soft.length; i++) a[i] = soft[i] * 255; out.res.alpha = a; }
  }
  if (m.wb) out.wb = estimateWB(m.buf, m.w, m.h, soft);
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
    R.autoCast = castOfGains(R.autoWB);
    applyWB();
  }
  if (!meta || out.id !== meta.id) return;
  if (meta.retVer !== R.retVer || out.w !== aCanvas.width || out.h !== aCanvas.height) { requestAnalysis(); return; }
  if (out.res) R.lastRes = out.res;
  R.resCount = (R.resCount || 0) + 1;
  drawOverlay();
  updateNaming();
}

function pickColor() {
  const p = R.patch;
  if (!p) return null;
  const rc = R.lastRes && R.lastRes.color;
  if (rc && rc.pixels >= 120 && R.lastRes.area < 0.97) {
    const toRgb = (lin) => lin.map((v) => Math.round(linearToSrgb(v) * 255));
    const dE = deltaE2000(rgbToLab(...toRgb(p.lin)), rgbToLab(...rc.rgb));
    if (dE < 22 || p.clipped > 0.3) return { lin: rc.lin, src: 'region' };
  }
  return { lin: p.lin, src: 'point' };
}

function updateNaming() {
  const pick = pickColor();
  if (!pick) return;
  const live = R.kind === 'camera';
  if (!R.smooth || !live || pick.src !== R.colorSrc) R.smooth = pick.lin;
  else {
    const diff = Math.abs(pick.lin[0] - R.smooth[0]) + Math.abs(pick.lin[1] - R.smooth[1]) + Math.abs(pick.lin[2] - R.smooth[2]);
    const a = diff > 0.12 ? 0.75 : 0.35;
    R.smooth = R.smooth.map((v, k) => v + (pick.lin[k] - v) * a);
  }
  R.colorSrc = pick.src;
  const rgb = R.smooth.map((v) => Math.round(linearToSrgb(v) * 255));
  const naming = nameColor(rgb[0], rgb[1], rgb[2]);
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
  if (S.set === 'basic') {
    return { name: naming.basic[lang], alt: S.bilingual ? naming.basic[other] : '', speak: naming.basic[lang] };
  }
  const d = naming.detailed;
  const approx = naming.dE > 12 ? '≈ ' : '';
  const fam = t('card.family', { x: BASIC[naming.basicKey][lang].replace(/色$/, '') });
  const parts = [];
  if (S.bilingual) parts.push(d[other]);
  parts.push(naming.desc[lang], fam);
  return { name: approx + d[lang], alt: parts.join(' · '), speak: `${d[lang]}，${naming.desc[lang]}` };
}

const WARN_SVG = '<svg class="ic ic-s"><use href="#i-warn"/></svg>';
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
  // status: exposure warnings first, then "may also be called", then the light colour
  const st = [];
  const p = R.patch;
  if (p && p.clipped > 0.35) st.push(WARN_SVG + esc(t('warn.over')));
  else if (p && p.Y < 0.012) st.push(WARN_SVG + esc(t('warn.dark')));
  if (naming.alt) st.push(esc(t('card.maybe', { x: naming.alt[lang] })));
  if (S.wbMode === 'auto' && R.autoCast && st.length < 2) st.push(esc(t('cast.' + R.autoCast)));
  $('colorStatus').innerHTML = st.join(' · ');
  const sub = [];
  if (S.values) sub.push(`<span class="hex" data-hex="${hex}">${hex}</span> · RGB ${rgb.join(', ')}`);
  const area = R.lastRes && R.lastRes.area > 0 ? t('card.area', { p: Math.max(1, Math.round(R.lastRes.area * 100)) }) : '';
  sub.push([area, t(R.colorSrc === 'region' ? 'card.fromRegion' : 'card.fromPoint')].filter(Boolean).join(' · '));
  $('colorSub').innerHTML = sub.join('<br>');
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
  try {
    const want = { deviceId: opts.deviceId !== undefined ? opts.deviceId : S.camId, facing: opts.facing || S.camFacing };
    await camera.start(want);
    if (R.kind === 'photo' && R.photoAt > startedAt) { camera.stop(); return false; }
    R.source = video; R.kind = 'camera'; R.newFrame = true; R.smooth = null; R.shownKey = null; R.zoom = 1;
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
    if (err.name === 'AbortError') return false; // superseded by a newer request
    console.warn(err);
    const key = cameraErrorKey(err);
    R.lastErr = { key, msg: err.message || err.name };
    errEl.textContent = t(key, { msg: R.lastErr.msg });
    errEl.hidden = false;
    if (R.kind === 'none') $('start').hidden = false;
    else toast(errEl.textContent);
    return false;
  }
}

function freeze() {
  if (R.kind !== 'camera') return;
  const [w, h] = sourceSize();
  if (!w) return;
  const c = R.frozenCanvas || (R.frozenCanvas = document.createElement('canvas'));
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(video, 0, 0, w, h);
  R.source = c; R.kind = 'frozen'; R.newFrame = true; requestAnalysis();
  updateToolbar(); updateZoomChips();
}
function resumeLive() {
  if (camera.live) {
    R.source = video; R.kind = 'camera'; R.newFrame = true; R.smooth = null; R.shownKey = null;
    video.play().catch(() => {});
    updateToolbar(); updateZoomChips(); layout();
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
    $('start').hidden = true;
    layout(); requestAnalysis();
    updateToolbar(); updateZoomChips();
    toast(t('toast.photo'));
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
    b.addEventListener('click', async () => {
      list.querySelectorAll('.cam-item').forEach((x) => { x.disabled = true; });
      const ok = await startCamera({ deviceId: c.deviceId, facing: c.facing || undefined });
      if (ok) { S.camId = camera.deviceId; save(); }
      openCamSheet();
    });
    list.appendChild(b);
  }
  const st = camera.settings, z = camera.zoomRange;
  $('camInfo').textContent = R.kind === 'camera' && st.width
    ? t('cam.info', { res: `${st.width}×${st.height}`, zoom: z ? t('cam.zoomInfo', { min: +z.min.toFixed(1), max: +z.max.toFixed(1) }) : '' })
    : '';
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
  const show = levels.length > 1 && !(S.mode === 'correct' && !S.cpCollapsed);
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
function showHud(text) {
  const h = $('hud');
  h.textContent = text; h.hidden = false;
  clearTimeout(hudTimer);
  hudTimer = setTimeout(() => { h.hidden = true; }, 1100);
}

// ---------------- region range control ----------------
const SENS_MIN = 0.4, SENS_MAX = 2.5;
function sensToPos(s) { return (Math.log(s) - Math.log(SENS_MIN)) / (Math.log(SENS_MAX) - Math.log(SENS_MIN)); }
function posToSens(p) { return Math.exp(Math.log(SENS_MIN) + Math.max(0, Math.min(1, p)) * (Math.log(SENS_MAX) - Math.log(SENS_MIN))); }
function setSens(v, hud = true) {
  S.segSens = Math.max(SENS_MIN, Math.min(SENS_MAX, v));
  save();
  const p = sensToPos(S.segSens);
  $('rangeKnob').style.bottom = `calc(${(p * 100).toFixed(1)}% - 11px)`;
  $('rangeFill').style.height = `${(p * 100).toFixed(1)}%`;
  if (hud) showHud(t('range.hud', { p: Math.round(S.segSens * 100) }));
  requestAnalysis();
}

/** Position the reticle, range slider and zoom chips relative to the picture. */
function placeFloating() {
  const rc = R.rect;
  const rng = $('rangeCtl');
  rng.hidden = !(R.source && idVisible() && (S.outline || S.dim));
  rng.style.top = `${rc.y + rc.h / 2}px`;
  rng.style.right = `${Math.max(6, R.W - (rc.x + rc.w) + 6)}px`;
  const chips = $('zoomChips');
  const cardTop = $('card').offsetParent ? $('card').getBoundingClientRect().top : R.H - 80;
  const below = rc.y + rc.h + 4;
  // below the picture when there is room (fit mode), otherwise inside its bottom edge
  chips.style.top = `${below + 42 <= cardTop ? below : Math.min(rc.y + rc.h, cardTop) - 46}px`;
  chips.style.left = `${rc.x + rc.w / 2}px`;
  $('hud').style.top = `${rc.y + 12}px`;
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
  $('wbBadge').textContent = t('wb.badge.' + S.wbMode);
  $('btnWBTool').classList.toggle('on', !$('wbPop').hidden);
}

function setMode(mode) {
  if (mode === 'correct' && !R.glOk) { toast(t('err.webgl')); mode = 'identify'; }
  S.mode = mode; save();
  app.classList.toggle('mode-correct', mode === 'correct');
  app.classList.toggle('mode-identify', mode === 'identify');
  $('modeIdentify').setAttribute('aria-selected', String(mode === 'identify'));
  $('modeCorrect').setAttribute('aria-selected', String(mode === 'correct'));
  app.classList.toggle('hide-id', !S.showId);
  applyCorrection();
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
  $('strength').value = c.strength;
  $('strOut').textContent = `${c.strength}%`;
  const resolved = resolveMethod(c.method, c.severity / 100, c.type);
  $('methodDesc').textContent = c.method === 'auto'
    ? t('m.desc.auto', { m: t('m.' + resolved) }) : t('m.desc.' + c.method);
  $('optSplit').checked = S.split; $('optPreview').checked = S.preview; $('optShowId').checked = S.showId;
  $('cpSummary').textContent = `${t('cvd.' + c.type)} · ${c.severity}% · ${t('m.' + resolved)}`;
  $('correctPanel').classList.toggle('collapsed', S.cpCollapsed);
  $('cpToggle').setAttribute('aria-expanded', String(!S.cpCollapsed));
  $('strength').disabled = resolved === 'simulate';
}

function syncSettingsUI() {
  document.querySelectorAll('#langSeg button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.lang === getLang())));
  document.querySelectorAll('#setSeg button, #setSeg2 button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.set === S.set)));
  $('optBilingual').checked = S.bilingual; $('optOutline').checked = S.outline; $('optDim').checked = S.dim;
  $('optValues').checked = S.values; $('optAutoSpeak').checked = S.autoSpeak;
}

function syncWBUI() {
  document.querySelectorAll('#wbSeg button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.wb === S.wbMode)));
  let desc = t('wb.desc.' + S.wbMode);
  if (S.wbMode === 'manual' && S.wbCalibrated) desc = t('wb.desc.manualDone', { lock: S.wbLocked ? t('wb.locked') : '' });
  $('wbDesc').textContent = desc;
  $('btnWBCal').hidden = S.wbMode !== 'manual';
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
  syncCorrectUI(); syncSettingsUI(); syncWBUI(); updateToolbar(); updateCard();
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
  $('btnWBTool').addEventListener('click', () => {
    const pop = $('wbPop');
    pop.hidden = !pop.hidden;
    syncWBUI();
  });
  $('wbClose').addEventListener('click', () => { $('wbPop').hidden = true; updateToolbar(); });
  document.querySelectorAll('#wbSeg button').forEach((b) => b.addEventListener('click', () => setWBMode(b.dataset.wb)));
  $('btnWBCal').addEventListener('click', calibrateWB);

  // zoom chips & range control
  $('zoomChips').addEventListener('click', (e) => { const z = e.target.dataset && e.target.dataset.z; if (z) setZoom(+z); });
  $('rangePlus').addEventListener('click', () => setSens(S.segSens * 1.2));
  $('rangeMinus').addEventListener('click', () => setSens(S.segSens / 1.2));
  const track = $('rangeTrack');
  const fromY = (e) => { const r = track.getBoundingClientRect(); setSens(posToSens(1 - (e.clientY - r.top) / r.height)); };
  track.addEventListener('pointerdown', (e) => { track.setPointerCapture(e.pointerId); track.dataset.drag = '1'; fromY(e); });
  track.addEventListener('pointermove', (e) => { if (track.dataset.drag) fromY(e); });
  const stop = () => { delete track.dataset.drag; };
  track.addEventListener('pointerup', stop); track.addEventListener('pointercancel', stop);

  const setSet = (v) => { S.set = v; save(); R.shownKey = null; syncSettingsUI(); requestAnalysis(); };
  document.querySelectorAll('#setSeg button, #setSeg2 button').forEach((b) => b.addEventListener('click', () => setSet(b.dataset.set)));
  document.querySelectorAll('#langSeg button').forEach((b) => b.addEventListener('click', () => setLanguage(b.dataset.lang)));

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
  $('cpToggle').addEventListener('click', () => { S.cpCollapsed = !S.cpCollapsed; save(); syncCorrectUI(); updateZoomChips(); });
  document.querySelectorAll('#typeSeg button').forEach((b) => b.addEventListener('click', () => { S.cvd.type = b.dataset.type; save(); syncCorrectUI(); applyCorrection(); }));
  document.querySelectorAll('#methodChips button').forEach((b) => b.addEventListener('click', () => { S.cvd.method = b.dataset.method; save(); syncCorrectUI(); applyCorrection(); }));
  $('severity').addEventListener('input', (e) => { S.cvd.severity = +e.target.value; save(); syncCorrectUI(); applyCorrection(); });
  $('strength').addEventListener('input', (e) => { S.cvd.strength = +e.target.value; save(); syncCorrectUI(); applyCorrection(); });
  bindToggle('optSplit', 'split', applyCorrection);
  bindToggle('optPreview', 'preview', applyCorrection);
  bindToggle('optShowId', 'showId', () => { app.classList.toggle('hide-id', !S.showId); placeFloating(); requestAnalysis(); requestAnimationFrame(layout); });

  // self-test
  const test = new SelfTest({
    root: $('test'), canvas: $('testCanvas'), t,
    onApply: (type, severity) => {
      S.cvd.type = type; S.cvd.severity = severity; S.cvd.method = 'auto'; save();
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
      swipe = { x: e.clientX, y: e.clientY, sens: S.segSens, on: false };
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
      if (swipe.on) setSens(swipe.sens * Math.pow(2, -dy / 220));
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
        if (S.mode === 'correct' && !S.cpCollapsed) {
          // first tap on the picture just tucks the correction panel away
          S.cpCollapsed = true; save(); syncCorrectUI(); updateZoomChips(); tap = null; return;
        }
        if (!$('wbPop').hidden && S.wbMode !== 'manual') { $('wbPop').hidden = true; updateToolbar(); }
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
  setLang(S.lang);
  applyI18n();
  initRenderer();
  if (!R.glOk) app.classList.add('no-gl');
  initWorker();
  resize();
  bind();
  syncCorrectUI();
  syncSettingsUI();
  syncWBUI();
  setSens(S.segSens, false);
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

// expose a tiny hook for automated tests
window.__cvh = { S, R, analyze, setReticle, setMode, freeze, setLanguage, setSens, setWBMode, calibrateWB, camera, layout };

boot();
