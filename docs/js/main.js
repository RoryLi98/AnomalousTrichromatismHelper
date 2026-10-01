// Color Vision Helper — app controller.
import { t, setLang, getLang, applyI18n, detectLang } from './i18n.js';
import { LIN, linearToSrgb, rgbToHex } from './color.js';
import { nameColor, BASIC } from './naming.js';
import { shaderParams, resolveMethod } from './cvd.js';
import { Segmenter } from './segment.js';
import { Renderer } from './gl.js';
import { Camera, cameraErrorKey } from './camera.js';
import { SelfTest } from './selftest.js';

const $ = (id) => document.getElementById(id);
const app = $('app'), video = $('video'), overlay = $('overlay');
let view = $('view');

// ---------------- settings (persisted per device) ----------------
const STORE_KEY = 'cvh.settings.v1';
const DEFAULTS = {
  lang: detectLang(), set: 'basic', bilingual: false, outline: true, dim: false, tolerance: 8,
  values: true, autoSpeak: false, wb: [1, 1, 1], wbOn: false, mode: 'identify',
  cvd: { type: 'deutan', severity: 60, method: 'auto', strength: 100 },
  split: false, preview: false, showId: true, cpCollapsed: false,
};
function loadSettings() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch { saved = null; }
  const s = JSON.parse(JSON.stringify(DEFAULTS));
  if (saved && typeof saved === 'object') {
    for (const k of Object.keys(s)) if (k in saved) s[k] = k === 'cvd' ? { ...s.cvd, ...saved.cvd } : saved[k];
  }
  return s;
}
const S = loadSettings();
function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch { /* storage unavailable */ } }

// ---------------- runtime state ----------------
const R = {
  source: null, kind: 'none', // 'camera' | 'frozen' | 'photo'
  renderer: null, glOk: false, ctx2d: null,
  viewW: 1, viewH: 1, dpr: 1,
  reticle: { x: 0.5, y: 0.5 },
  zoom: 1, split: 0.5,
  smooth: null, shownKey: null, pendKey: null, pendCount: 0,
  lastAnalysis: 0, lastRes: null, lastNaming: null, lastRgb: null,
  newFrame: true, frozenCanvas: null, wakeLock: null, wasLive: false, dirty: true,
};
/** Ask for a fresh analysis on the next frame (after the texture is up to date). */
function requestAnalysis() { R.dirty = true; }
const camera = new Camera(video);
const seg = new Segmenter();

// analysis buffers
const aCanvas = document.createElement('canvas');
const aCtx = aCanvas.getContext('2d', { willReadFrequently: true });
const PS = 16; // patch size for color sampling
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

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = app.clientWidth, h = app.clientHeight;
  R.viewW = w; R.viewH = h; R.dpr = dpr;
  const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
  if (R.glOk) R.renderer.resize(pw, ph);
  else { view.width = pw; view.height = ph; }
  overlay.width = pw; overlay.height = ph;
  // analysis resolution ≈ 80k pixels with the view's aspect ratio
  const va = w / h;
  const AW = Math.max(64, Math.round(Math.sqrt(80000 * va)));
  const AH = Math.max(64, Math.round(AW / va));
  aCanvas.width = AW; aCanvas.height = AH;
  mCanvas.width = AW; mCanvas.height = AH;
  maskImage = mCtx.createImageData(AW, AH);
  placeReticle();
  R.newFrame = true;
  requestAnalysis();
}

function sourceSize() {
  const s = R.source;
  if (!s) return [0, 0];
  if (s instanceof HTMLVideoElement) return [s.videoWidth, s.videoHeight];
  return [s.width, s.height];
}

/** Cover-crop of the source matching the view aspect (and digital zoom), in source pixels. */
function crop() {
  const [sw, sh] = sourceSize();
  if (!sw || !sh) return null;
  const va = R.viewW / R.viewH, sa = sw / sh;
  let cw, ch;
  if (sa > va) { ch = sh; cw = sh * va; } else { cw = sw; ch = sw / va; }
  cw /= R.zoom; ch /= R.zoom;
  return { x: (sw - cw) / 2, y: (sh - ch) / 2, w: cw, h: ch, sw, sh };
}

function mirrored() { return R.kind !== 'photo' && camera.mirrored; }

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
    const ctx = R.ctx2d;
    ctx.save();
    if (mirrored()) { ctx.translate(view.width, 0); ctx.scale(-1, 1); }
    ctx.drawImage(R.source, c.x, c.y, c.w, c.h, 0, 0, view.width, view.height);
    ctx.restore();
  }
}

function applyCorrection() {
  if (!R.glOk) return;
  const on = S.mode === 'correct';
  const cfg = { type: S.cvd.type, severity: S.cvd.severity / 100, method: S.cvd.method, strength: S.cvd.strength / 100 };
  R.renderer.setParams(on ? shaderParams(cfg) : null);
  R.renderer.setPreview(on && S.preview);
  R.renderer.setSplit(on && S.split ? R.split : -1);
  R.renderer.setWB(S.wbOn ? S.wb : [1, 1, 1]);
  $('splitLabels').hidden = !(on && S.split);
  $('splitLabels').style.setProperty('--split', (R.split * 100).toFixed(1) + '%');
}

// ---------------- color sampling & analysis ----------------
function median(arr, n) {
  const a = arr.slice(0, n).sort((x, y) => x - y);
  return a[n >> 1];
}
const chR = new Float32Array(PS * PS), chG = new Float32Array(PS * PS), chB = new Float32Array(PS * PS);

function sampleColor(c) {
  // patch ≈ 18 CSS px around the reticle, sampled at full source resolution
  const mir = mirrored();
  const rx = mir ? 1 - R.reticle.x : R.reticle.x;
  const size = Math.max(4, 18 * (c.w / R.viewW));
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
  let n = 0;
  const r0 = PS / 2 - 0.5, rad2 = (PS / 2) * (PS / 2);
  for (let y = 0; y < PS; y++) for (let x = 0; x < PS; x++) {
    if ((x - r0) ** 2 + (y - r0) ** 2 > rad2) continue;
    const p = (y * PS + x) * 4;
    chR[n] = LIN[d[p]]; chG[n] = LIN[d[p + 1]]; chB[n] = LIN[d[p + 2]]; n++;
  }
  const g = S.wbOn ? S.wb : [1, 1, 1];
  return [Math.min(1, median(chR, n) * g[0]), Math.min(1, median(chG, n) * g[1]), Math.min(1, median(chB, n) * g[2])];
}

function analyze() {
  const c = crop();
  if (!c) return;
  const live = R.kind === 'camera';
  const lin = sampleColor(c);
  // temporal smoothing (faster when the color changes a lot)
  if (!R.smooth || !live) R.smooth = lin;
  else {
    const diff = Math.abs(lin[0] - R.smooth[0]) + Math.abs(lin[1] - R.smooth[1]) + Math.abs(lin[2] - R.smooth[2]);
    const a = diff > 0.12 ? 0.75 : 0.35;
    R.smooth = R.smooth.map((v, k) => v + (lin[k] - v) * a);
  }
  const rgb = R.smooth.map((v) => Math.round(linearToSrgb(v) * 255));
  const naming = nameColor(rgb[0], rgb[1], rgb[2]);
  // hysteresis on the displayed name to avoid flicker
  const key = S.set === 'basic' ? naming.basicKey : naming.detailed.en;
  if (key === R.shownKey || !live || R.shownKey === null) { R.pendCount = 0; R.shownKey = key; R.lastNaming = naming; }
  else if (key === R.pendKey) { if (++R.pendCount >= 2) { R.shownKey = key; R.lastNaming = naming; R.pendCount = 0; onNameChanged(); } }
  else { R.pendKey = key; R.pendCount = 0; }
  if (!R.lastNaming) R.lastNaming = naming;
  R.lastRgb = rgb;

  // region segmentation
  let res = null;
  const idVisible = !(S.mode === 'correct' && !S.showId);
  if ((S.outline || S.dim) && idVisible) {
    const AW = aCanvas.width, AH = aCanvas.height;
    let img;
    if (R.glOk) {
      img = R.renderer.read([c.x / c.sw, c.y / c.sh, c.w / c.sw, c.h / c.sh], mirrored(), AW, AH);
    } else {
      aCtx.save();
      if (mirrored()) { aCtx.translate(AW, 0); aCtx.scale(-1, 1); }
      aCtx.drawImage(R.source, c.x, c.y, c.w, c.h, 0, 0, AW, AH);
      aCtx.restore();
      img = aCtx.getImageData(0, 0, AW, AH);
    }
    res = seg.run(img, R.reticle.x * AW - 0.5, R.reticle.y * AH - 0.5, S.tolerance / 100, S.wbOn ? S.wb : null, live);
  }
  R.lastRes = res;
  drawOverlay(res);
  updateCard();
}

function drawOverlay(res) {
  const ctx = oCtx, W = overlay.width, H = overlay.height;
  ctx.clearRect(0, 0, W, H);
  if (!res || res.area <= 0) return;
  const sx = W / res.w, sy = H / res.h;
  if (S.dim) {
    const d = maskImage.data, soft = res.soft;
    for (let i = 0, p = 3; i < soft.length; i++, p += 4) { d[p - 3] = 255; d[p - 2] = 255; d[p - 1] = 255; d[p] = soft[i] * 255; }
    mCtx.putImageData(maskImage, 0, 0);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(mCanvas, 0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over';
  }
  if (S.outline && res.segCount) {
    const s = res.segments;
    ctx.beginPath();
    for (let k = 0; k < res.segCount; k++) {
      const o = k * 4;
      ctx.moveTo((s[o] + 0.5) * sx, (s[o + 1] + 0.5) * sy);
      ctx.lineTo((s[o + 2] + 0.5) * sx, (s[o + 3] + 0.5) * sy);
    }
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.lineWidth = 5 * R.dpr; ctx.stroke();
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2.2 * R.dpr; ctx.stroke();
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

function updateCard() {
  const naming = R.lastNaming, rgb = R.lastRgb;
  if (!naming || !rgb) return;
  const hex = rgbToHex(...rgb);
  $('swatch').style.background = hex;
  const tx = colorTexts(naming);
  $('colorName').textContent = tx.name;
  $('colorAlt').textContent = tx.alt;
  const sub = [];
  if (S.values) sub.push(`<span class="hex" data-hex="${hex}">${hex}</span> · RGB ${rgb.join(', ')}`);
  if (R.lastRes && R.lastRes.area > 0) sub.push(t('card.area', { p: Math.max(1, Math.round(R.lastRes.area * 100)) }));
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
async function startCamera(facing) {
  const startedAt = performance.now();
  const errEl = $('startError');
  errEl.hidden = true;
  try {
    await camera.start(facing);
    if (R.kind === 'photo' && R.photoAt > startedAt) { camera.stop(); return false; }
    R.source = video; R.kind = 'camera'; R.newFrame = true; R.smooth = null; R.shownKey = null;
    $('start').hidden = true;
    updateToolbar();
    requestWakeLock();
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
  updateToolbar();
}
function resumeLive() {
  if (camera.live) {
    R.source = video; R.kind = 'camera'; R.newFrame = true; R.smooth = null; R.shownKey = null;
    video.play().catch(() => {});
    updateToolbar();
  } else startCamera(camera.facing);
}

async function loadPhoto(file) {
  if (!file) return;
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    // letterbox the photo into a canvas with the view's aspect ratio
    const va = R.viewW / R.viewH;
    const long = 1600;
    const cw = va >= 1 ? long : Math.round(long * va), ch = va >= 1 ? Math.round(long / va) : long;
    const c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#16181c'; ctx.fillRect(0, 0, cw, ch);
    const s = Math.min(cw / img.naturalWidth, ch / img.naturalHeight);
    const dw = img.naturalWidth * s, dh = img.naturalHeight * s;
    ctx.drawImage(img, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
    camera.cancelPending();
    camera.stop();
    R.photoAt = performance.now();
    R.source = c; R.kind = 'photo'; R.newFrame = true; R.zoom = 1; R.smooth = null; R.shownKey = null; requestAnalysis();
    $('start').hidden = true;
    updateToolbar();
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
    startCamera(camera.facing);
  }
});
// the track can end on its own (another app took the camera, phone call, OS interruption)
camera.onEnded = () => { if (R.kind === 'camera' && !document.hidden) startCamera(camera.facing); };
// iOS may leave the <video> paused after an interruption
video.addEventListener('pause', () => { if (R.kind === 'camera' && !document.hidden && camera.live) video.play().catch(() => {}); });

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
  $('btnFlip').disabled = R.kind !== 'camera' || !!$('btnFlip').dataset.busy;
  const torch = $('btnTorch');
  torch.disabled = !(R.kind === 'camera' && camera.torchSupported);
  torch.classList.toggle('on', camera.torchOn && !torch.disabled);
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
  $('tolerance').value = S.tolerance; $('optValues').checked = S.values; $('optAutoSpeak').checked = S.autoSpeak;
  $('wbState').textContent = t(S.wbOn ? 'settings.wbOn' : 'settings.wbOff');
}

function setLanguage(lang) {
  S.lang = lang; save();
  setLang(lang);
  applyI18n();
  syncCorrectUI(); syncSettingsUI(); updateToolbar(); updateCard();
  if (!R.lastNaming) $('colorName').textContent = t('card.waiting');
  if (R.lastErr && !$('startError').hidden) $('startError').textContent = t(R.lastErr.key, { msg: R.lastErr.msg });
}

let toastTimer = 0;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function placeReticle() {
  const r = $('reticle');
  r.style.left = (R.reticle.x * 100) + '%';
  r.style.top = (R.reticle.y * 100) + '%';
  $('btnRecenter').hidden = Math.abs(R.reticle.x - 0.5) < 0.01 && Math.abs(R.reticle.y - 0.5) < 0.01;
}
function setReticle(x, y) {
  R.reticle.x = Math.max(0.02, Math.min(0.98, x));
  R.reticle.y = Math.max(0.02, Math.min(0.98, y));
  R.smooth = null; R.shownKey = null;
  placeReticle();
  requestAnalysis();
}

function calibrateWB() {
  if (!R.source) return;
  const c = crop();
  if (!c) return;
  const saved = S.wbOn; S.wbOn = false;
  const lin = sampleColor(c);
  S.wbOn = saved;
  const Y = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  const mx = Math.max(...lin), mn = Math.min(...lin);
  if (Y < 0.04 || (mx - mn) / mx > 0.45) { toast(t('toast.wbBad')); return; }
  // gains that map the sample to a neutral gray of the same luminance (cap ±60%)
  S.wb = lin.map((v) => Math.max(0.6, Math.min(1.6, Y / Math.max(1e-4, v))));
  S.wbOn = true; save();
  applyCorrection(); syncSettingsUI();
  R.smooth = null; R.shownKey = null; requestAnalysis();
  toast(t('toast.wbDone'));
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
  $('btnFlip').addEventListener('click', async () => {
    const btn = $('btnFlip');
    if (R.kind !== 'camera' || btn.dataset.busy) return;
    btn.dataset.busy = '1'; btn.disabled = true;
    try { await camera.flip(); R.newFrame = true; R.smooth = null; R.shownKey = null; }
    catch (e) { if (e.name !== 'AbortError') toast(t(cameraErrorKey(e), { msg: e.message })); }
    delete btn.dataset.busy;
    updateToolbar();
  });
  $('btnTorch').addEventListener('click', async () => { await camera.setTorch(!camera.torchOn); updateToolbar(); });
  $('btnSpeak').addEventListener('click', speakCurrent);
  $('btnRecenter').addEventListener('click', () => setReticle(0.5, 0.5));
  $('colorSub').addEventListener('click', (e) => {
    const hex = e.target.dataset && e.target.dataset.hex;
    if (hex && navigator.clipboard) navigator.clipboard.writeText(hex).then(() => toast(t('toast.copied', { x: hex })), () => {});
  });

  const setSet = (v) => { S.set = v; save(); R.shownKey = null; syncSettingsUI(); requestAnalysis(); };
  document.querySelectorAll('#setSeg button, #setSeg2 button').forEach((b) => b.addEventListener('click', () => setSet(b.dataset.set)));
  document.querySelectorAll('#langSeg button').forEach((b) => b.addEventListener('click', () => setLanguage(b.dataset.lang)));

  const bindToggle = (id, key, after) => $(id).addEventListener('change', (e) => { S[key] = e.target.checked; save(); if (after) after(); });
  bindToggle('optBilingual', 'bilingual', updateCard);
  bindToggle('optOutline', 'outline', () => requestAnalysis());
  bindToggle('optDim', 'dim', () => requestAnalysis());
  bindToggle('optValues', 'values', updateCard);
  bindToggle('optAutoSpeak', 'autoSpeak', () => {
    // iOS only allows speech after one utterance started inside a user gesture
    if (S.autoSpeak && 'speechSynthesis' in window) { try { speechSynthesis.speak(new SpeechSynthesisUtterance('')); } catch { /* ignore */ } }
  });
  $('tolerance').addEventListener('input', (e) => { S.tolerance = +e.target.value; save(); requestAnalysis(); });
  $('btnWB').addEventListener('click', () => { $('settings').hidden = true; calibrateWB(); });
  $('btnWBReset').addEventListener('click', () => { S.wbOn = false; S.wb = [1, 1, 1]; save(); applyCorrection(); syncSettingsUI(); R.smooth = null; R.shownKey = null; requestAnalysis(); });

  // correction panel
  $('cpToggle').addEventListener('click', () => { S.cpCollapsed = !S.cpCollapsed; save(); syncCorrectUI(); });
  document.querySelectorAll('#typeSeg button').forEach((b) => b.addEventListener('click', () => { S.cvd.type = b.dataset.type; save(); syncCorrectUI(); applyCorrection(); }));
  document.querySelectorAll('#methodChips button').forEach((b) => b.addEventListener('click', () => { S.cvd.method = b.dataset.method; save(); syncCorrectUI(); applyCorrection(); }));
  $('severity').addEventListener('input', (e) => { S.cvd.severity = +e.target.value; save(); syncCorrectUI(); applyCorrection(); });
  $('strength').addEventListener('input', (e) => { S.cvd.strength = +e.target.value; save(); syncCorrectUI(); applyCorrection(); });
  bindToggle('optSplit', 'split', applyCorrection);
  bindToggle('optPreview', 'preview', applyCorrection);
  bindToggle('optShowId', 'showId', () => { app.classList.toggle('hide-id', !S.showId); requestAnalysis(); });

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
}

// ---------------- gestures: tap = move reticle, double-tap = recenter, pinch = zoom, drag divider ----------------
function bindGestures() {
  const pts = new Map();
  let tap = null, lastTap = 0, pinch = null, dragSplit = false;
  const isView = (e) => e.target === view || e.target === video || e.target === overlay || e.target === app || e.target.id === 'view';
  app.addEventListener('pointerdown', (e) => {
    if (!isView(e) || !R.source) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { app.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    if (pts.size === 1) {
      const splitOn = S.mode === 'correct' && S.split;
      dragSplit = splitOn && Math.abs(e.clientX - R.split * R.viewW) < 32;
      tap = { x: e.clientX, y: e.clientY, t: performance.now() };
    } else if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z: R.zoom };
      tap = null; dragSplit = false;
    }
  });
  app.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pts.size === 2 && R.kind !== 'photo') {
      const [a, b] = [...pts.values()];
      R.zoom = Math.max(1, Math.min(5, pinch.z * Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, pinch.d)));
      const zb = $('zoomBadge'); zb.hidden = R.zoom < 1.05; zb.textContent = R.zoom.toFixed(1) + '×';
      requestAnalysis();
    } else if (dragSplit) {
      R.split = Math.max(0.05, Math.min(0.95, e.clientX / R.viewW));
      applyCorrection();
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
          S.cpCollapsed = true; save(); syncCorrectUI(); tap = null; return;
        }
        if (now - lastTap < 320) { setReticle(0.5, 0.5); lastTap = 0; }
        else { setReticle(tap.x / R.viewW, tap.y / R.viewH); lastTap = now; }
      }
      tap = null; dragSplit = false;
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
  resize();
  bind();
  syncCorrectUI();
  syncSettingsUI();
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
window.__cvh = { S, R, analyze, setReticle, setMode, freeze, setLanguage };

boot();
