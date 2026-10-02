// "True colour": estimate an object's own colour (its reflectance, as it would look in daylight
// with white = 100 %) instead of the colour the camera happened to record.
//
// A camera pixel is roughly  ISP( exposure × illuminance × light colour × reflectance ), so the same
// orange reads as brown in a dim room and as grey/black when the phone also desaturates its
// low-light frames. One RGB triple cannot be inverted on its own; each source below adds one piece
// of knowledge (see 论文资料/真色测量调研 for the study and the simulation behind the numbers):
//
//   ① camera  – assumption: the brightest near-neutral surface in view is white (≈85 %); lightness
//               is measured relative to it, chromaticity kept (median ΔE2000 ≈ 5 in simulation)
//   ② paper   – a white sheet next to the object, in the same light: white balance + lightness (≈4)
//   ③ torch   – torch-on minus torch-off frame at a locked exposure is lit only by the torch, whose
//               colour is calibrated once (≈5; with the paper at the same distance ≈2)
//   ④ chart   – a 24-patch ColorChecker or the printable card: per-channel tone curve from the grey
//               patches, then a white-preserving root-polynomial transform (≈1.7; printed card ≈3.3)
//
// A ColorChecker photographed in good light also calibrates the lens (camera profile below): ① and ②
// then go through the camera's own colour processing in reverse (simulation: ② 4.3 → 3.5, ① 7.2 → 6.3).
//
// Everything here is pure (no DOM) so it runs in the worker and in Node tests.
import { LIN, linearToSrgb, deltaE2000, linRgbToOklab, oklabToLinRgb } from './color.js';
import { estimateWB } from './wb.js';
import { classifyBasic } from './naming.js';

export const LUMA = [0.2126, 0.7152, 0.0722];
export const WHITE_RHO = 0.85;   // white wall / printer paper reflectance
export const BRIGHT_RHO = 0.75;  // brightest surface when nothing near-neutral is in view
export const GLARE = 0.01;       // veiling glare: fraction of the mean frame colour added everywhere
export const TORCH_DIST = 0.25;  // metres; torch calibration distance (and assumed distance without paper)

export const luma = (c) => LUMA[0] * c[0] + LUMA[1] * c[1] + LUMA[2] * c[2];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** Scale a linear colour to luminance Y, keeping its chromaticity. */
export function withLuma(c, Y) {
  const y = luma(c);
  const k = y > 1e-7 ? Y / y : 0;
  return [c[0] * k, c[1] * k, c[2] * k];
}

/** Undo a chroma scaling s (lin = Y + s·(lin_true − Y)). */
export function resaturate(c, s) {
  const Y = luma(c);
  return c.map((v) => Y + (v - Y) / s);
}

export function subtractGlare(c, mean, gamma = GLARE) {
  if (!mean) return c.slice();
  return c.map((v, k) => Math.max(0, v - gamma * mean[k]));
}

/** 8-bit sRGB -> linear, optionally through a calibrated tone exponent per channel. */
export function toLinear(r, g, b, toneK = null) {
  const v = [LIN[r | 0], LIN[g | 0], LIN[b | 0]];
  return toneK ? v.map((x, k) => Math.pow(x, toneK[k])) : v;
}

export function linToSrgb8(c) {
  return c.map((v) => Math.round(linearToSrgb(clamp(v, 0, 1)) * 255));
}

/** Linear sRGB -> CIELAB (D65). */
export function linToLab(c) {
  const [r, g, b] = c;
  const X = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
  const Y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
  const Z = 0.0193339 * r + 0.1191920 * g + 0.9503041 * b;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f(X / 0.95047), fy = f(Y), fz = f(Z / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
export const deltaELin = (a, b) => deltaE2000(linToLab(a), linToLab(b));

function percentile(arr, q) {
  if (!arr.length) return 0;
  const a = Float32Array.from(arr).sort();
  return a[Math.min(a.length - 1, Math.max(0, Math.floor(q * (a.length - 1))))];
}
function median3(list) {
  const out = [0, 0, 0];
  for (let k = 0; k < 3; k++) out[k] = percentile(list.map((c) => c[k]), 0.5);
  return out;
}

// Luminance histograms on a log scale: percentiles of a frame in O(n) without sorting.
// 0.17 % per bin, interpolated within the bin, so the error is far below camera noise.
const HB = 4096, HLO = Math.log(0.002), HHI = Math.log(4), HSC = HB / (HHI - HLO);
const hBin = (Y) => { const b = ((Math.log(Y) - HLO) * HSC) | 0; return b < 0 ? 0 : b >= HB ? HB - 1 : b; };
function hPercentile(hist, count, q) {
  if (!count) return 0;
  const rank = Math.floor(q * (count - 1));
  let acc = 0;
  for (let b = 0; b < HB; b++) {
    const c = hist[b];
    if (acc + c > rank) return Math.exp(HLO + (b + (rank - acc + 0.5) / c) / HSC);
    acc += c;
  }
  return Math.exp(HHI);
}

// work buffers, reused across frames of the same size
let BUF = null;
function buffers(gridN, fullN) {
  if (!BUF || BUF.grid.length < gridN || BUF.full.length < fullN) {
    const n = Math.max(gridN, fullN);
    BUF = {
      grid: new Float32Array(gridN), full: new Float32Array(fullN), comp: new Int32Array(n), stack: new Int32Array(n),
      hBright: new Uint32Array(HB), hNeutral: new Uint32Array(HB), hLocal: new Uint32Array(HB), hLocalN: new Uint32Array(HB),
    };
  }
  BUF.hBright.fill(0); BUF.hNeutral.fill(0); BUF.hLocal.fill(0); BUF.hLocalN.fill(0);
  return BUF;
}

// ------------------------------------------------------------------------------------------
// Frame statistics (worker): mean colour (glare), white anchor, paper next to the target, noise
// ------------------------------------------------------------------------------------------

/**
 * @param img   {width, height, data: RGBA 8-bit} unprocessed analysis frame
 * @param opts  {gains: WB gains, soft: target mask (0..1) or null, sx, sy: target seed (px),
 *               prev: lumaSmall from the previous call (for the noise index),
 *               paperAt: {x, y, r} paper position the user tapped (fractions of the frame), else automatic}
 * @returns {mean, anchor:{Y, neutral, frac, at}|null, localAnchor:{Y, n}|null, localWB:{gains, frac}|null,
 *           paper:{found, rgb, Y, cx, cy, r, clipped}, noise, lumaSmall}
 *   rgb / mean are raw linear (no WB); Y values are after WB gains. cx, cy, r are fractions of the frame.
 *   anchor.at: where the surface taken as white is ({x, y, w, h} box, fractions), for showing it.
 *   localAnchor: brightest near-neutral surface next to the target (a white surface in the same shadow).
 *   localWB: the light colour next to the target (estimateWB on that part of the frame), for mixed light.
 */
export function frameStats(img, opts = {}) {
  const { width: w, height: h, data } = img;
  const g = opts.gains || [1, 1, 1];
  const g0 = g[0], g1 = g[1], g2 = g[2];
  const soft = opts.soft || null;
  const sx = opts.sx ?? w / 2, sy = opts.sy ?? h / 2;
  const step = w * h > 40000 ? 2 : 1;
  const winX = 0.3 * w, winY = 0.3 * h;
  // the window next to the target where paper is looked for, as a grid of sampled pixels
  const i0 = Math.max(0, Math.floor((sx - winX) / step) + 1), i1 = Math.min(Math.ceil(w / step) - 1, Math.ceil((sx + winX) / step) - 1);
  const j0 = Math.max(0, Math.floor((sy - winY) / step) + 1), j1 = Math.min(Math.ceil(h / step) - 1, Math.ceil((sy + winY) / step) - 1);
  const gw = Math.max(0, i1 - i0 + 1), gh = Math.max(0, j1 - j0 + 1);
  const fw = Math.ceil(w / step), fh = Math.ceil(h / step);
  const B = buffers(gw * gh, fw * fh);
  const grid = B.grid, full = B.full, hBright = B.hBright, hNeutral = B.hNeutral, hLocal = B.hLocal, hLocalN = B.hLocalN;
  grid.fill(0, 0, gw * gh); full.fill(0, 0, fw * fh);
  let mr = 0, mg = 0, mb = 0, n = 0, total = 0, nBright = 0, nNeutral = 0, nLocal = 0, nLocalN = 0;
  let localTotal = 0, localClip = 0;
  for (let y = 0, j = 0; y < h; y += step, j++) {
    const rowWin = j >= j0 && j <= j1;
    for (let x = 0, i = 0; x < w; x += step, i++) {
      const pi = y * w + x, p = pi * 4;
      const R8 = data[p], G8 = data[p + 1], B8 = data[p + 2];
      const r = LIN[R8], gg = LIN[G8], b = LIN[B8];
      mr += r; mg += gg; mb += b; n++;
      const inWin = rowWin && i >= i0 && i <= i1;
      if (soft && soft[pi] > 0.3) { if (inWin) grid[(j - j0) * gw + (i - i0)] = -1; continue; }
      total++;
      const clipped = R8 >= 250 || G8 >= 250 || B8 >= 250;
      if (inWin) { localTotal++; if (clipped) localClip++; }
      if (clipped) continue;
      const rc = r * g0, gc = gg * g1, bc = b * g2;
      const Y = 0.2126 * rc + 0.7152 * gc + 0.0722 * bc;
      if (Y < 0.004) continue;
      const bin = hBin(Y);
      hBright[bin]++; nBright++;
      const mx = rc > gc ? (rc > bc ? rc : bc) : (gc > bc ? gc : bc);
      const mn = rc < gc ? (rc < bc ? rc : bc) : (gc < bc ? gc : bc);
      const ch = (mx - mn) / mx;
      const neutral = ch < 0.12 && Y > 0.04;
      if (neutral) { hNeutral[bin]++; nNeutral++; if (inWin) { hLocalN[bin]++; nLocalN++; } }
      full[j * fw + i] = neutral ? Y : -Y;   // for locating the anchor afterwards
      // paper may keep some of the light's tint after white balance (warm lamps): looser than the anchor
      if (inWin && ch < 0.3) { grid[(j - j0) * gw + (i - i0)] = Y; hLocal[bin]++; nLocal++; }
    }
  }
  const mean = n ? [mr / n, mg / n, mb / n] : [0, 0, 0];
  const glareY = GLARE * (0.2126 * mean[0] * g0 + 0.7152 * mean[1] * g1 + 0.0722 * mean[2] * g2);
  let anchor = null;
  const minNeutral = Math.max(30, 0.005 * total);
  const bright98 = hPercentile(hBright, nBright, 0.98);
  if (nNeutral >= minNeutral) {
    anchor = { Y: Math.max(1e-4, hPercentile(hNeutral, nNeutral, 0.95) - glareY), neutral: true, frac: nNeutral / Math.max(1, total) };
  } else if (nBright) {
    anchor = { Y: Math.max(1e-4, bright98 - glareY), neutral: false, frac: 0 };
  }
  if (anchor) anchor.at = locate(full, B.comp, B.stack, fw, fh, 0.85 * (anchor.Y + glareY), anchor.neutral, step, w, h);
  const localAnchor = nearestNeutral(full, B.comp, B.stack, fw, fh, sx / step, sy / step, (i1 - i0) / 2, (j1 - j0) / 2, glareY);
  const localWB = opts.localWB === false ? null : windowWB(img, soft, sx, sy, 0.2 * w, 0.2 * h);
  // paper: a sheet next to the target (same light): a bright, near-neutral, connected area that is
  // neither most of the window nor a wall or table running right through it
  let paper = { found: false, clipped: localTotal > 0 && localClip / localTotal > 0.08 };
  if (opts.paperAt) paper = paperAtPoint(img, opts.paperAt, g);
  else if (nLocal) {
    const top = hPercentile(hLocal, nLocal, 0.9);
    const need = Math.max(40, 0.012 * localTotal), maxN = 0.35 * localTotal;
    const best = top >= 0.6 * bright98 ? paperComponent(grid, B.comp, B.stack, gw, gh, 0.75 * top, need, maxN) : null;
    if (best) {
      const N = best.count, cr = new Float32Array(N), cg = new Float32Array(N), cb = new Float32Array(N);
      const comp = B.comp;
      let k = 0, cx = 0, cy = 0;
      for (let jj = 0; jj < gh; jj++) for (let ii = 0; ii < gw; ii++) {
        if (comp[jj * gw + ii] !== best.label) continue;
        const x = (ii + i0) * step, y = (jj + j0) * step, p = (y * w + x) * 4;
        cr[k] = LIN[data[p]]; cg[k] = LIN[data[p + 1]]; cb[k] = LIN[data[p + 2]]; k++;
        cx += x; cy += y;
      }
      const med = (a) => a.sort()[(N - 1) >> 1];
      const rgb = [med(cr), med(cg), med(cb)];
      const r = Math.sqrt((N * step * step) / Math.PI) / Math.max(w, h);
      const Y = luma(rgb.map((v, c) => v * g[c]));
      paper = { found: true, rgb, Y, cx: cx / N / w, cy: cy / N / h, r, clipped: paper.clipped, count: N };
    }
  }
  // noise index: temporal variance on flat blocks relative to brightness (rises with sensor gain)
  const s4 = 4, W4 = Math.floor(w / s4), H4 = Math.floor(h / s4);
  const small = new Float32Array(W4 * H4);
  for (let y = 0; y < H4; y++) for (let x = 0; x < W4; x++) {
    const p = ((y * s4) * w + x * s4) * 4;
    small[y * W4 + x] = 0.2126 * LIN[data[p]] + 0.7152 * LIN[data[p + 1]] + 0.0722 * LIN[data[p + 2]];
  }
  let noise = null;
  const prev = opts.prev;
  if (prev && prev.length === small.length) {
    const ratios = [];
    const Bk = 4;
    for (let by = 0; by + Bk <= H4; by += Bk) for (let bx = 0; bx + Bk <= W4; bx += Bk) {
      let s = 0, s2 = 0, d2 = 0, m = 0;
      for (let y = by; y < by + Bk; y++) for (let x = bx; x < bx + Bk; x++) {
        const v = small[y * W4 + x], d = v - prev[y * W4 + x];
        s += v; s2 += v * v; d2 += d * d; m++;
      }
      const mu = s / m, sd = Math.sqrt(Math.max(0, s2 / m - mu * mu));
      if (mu < 0.01 || mu > 0.8 || sd > 0.02 + 0.08 * mu) continue;
      ratios.push(d2 / m / (2 * mu));
    }
    if (ratios.length >= 6) noise = percentile(ratios, 0.3);
  }
  return { mean, anchor, localAnchor, localWB, paper, noise, lumaSmall: small };
}

/**
 * The near-neutral surface closest to the target (connected cells within the window, at least 12),
 * and its brightness (90th percentile): in a shadow, the white or grey surfaces next to the object
 * share its light, while the brightest surface of the frame may be in full light.
 */
function nearestNeutral(full, comp, stack, fw, fh, cx, cy, rx, ry, glareY) {
  const i0 = Math.max(0, Math.floor(cx - rx)), i1 = Math.min(fw - 1, Math.ceil(cx + rx));
  const j0 = Math.max(0, Math.floor(cy - ry)), j1 = Math.min(fh - 1, Math.ceil(cy + ry));
  for (let j = j0; j <= j1; j++) comp.fill(0, j * fw + i0, j * fw + i1 + 1);
  let best = null, label = 0;
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const s0 = j * fw + i;
    if (comp[s0] || !(full[s0] > 0.04)) continue;
    label++;
    let sp = 0, count = 0, dmin = Infinity, x0 = fw, x1 = 0, y0 = fh, y1 = 0;
    const ys = [];
    stack[sp++] = s0; comp[s0] = label;
    while (sp) {
      const c = stack[--sp], ci = c % fw, cj = (c - ci) / fw;
      count++; ys.push(full[c]);
      const d = (ci - cx) ** 2 + (cj - cy) ** 2; if (d < dmin) dmin = d;
      if (ci < x0) x0 = ci; if (ci > x1) x1 = ci; if (cj < y0) y0 = cj; if (cj > y1) y1 = cj;
      if (ci > i0 && !comp[c - 1] && full[c - 1] > 0.04) { comp[c - 1] = label; stack[sp++] = c - 1; }
      if (ci < i1 && !comp[c + 1] && full[c + 1] > 0.04) { comp[c + 1] = label; stack[sp++] = c + 1; }
      if (cj > j0 && !comp[c - fw] && full[c - fw] > 0.04) { comp[c - fw] = label; stack[sp++] = c - fw; }
      if (cj < j1 && !comp[c + fw] && full[c + fw] > 0.04) { comp[c + fw] = label; stack[sp++] = c + fw; }
    }
    if (count >= 12 && (!best || dmin < best.d)) { ys.sort((a, b) => a - b); best = { d: dmin, Y: ys[Math.floor(0.9 * (count - 1))], n: count, x0, x1, y0, y1 }; }
  }
  // the frame grid is reused afterwards: clear the labels
  for (let j = j0; j <= j1; j++) comp.fill(0, j * fw + i0, j * fw + i1 + 1);
  if (!best) return null;
  const at = { x: best.x0 / fw, y: best.y0 / fh, w: (best.x1 + 1 - best.x0) / fw, h: (best.y1 + 1 - best.y0) / fh };
  at.cx = at.x + at.w / 2; at.cy = at.y + at.h / 2;
  return { Y: Math.max(1e-4, best.Y - glareY), n: best.n, d: Math.sqrt(best.d), at };
}

/** Largest connected area of the anchor's surface (cells at or above thr), as a box in frame fractions. */
function locate(full, comp, stack, fw, fh, thr, neutralOnly, step, w, h) {
  const N = fw * fh;
  comp.fill(0, 0, N);
  const ok = (v) => (neutralOnly ? v >= thr : Math.abs(v) >= thr);
  let best = null, label = 0;
  for (let s = 0; s < N; s++) {
    if (comp[s] || !ok(full[s])) continue;
    label++;
    let sp = 0, count = 0, x0 = fw, x1 = 0, y0 = fh, y1 = 0, sxs = 0, sys = 0;
    stack[sp++] = s; comp[s] = label;
    while (sp) {
      const c = stack[--sp], ci = c % fw, cj = (c - ci) / fw;
      count++; sxs += ci; sys += cj;
      if (ci < x0) x0 = ci; if (ci > x1) x1 = ci; if (cj < y0) y0 = cj; if (cj > y1) y1 = cj;
      if (ci > 0 && !comp[c - 1] && ok(full[c - 1])) { comp[c - 1] = label; stack[sp++] = c - 1; }
      if (ci < fw - 1 && !comp[c + 1] && ok(full[c + 1])) { comp[c + 1] = label; stack[sp++] = c + 1; }
      if (cj > 0 && !comp[c - fw] && ok(full[c - fw])) { comp[c - fw] = label; stack[sp++] = c - fw; }
      if (cj < fh - 1 && !comp[c + fw] && ok(full[c + fw])) { comp[c + fw] = label; stack[sp++] = c + fw; }
    }
    if (!best || count > best.count) best = { count, x0, x1, y0, y1, cx: sxs / count, cy: sys / count };
  }
  if (!best || best.count < 3) return null;
  const fx = (v) => Math.min(1, (v * step) / w), fy = (v) => Math.min(1, (v * step) / h);
  return { x: fx(best.x0), y: fy(best.y0), w: fx(best.x1 + 1) - fx(best.x0), h: fy(best.y1 + 1) - fy(best.y0), cx: fx(best.cx + 0.5), cy: fy(best.cy + 0.5) };
}

/**
 * Light colour next to the target: the brightest surfaces right around it (their median
 * chromaticity; "white patch" on a small window), and how consistent they are. In mixed light
 * (a lamp on one side, a window on the other) this differs from the frame's white balance.
 */
function windowWB(img, soft, sx, sy, winX, winY) {
  const { width: w, height: h, data } = img;
  const x0 = Math.max(0, Math.floor(sx - winX)), x1 = Math.min(w, Math.ceil(sx + winX));
  const y0 = Math.max(0, Math.floor(sy - winY)), y1 = Math.min(h, Math.ceil(sy + winY));
  const ys = [], px = [];
  for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
    const i = y * w + x;
    if (soft && soft[i] > 0.3) continue;
    const p = i * 4;
    if (data[p] >= 250 || data[p + 1] >= 250 || data[p + 2] >= 250) continue;
    const r = LIN[data[p]], g = LIN[data[p + 1]], b = LIN[data[p + 2]], Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (Y < 0.01) continue;
    ys.push(Y); px.push(r / Y, g / Y, b / Y, Y);
  }
  if (ys.length < 40) return null;
  ys.sort((a, b) => a - b);
  const thr = ys[Math.floor(0.85 * (ys.length - 1))];
  const cr = [], cg = [], cb = [];
  for (let k = 0; k < px.length; k += 4) if (px[k + 3] >= thr) { cr.push(px[k]); cg.push(px[k + 1]); cb.push(px[k + 2]); }
  if (cr.length < 8) return null;
  const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[(s.length - 1) >> 1]; };
  const il = [med(cr), med(cg), med(cb)];
  // spread: median absolute deviation of r/b on a log scale (one surface colour → small)
  const lrb = cr.map((v, k) => Math.log(Math.max(1e-3, v) / Math.max(1e-3, cb[k]))), m = med(lrb);
  const spread = med(lrb.map((v) => Math.abs(v - m)));
  const Yi = 0.2126 * il[0] + 0.7152 * il[1] + 0.0722 * il[2];
  return { gains: il.map((v) => Math.max(0.4, Math.min(2.5, Yi / Math.max(1e-4, v)))), spread, n: cr.length };
}

/**
 * Connected areas (4-neighbour) of grid cells at or above `thr` (target cells are -1); the largest one
 * with between `need` and `maxN` cells that is not a wall or table running through the window: it
 * must not reach both opposite edges, either on its own or together with a piece of the same
 * brightness on the other side of the target. Labels go in `comp`.
 */
function paperComponent(grid, comp, stack, gw, gh, thr, need, maxN) {
  const N = gw * gh;
  comp.fill(0, 0, N);
  const parts = [null];
  for (let s = 0; s < N; s++) {
    if (comp[s] || !(grid[s] >= thr)) continue;
    const label = parts.length;
    let sp = 0, count = 0, sumY = 0, L = false, Rt = false, Tp = false, Bt = false, adjT = false;
    stack[sp++] = s; comp[s] = label;
    while (sp) {
      const c = stack[--sp], ci = c % gw, cj = (c - ci) / gw;
      count++; sumY += grid[c];
      if (ci === 0) L = true; if (ci === gw - 1) Rt = true; if (cj === 0) Tp = true; if (cj === gh - 1) Bt = true;
      for (let k = 0; k < 4; k++) {
        const nb = k === 0 ? (ci > 0 ? c - 1 : -1) : k === 1 ? (ci < gw - 1 ? c + 1 : -1) : k === 2 ? (cj > 0 ? c - gw : -1) : (cj < gh - 1 ? c + gw : -1);
        if (nb < 0) continue;
        const v = grid[nb];
        if (v < 0) adjT = true;
        else if (!comp[nb] && v >= thr) { comp[nb] = label; stack[sp++] = nb; }
      }
    }
    parts.push({ label, count, Y: sumY / count, L, R: Rt, T: Tp, B: Bt, adjT });
  }
  let best = null;
  for (let k = 1; k < parts.length; k++) {
    const a = parts[k];
    if (a.count < need || a.count > maxN || (a.L && a.R) || (a.T && a.B)) continue;
    // one surface behind the target, seen on both sides of it
    const split = a.adjT && parts.some((b) => b && b !== a && b.adjT && Math.abs(b.Y / a.Y - 1) < 0.15
      && ((a.L && b.R) || (a.R && b.L) || (a.T && b.B) || (a.B && b.T)));
    if (!split && (!best || a.count > best.count)) best = a;
  }
  return best;
}

/** Paper colour at a tapped point: median of the unclipped pixels in a small disc. */
function paperAtPoint(img, at, g) {
  const { width: w, height: h, data } = img;
  const cx = at.x * w, cy = at.y * h, rad = Math.max(2, (at.r || 0.03) * Math.max(w, h));
  const px = [];
  let all = 0, clip = 0;
  for (let y = Math.max(0, Math.floor(cy - rad)); y <= Math.min(h - 1, Math.ceil(cy + rad)); y++) {
    for (let x = Math.max(0, Math.floor(cx - rad)); x <= Math.min(w - 1, Math.ceil(cx + rad)); x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 > rad * rad) continue;
      const p = (y * w + x) * 4;
      all++;
      if (data[p] >= 250 || data[p + 1] >= 250 || data[p + 2] >= 250) { clip++; continue; }
      px.push([LIN[data[p]], LIN[data[p + 1]], LIN[data[p + 2]]]);
    }
  }
  if (px.length < 4) return { found: false, clipped: all > 0 && clip / all > 0.3, manual: true };
  const rgb = median3(px);
  return { found: true, manual: true, rgb, Y: luma(rgb.map((v, k) => v * g[k])), cx: at.x, cy: at.y, r: rad / Math.max(w, h), clipped: clip / all > 0.3, count: px.length };
}

// ------------------------------------------------------------------------------------------
// ① camera only
// ------------------------------------------------------------------------------------------

/**
 * Which surface to take as white. The brightest near-neutral surface of the frame, except when the
 * object looks like it is in a shadow: the white or grey surface next to it is much darker than the
 * frame's brightest (less than half) and the object is darker than that surface. Then the light on
 * the object is the light on its neighbour, so lightness is measured against the neighbour.
 * (Simulation, object in a shadow with a white surface next to it: 18 → 8 ΔE; scenes without a
 * shadow pay 0.3–0.5 ΔE for the times a grey neighbour is taken for a white one in the shade.)
 * @returns {anchor, local: boolean, suspect: boolean}
 */
export function chooseAnchor({ anchor, localAnchor, Y, shadow = 'auto' }) {
  const suspect = !!(anchor && localAnchor && localAnchor.Y < 0.5 * anchor.Y);
  const local = suspect && shadow !== 'off' && (shadow === 'on' || Y < localAnchor.Y);
  return local ? { anchor: { Y: localAnchor.Y, neutral: true, at: localAnchor.at }, local: true, suspect } : { anchor, local: false, suspect };
}

/**
 * Light colour for the object: the frame's white balance, or, when the part of the frame next to
 * the object clearly has other light (a lamp on one side, a window on the other), mostly that.
 * A brightest nearby surface can also just be coloured (a yellow wall), so the difference must look
 * like a difference between two lights: along the warm–cool line of lamps and daylight (blackbody
 * colours), not off it, and larger than a 4500 K vs 6500 K difference. A beige wall next to the
 * object still passes for warm light, so the switch is only half way, and the guide says so.
 * (Synthetic lamp + daylight scene: 10.9 → 5.7 ΔE; simulation scenes with one light: unchanged.)
 * @returns {gains, mixed: boolean, along: number}
 */
export let MIX_ALONG = 0.45, MIX_W = 0.5;
export function setMix(d, w) { MIX_ALONG = d; MIX_W = w; }
const LOCUS = [0.507, -0.862];   // direction of blackbody colours in (log R/G, log B/G), slope ≈ −1.7
export function blendGains(global, local) {
  if (!local || !local.gains || local.spread > 0.12) return { gains: global, mixed: false, along: 0 };
  // light next to the object relative to the frame's light
  const r = global.map((v, k) => v / local.gains[k]);
  const a = Math.log(r[0] / r[1]), b = Math.log(r[2] / r[1]);
  const along = a * LOCUS[0] + b * LOCUS[1], perp = Math.abs(a * -LOCUS[1] + b * LOCUS[0]);
  if (Math.abs(along) < MIX_ALONG || perp > 0.1 + 0.15 * Math.abs(along)) return { gains: global, mixed: false, along };
  const w = MIX_W;
  return { gains: global.map((v, k) => Math.exp((1 - w) * Math.log(v) + w * Math.log(local.gains[k]))), mixed: true, along };
}

/**
 * @param raw  region colour, raw linear (no WB)
 * @param ctx  {gains, mean, anchor, localAnchor, shadow: 'auto'|'off'|'on', anchorRho (the user says what
 *              the white surface really is), sat (chroma factor of the camera at the current noise
 *              level, or null), profile}
 */
export function passiveEstimate(raw, { gains = [1, 1, 1], mean = null, anchor = null, localAnchor = null, shadow = 'auto', anchorRho = null, sat = null, profile = null } = {}) {
  let c = subtractGlare(raw, mean).map((v, k) => v * gains[k]);
  const Y = luma(c);
  const notes = [];
  let conf = 'mid', profiled = false;
  let Yt = Y;
  const pick = chooseAnchor({ anchor, localAnchor, Y, shadow });
  const A = pick.anchor;
  if (A && A.Y > 1e-4) {
    const rho = anchorRho || (A.neutral ? WHITE_RHO : BRIGHT_RHO);
    Yt = Math.min(1, (Y * rho) / A.Y);
    if (anchorRho) notes.push('anchorUser');
    if (!A.neutral && !anchorRho) { conf = 'low'; notes.push('noAnchor'); }
    else if (pick.local) { conf = 'low'; notes.push('shadowLocal'); }
    else if (Y / A.Y < 0.08) notes.push('shadow');
    if (profile) { c = applyProfile(profile, c.map((v) => (v * rho) / A.Y)); profiled = true; }
  } else { conf = 'low'; notes.push('noAnchor'); }
  if (!profiled) c = withLuma(c, Yt);
  if (sat && sat > 0.2) c = resaturate(c, sat);
  return { lin: c, conf, notes, source: 'camera', profiled, anchorLocal: pick.local, shadowSuspect: pick.suspect, anchor: A };
}

// ------------------------------------------------------------------------------------------
// ② white paper / grey card next to the object
// ------------------------------------------------------------------------------------------

export function paperEstimate(raw, { paper, mean = null, rho = WHITE_RHO, sat = null, profile = null }) {
  const c0 = subtractGlare(raw, mean), p = subtractGlare(paper, mean);
  const Yp = luma(p);
  const notes = [];
  if (Yp < 1e-4) return null;
  const g = p.map((v) => clamp(Yp / Math.max(v, 1e-5), 0.5, 2));
  let c = c0.map((v, k) => v * g[k]);
  if (profile) c = applyProfile(profile, c.map((v) => (v * rho) / Yp));
  else c = withLuma(c, Math.min(1, (luma(c) * rho) / Yp));
  if (sat && sat > 0.2) c = resaturate(c, sat);
  return { lin: c, conf: Yp < 0.02 ? 'mid' : 'high', notes, source: 'paper', profiled: !!profile };
}

// ------------------------------------------------------------------------------------------
// ③ torch difference
// ------------------------------------------------------------------------------------------

/**
 * on / off: linear target colour with the torch on / off at the same locked exposure.
 * ref: {on, off} of white paper at the same distance (best), or
 * cal: {white: torch-only colour of white paper at TORCH_DIST, expo: exposureTime×iso at calibration}
 *      with expo = exposureTime×iso now (lightness assumes the same distance as the calibration).
 * anchorY: without paper, the object's lightness from the white anchor (camera only), when the frame
 *      has a white surface. The torch difference then gives only the colour (hue and saturation),
 *      which does not depend on the distance; the anchor gives the lightness, which the torch alone
 *      cannot know. Simulation, objects in normal light: 6.6 (camera only) → 4.0 ΔE.
 */
export function torchEstimate({ on, off, ref = null, cal = null, expo = null, rhoPaper = WHITE_RHO, anchorY = null }) {
  const D = on.map((v, k) => Math.max(0, v - off[k]));
  const ratio = luma(D) / Math.max(luma(off), 1e-5);
  const notes = [];
  let lin, source, conf;
  if (ref) {
    const P = ref.on.map((v, k) => Math.max(1e-5, v - ref.off[k]));
    lin = D.map((v, k) => (v / P[k]) * rhoPaper);
    source = 'torch+paper'; conf = 'high';
  } else if (cal) {
    const scale = cal.expo && expo ? cal.expo / expo : 1;
    lin = D.map((v, k) => (v / Math.max(1e-5, cal.white[k])) * WHITE_RHO * scale);
    if (anchorY > 0) { lin = withLuma(lin, anchorY); source = 'torch+anchor'; conf = 'mid'; notes.push('torchAnchor'); }
    else { source = 'torch'; conf = 'mid'; notes.push('torchDist'); }
  } else return null;
  if (ratio < 1) { notes.push('torchWeak'); conf = 'low'; }
  return { lin, ratio, conf, notes, source };
}

// ------------------------------------------------------------------------------------------
// ④ colour chart
// ------------------------------------------------------------------------------------------

// X-Rite / Macbeth ColorChecker Classic, linear sRGB under D65 (white = 1), computed from the
// BabelColor average spectra (colour-science 0.4.7). Row-major as printed: 1 dark skin … 24 black.
export const CC24_REF = [
  [0.172, 0.0838, 0.0575], [0.5466, 0.2988, 0.2167], [0.1099, 0.1969, 0.3355], [0.1035, 0.1504, 0.052],
  [0.2235, 0.218, 0.4298], [0.1226, 0.5194, 0.4041], [0.7153, 0.1992, 0.027], [0.0643, 0.1064, 0.3922],
  [0.5404, 0.0885, 0.1201], [0.1033, 0.044, 0.1393], [0.3537, 0.5082, 0.0481], [0.7789, 0.3544, 0.0214],
  [0.0232, 0.0492, 0.2915], [0.065, 0.3021, 0.0644], [0.4278, 0.0321, 0.0401], [0.8549, 0.5758, 0.0077],
  [0.5014, 0.0892, 0.3051], [-0.0288, 0.2491, 0.3828], [0.9141, 0.9162, 0.8697], [0.5805, 0.5916, 0.5834],
  [0.3544, 0.3612, 0.3586], [0.1871, 0.1925, 0.1915], [0.0869, 0.0901, 0.0907], [0.032, 0.032, 0.0325],
];

// Printable card (2 × 7 patches): 6 greys then 8 colours; values are the sRGB the card is printed
// with. A real print differs from these (paper, ink, printer) by ~3 ΔE unless calibrated once
// against a ColorChecker (printCalibration below).
export const PRINT_CARD_SRGB = [
  [242, 242, 242], [191, 191, 191], [140, 140, 140], [97, 97, 97], [56, 56, 56], [20, 20, 20], [204, 38, 38],
  [38, 153, 51], [38, 64, 179], [242, 204, 26], [217, 51, 166], [26, 166, 191], [242, 128, 26], [204, 153, 128],
];

export const CHARTS = {
  cc24: { rows: 4, cols: 6, neutral: [18, 19, 20, 21, 22, 23], ref: CC24_REF },
  print14: { rows: 2, cols: 7, neutral: [0, 1, 2, 3, 4, 5], ref: PRINT_CARD_SRGB.map((c) => toLinear(...c)) },
};

/** 3×3 homography mapping 4 source points to 4 destination points ([[x,y]×4]). */
export function homography(src, dst) {
  const A = [], bv = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); bv.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); bv.push(v);
  }
  const hv = solve(A, bv);
  if (!hv) return null;
  return [...hv, 1];
}
export function applyH(H, x, y) {
  const d = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / d, (H[3] * x + H[4] * y + H[5]) / d];
}
function solve(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / r[i]);
}

/** Patch centres from the centres of the 4 corner patches, given as [TL, TR, BR, BL]. */
export function patchCenters(corners, rows, cols) {
  const H = homography([[0, 0], [cols - 1, 0], [cols - 1, rows - 1], [0, rows - 1]], corners);
  if (!H) return null;
  const pts = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) pts.push(applyH(H, c, r));
  return pts;
}

/**
 * Fit "camera linear RGB -> true linear sRGB" from measured chart patches.
 * Per-channel monotone tone curve through the neutral patches, then a white-preserving
 * root-polynomial transform (Finlayson, Mackiewicz & Hurlbert 2015: r, g, b, √rg, √gb, √rb). It
 * scales with exposure like a 3×3 matrix but also bends for the camera's non-linear colour
 * processing: in simulation the median error on colours not on the chart drops from 2.4 to 1.7 ΔE
 * (ColorChecker) and from 3.8 to 3.3 (printed card) compared with a 3×3 matrix.
 * Least squares weighted towards dark patches (the eye sees their differences more), with a small
 * ridge on the cross terms, and each row summing to 1 so that a grey input stays grey.
 * Returns {apply(lin), residual (median ΔE2000 over patches), sat (camera chroma factor), lut} or null.
 */
export function fitChart(meas, ref, neutralIdx) {
  if (meas.length !== ref.length || meas.some((m) => !m || m.some((v) => !Number.isFinite(v)))) return null;
  const ny = neutralIdx.map((i) => (ref[i][0] + ref[i][1] + ref[i][2]) / 3);
  const order = neutralIdx.map((_, k) => k).sort((a, b) => ny[a] - ny[b]);
  const luts = [];
  for (let c = 0; c < 3; c++) {
    const xs = [0], ys = [0];
    let last = 0;
    for (const k of order) {
      const x = Math.max(last + 1e-5, meas[neutralIdx[k]][c]);
      xs.push(x); ys.push(ny[k]); last = x;
    }
    // proportional extension above the brightest grey
    xs.push(last * 4); ys.push(ys[ys.length - 1] * 4);
    luts.push({ xs, ys });
  }
  const lut = (lin) => [lutAt(luts[0], lin[0]), lutAt(luts[1], lin[1]), lutAt(luts[2], lin[2])];
  const X = meas.map(lut);
  const F = X.map(rootPoly);
  const P = 6;
  // normal equations, shared by the three output channels
  const A = Array.from({ length: P + 1 }, () => new Array(P + 1).fill(0));
  const rhs = [0, 1, 2].map(() => new Array(P + 1).fill(0));
  for (let i = 0; i < F.length; i++) {
    const wgt = 1 / (luma(ref[i]) + 0.02), f = F[i];
    for (let a = 0; a < P; a++) {
      for (let c = 0; c < P; c++) A[a][c] += wgt * f[a] * f[c];
      for (let r = 0; r < 3; r++) rhs[r][a] += wgt * f[a] * ref[i][r];
    }
  }
  for (let a = 3; a < P; a++) A[a][a] += 0.01;          // ridge on the cross terms only
  for (let a = 0; a < P; a++) { A[a][P] = 1; A[P][a] = 1; } // Lagrange row: coefficients sum to 1
  const M = [];
  for (let r = 0; r < 3; r++) {
    rhs[r][P] = 1;
    const m = solve(A, rhs[r]);
    if (!m || m.some((v) => !Number.isFinite(v))) return null;
    M.push(m.slice(0, P));
  }
  const apply = (lin) => chartTransform(luts, M, lin);
  const des = meas.map((m, i) => deltaELin(apply(m), ref[i]));
  const residual = percentile(des, 0.5);
  // camera chroma factor (for calibrating the low-light desaturation of the camera-only estimate)
  let num = 0, den = 0;
  for (let i = 0; i < X.length; i++) {
    if (neutralIdx.includes(i)) continue;
    const Yr = luma(ref[i]), Ym = luma(X[i]);
    for (let k = 0; k < 3; k++) { num += (X[i][k] - Ym) * (ref[i][k] - Yr); den += (ref[i][k] - Yr) ** 2; }
  }
  const sat = den > 0 ? num / den : 1;
  return { apply, residual, sat, matrix: M, lut, luts };
}
function lutAt({ xs, ys }, v) {
  if (v <= xs[0]) return ys[0];
  for (let i = 1; i < xs.length; i++) {
    if (v <= xs[i]) return ys[i - 1] + ((v - xs[i - 1]) / (xs[i] - xs[i - 1])) * (ys[i] - ys[i - 1]);
  }
  const n = xs.length;
  return ys[n - 1] + ((v - xs[n - 1]) / (xs[n - 1] - xs[n - 2])) * (ys[n - 1] - ys[n - 2]);
}
function chartTransform(luts, M, lin) {
  const f = rootPoly([lutAt(luts[0], lin[0]), lutAt(luts[1], lin[1]), lutAt(luts[2], lin[2])]);
  return [0, 1, 2].map((r) => { const m = M[r]; return m[0] * f[0] + m[1] * f[1] + m[2] * f[2] + m[3] * f[3] + m[4] * f[4] + m[5] * f[5]; });
}
function rootPoly(x) {
  const r = x[0] > 0 ? x[0] : 0, g = x[1] > 0 ? x[1] : 0, b = x[2] > 0 ? x[2] : 0;
  return [r, g, b, Math.sqrt(r * g), Math.sqrt(g * b), Math.sqrt(r * b)];
}

/**
 * Corner taps can come in any order and the card can be rotated or upside down: try the 8 ways of
 * assigning the taps to the chart's corners and keep the one whose fit is best.
 * @param taps     4 points (any order, frame coordinates)
 * @param sample   (x, y, radius) -> raw linear colour or null
 * @param chart    entry of CHARTS (or {rows, cols, neutral, ref})
 */
export function orientAndFit(taps, sample, chart) {
  if (!taps || taps.length !== 4) return null;
  const cx = taps.reduce((s, p) => s + p[0], 0) / 4, cy = taps.reduce((s, p) => s + p[1], 0) / 4;
  const ring = taps.slice().sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
  let best = null;
  for (let rot = 0; rot < 4; rot++) {
    for (const dir of [1, -1]) {
      const corners = [0, 1, 2, 3].map((k) => ring[(rot + dir * k + 8) % 4]);
      const pts = patchCenters(corners, chart.rows, chart.cols);
      if (!pts) continue;
      const step = Math.min(dist(pts[0], pts[1]), dist(pts[0], pts[chart.cols]));
      const meas = pts.map(([x, y]) => sample(x, y, 0.28 * step));
      if (meas.some((m) => !m)) continue;
      const fit = fitChart(meas, chart.ref, chart.neutral);
      if (fit && (!best || fit.residual < best.fit.residual)) best = { fit, corners, pts, meas, step };
    }
  }
  return best;
}
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function chartEstimate(raw, fit, residual) {
  const lin = fit.apply(raw);
  const notes = [];
  if (residual > 4) notes.push('chartPoor');
  return { lin, conf: residual <= 3 ? 'high' : residual <= 6 ? 'mid' : 'low', notes, source: 'chart' };
}

/** True colours of the printed card's patches, measured through a ColorChecker fit in the same frame. */
export function printCalibration(ccFit, printMeas) {
  return printMeas.map((m) => ccFit.apply(m));
}

// ------------------------------------------------------------------------------------------
// camera profile: a chart fit in good light, kept per camera, for the paper and camera-only sources
// ------------------------------------------------------------------------------------------
//
// The chart's patches relative to its white patch give the camera's own colour processing (tone
// curve, saturation, hue shifts) independent of the light level and colour. Later, a colour relative
// to white paper (or to the white anchor) goes through the same transform. Simulated phone, chart
// photos at 300, 30 and 3 lx: paper source 4.3 → 3.5 ΔE, camera only 7.2 → 6.3 (medians over all
// light levels, three simulation runs); unchanged at levels no chart was taken at. Plain data.

/** Profile from chart measurements (raw linear, in chart order) and the chart's reference colours. */
export function makeProfile(meas, chart, noise) {
  const ref = chart.ref;
  const wi = chart.neutral.reduce((a, b) => (luma(ref[b]) > luma(ref[a]) ? b : a));
  const w = meas[wi];
  if (!w || w.some((v) => !(v > 1e-4))) return null;
  const fit = fitChart(meas.map((m) => m.map((v, k) => (v / w[k]) * ref[wi][k])), ref, chart.neutral);
  if (!fit) return null;
  const r5 = (v) => Math.round(v * 1e5) / 1e5;
  return {
    white: ref[wi].map(r5), luts: fit.luts.map(({ xs, ys }) => ({ xs: xs.map(r5), ys: ys.map(r5) })),
    M: fit.matrix.map((row) => row.map(r5)), sat: r5(fit.sat), residual: Math.round(fit.residual * 100) / 100,
    noise: Number.isFinite(noise) ? noise : null, at: Date.now(),
  };
}

/** A colour relative to white (a white surface of reflectance ρ reads ρ in every channel) through the profile. */
export function applyProfile(prof, rel) {
  const wY = luma(prof.white);
  return chartTransform(prof.luts, prof.M, rel.map((v, k) => (v * prof.white[k]) / wY));
}

// ------------------------------------------------------------------------------------------
// saturation calibration: chart fits record (noise index, chroma factor) pairs per camera
// ------------------------------------------------------------------------------------------

export function addSatPoint(table, noise, sat) {
  if (!Number.isFinite(noise) || !Number.isFinite(sat) || noise <= 0 || sat < 0.2 || sat > 2) return table || [];
  const t = (table || []).filter(([n]) => Math.abs(Math.log(n / noise)) > 0.15);
  t.push([noise, sat]);
  t.sort((a, b) => a[0] - b[0]);
  return t.slice(-10);
}

/** Interpolated chroma factor at a noise level (log scale), or null without nearby calibration. */
export function satAt(table, noise) {
  if (!table || !table.length || !Number.isFinite(noise) || noise <= 0) return null;
  const ln = Math.log(noise);
  if (table.length === 1) return Math.abs(ln - Math.log(table[0][0])) < 0.7 ? table[0][1] : null;
  const pts = table.map(([n, s]) => [Math.log(n), s]);
  if (ln <= pts[0][0]) return ln > pts[0][0] - 0.7 ? pts[0][1] : null;
  if (ln >= pts[pts.length - 1][0]) return ln < pts[pts.length - 1][0] + 0.7 ? pts[pts.length - 1][1] : null;
  for (let i = 1; i < pts.length; i++) {
    if (ln <= pts[i][0]) {
      const gap = pts[i][0] - pts[i - 1][0], t = (ln - pts[i - 1][0]) / gap;
      // saturation stays flat in good light and drops quickly in dim light, so a straight line
      // across a wide gap is a poor guess: only interpolate between levels at most 4× apart
      if (gap > Math.log(4)) {
        const d0 = ln - pts[i - 1][0], d1 = pts[i][0] - ln;
        return d0 <= d1 ? (d0 < 0.7 ? pts[i - 1][1] : null) : (d1 < 0.7 ? pts[i][1] : null);
      }
      return pts[i - 1][1] + t * (pts[i][1] - pts[i - 1][1]);
    }
  }
  return null;
}

/**
 * What the saved calibration of a camera ({sat: table, profile}) gives at the current noise level:
 * {profile, sat} for paperEstimate / passiveEstimate. The profile carries the camera's saturation at
 * its own light level, so with a saturation table the remaining change is sat(now) / sat(profile).
 * Without one, the profile is only used near the light level it was made at: in dim light cameras
 * desaturate, and the good-light profile alone would take even more colour out.
 */
export function calibrationFor(cal, noise, { defaultSat = false } = {}) {
  let sat = cal ? satAt(cal.sat, noise) : null, satFrom = sat ? 'chart' : null;
  if (!sat && defaultSat) { sat = defaultSatAt(noise); satFrom = sat ? 'default' : null; }
  const pf = cal && cal.profile;
  if (pf && pf.noise > 0 && Number.isFinite(noise) && noise > 0) {
    if (sat) return { profile: pf, sat: sat / (satFrom === 'default' ? defaultSatAt(pf.noise) || 1 : pf.sat), satFrom };
    if (Math.abs(Math.log(noise / pf.noise)) < 0.7) return { profile: pf, sat: null, satFrom: null };
  }
  return { profile: null, sat, satFrom };
}

/**
 * Optional default for cameras without a chart calibration: in the simulation the phone keeps its
 * full saturation down to ~30 lux and has ~65 % of it at 3 lux. Our noise index for those light
 * levels is a guess (about 3e-5 and 1e-3), and phones differ, so only half the loss is put back
 * and the switch is off by default; the validation mode shows whether it helps on a given phone.
 */
export const DEFAULT_SAT = [[3e-5, 1], [1e-3, 0.65]];
export function defaultSatAt(noise) {
  if (!Number.isFinite(noise) || noise <= 0) return null;
  const [[n0, s0], [n1, s1]] = DEFAULT_SAT;
  const t = Math.max(0, Math.min(1, Math.log(noise / n0) / Math.log(n1 / n0)));
  const full = s0 + t * (s1 - s0);
  const s = 1 - 0.5 * (1 - full);
  return s < 0.995 ? s : null;
}

// ------------------------------------------------------------------------------------------
// how sure: perturb the estimate within its typical error and see whether the colour name changes
// ------------------------------------------------------------------------------------------

/**
 * Typical error of each source as a factor on lightness (Y) and on saturation (chroma), log scale:
 * the median error of that source in the simulation (camera only: ±35 % lightness, ±28 % saturation).
 */
export const UNCERT = {
  camera: [0.3, 0.25], cameraNoAnchor: [0.45, 0.25], cameraLocal: [0.8, 0.28], paper: [0.12, 0.2], paperCal: [0.1, 0.12],
  'torch+paper': [0.06, 0.09], 'torch+anchor': [0.3, 0.09], torch: [0.5, 0.09], chart: [0.03, 0.06], print: [0.07, 0.1], printCal: [0.05, 0.08],
};

/** [dL, dC] for an estimate (see trueEstimate in main.js for the fields). */
export function uncertaintyOf(est, { residual = null, calibrated = false } = {}) {
  const s = est.source;
  if (s === 'camera') return est.anchorLocal ? UNCERT.cameraLocal : (est.notes || []).includes('noAnchor') ? UNCERT.cameraNoAnchor : UNCERT.camera;
  if (s === 'paper') return calibrated || est.profiled ? UNCERT.paperCal : UNCERT.paper;
  if ((s === 'chart' || s === 'print' || s === 'printCal') && residual) {
    const [l, c] = UNCERT[s], k = Math.max(1, residual / 1.5);
    return [l * k, c * k];
  }
  return UNCERT[s] || UNCERT.camera;
}

/**
 * Basic colour names over the 3 × 3 grid of lightness × saturation within the typical error.
 * @returns {main, alt, votes, cause: 'light'|'sat'|'both'} or null when one name covers the grid
 *   (alt wins at least 2 of the 8 perturbed versions)
 */
export function nameAmbiguity(lin, [dL, dC]) {
  const name = (c) => classifyBasic(...linToSrgb8(c));
  const main = name(lin);
  const Y = luma(lin);
  const votes = {}, how = {};
  for (const fl of [-1, 0, 1]) for (const fc of [-1, 0, 1]) {
    if (!fl && !fc) continue;
    const kL = Math.exp(fl * dL), kC = Math.exp(fc * dC);
    const c = lin.map((v) => Math.max(0, (Y + (v - Y) * kC) * kL));
    const n = name(c);
    if (n === main) continue;
    votes[n] = (votes[n] || 0) + 1;
    (how[n] ||= new Set()).add(fl && fc ? 'both' : fl ? 'light' : 'sat');
  }
  const alt = Object.keys(votes).sort((a, b) => votes[b] - votes[a])[0];
  if (!alt || votes[alt] < 2) return null;
  const h = how[alt];
  const cause = h.has('light') && !h.has('sat') ? 'light' : h.has('sat') && !h.has('light') ? 'sat' : h.has('light') ? 'light' : 'both';
  return { main, alt, votes: votes[alt], cause };
}

// ------------------------------------------------------------------------------------------
// the same transform for every pixel (GPU): true-colour picture for correction mode and preview
// ------------------------------------------------------------------------------------------

/**
 * Per-pixel version of the camera-only, paper and chart estimates (not the torch: that measures one
 * object). In the shader: c = max(raw − glare, 0) × gain; then, with a profile or chart fit,
 * the per-channel tone curve and the root-polynomial transform; then the saturation correction.
 * @param kind 'camera' | 'paper' | 'chart'
 * @returns {glare, gain, luts|null, M|null, sat} or null
 */
export function gpuParams(kind, o) {
  const mean = o.mean || [0, 0, 0];
  if (kind === 'chart') return o.fit ? { glare: [0, 0, 0], gain: [1, 1, 1], luts: o.fit.luts, M: o.fit.matrix, sat: 1 } : null;
  const glare = mean.map((v) => GLARE * v);
  let gain;
  if (kind === 'paper') {
    const p = subtractGlare(o.paper, mean), Yp = luma(p);
    if (Yp < 1e-4) return null;
    const rho = o.rho || WHITE_RHO;
    gain = p.map((v) => clamp(Yp / Math.max(v, 1e-5), 0.5, 2) * (rho / Yp));
  } else {
    const A = o.anchor;
    if (!A || !(A.Y > 1e-4)) return null;
    const rho = o.anchorRho || (A.neutral ? WHITE_RHO : BRIGHT_RHO);
    gain = o.gains.map((g) => (g * rho) / A.Y);
  }
  const pf = o.profile;
  if (pf) { const wY = luma(pf.white); gain = gain.map((v, k) => (v * pf.white[k]) / wY); }
  return { glare, gain, luts: pf ? pf.luts : null, M: pf ? pf.M : null, sat: o.sat && o.sat > 0.2 ? o.sat : 1 };
}

/** What the shader does with gpuParams, for tests. */
export function applyGpuParams(P, raw) {
  let c = raw.map((v, k) => Math.max(0, v - P.glare[k]) * P.gain[k]);
  if (P.luts) c = chartTransform(P.luts, P.M, c);
  if (P.sat !== 1) c = resaturate(c, P.sat);
  return c.map((v) => clamp(v, 0, 1));
}

// ------------------------------------------------------------------------------------------
// validation on a real phone: a ColorChecker in the frame is a set of 24 known colours
// ------------------------------------------------------------------------------------------

/**
 * Score every source on the 24 patches of a ColorChecker photographed with this phone.
 * The chart itself is scored leave-one-out (fit on the other 23, predict the one left out).
 * White paper: the real sheet when one is in the picture, otherwise the chart's own white patch.
 * @param meas  raw linear colours of the 24 patches (chart order)
 * @param ctx   {gains, mean, anchor, localAnchor, paper (raw rgb) | null, rho, calib: {profile, sat},
 *               defaultSat: chroma factor of the default curve now (or null)}
 * @returns {rows: [{i, truth, est: {source: lin}}], summary: {source: {n, median, p90, names}}, paperFrom}
 */
export function validateChart(meas, ctx) {
  const ref = CC24_REF, neutral = CHARTS.cc24.neutral, WHITE = 18;
  const nameOf = (c) => classifyBasic(...linToSrgb8(c));
  const paperFrom = ctx.paper ? 'sheet' : 'chart';
  const paper = ctx.paper || meas[WHITE], rho = ctx.paper ? ctx.rho || WHITE_RHO : luma(ref[WHITE]);
  const rows = [];
  for (let i = 0; i < 24; i++) {
    const est = {};
    est.picture = meas[i].map((v, k) => Math.min(1, v * ctx.gains[k]));
    const keep = ref.map((_, k) => k).filter((k) => k !== i);
    const fit = fitChart(keep.map((k) => meas[k]), keep.map((k) => ref[k]), neutral.filter((k) => k !== i).map((k) => (k > i ? k - 1 : k)));
    if (fit) est.chart = fit.apply(meas[i]);
    if (!(paperFrom === 'chart' && i === WHITE)) {
      const pe = paperEstimate(meas[i], { paper, mean: ctx.mean, rho, ...(ctx.calib || {}) });
      if (pe) est.paper = pe.lin;
    }
    est.camera = passiveEstimate(meas[i], { gains: ctx.gains, mean: ctx.mean, anchor: ctx.anchor, localAnchor: ctx.localAnchor, ...(ctx.calib || {}) }).lin;
    if (ctx.defaultSat && !(ctx.calib && ctx.calib.sat)) {
      est.cameraDefaultSat = passiveEstimate(meas[i], { gains: ctx.gains, mean: ctx.mean, anchor: ctx.anchor, localAnchor: ctx.localAnchor, sat: ctx.defaultSat }).lin;
    }
    rows.push({ i, truth: ref[i], est });
  }
  const summary = {};
  for (const src of ['picture', 'camera', 'cameraDefaultSat', 'paper', 'chart']) {
    const de = [], ok = [];
    for (const r of rows) {
      const e = r.est[src];
      if (!e) continue;
      de.push(deltaELin(e.map((v) => clamp(v, 0, 1)), r.truth));
      ok.push(nameOf(e.map((v) => clamp(v, 0, 1))) === nameOf(r.truth));
    }
    if (!de.length) continue;
    const s = de.slice().sort((a, b) => a - b);
    summary[src] = { n: de.length, median: s[(s.length - 1) >> 1], p90: s[Math.floor(0.9 * (s.length - 1))], names: ok.filter(Boolean).length };
  }
  return { rows, summary, paperFrom };
}

// ------------------------------------------------------------------------------------------
// printable card (SVG, real size in mm)
// ------------------------------------------------------------------------------------------

export function printCardSVG({ title = '色觉助手 · 自印色卡 / Color Vision Helper card', note = '' } = {}) {
  const P = 24, G = 4, M = 12, cols = 7, rows = 2;
  const W = M * 2 + cols * P + (cols - 1) * G, Hh = M * 2 + rows * P + (rows - 1) * G + 22;
  const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}mm" height="${Hh}mm" viewBox="0 0 ${W} ${Hh}">`;
  s += `<rect width="${W}" height="${Hh}" fill="#ffffff"/>`;
  PRINT_CARD_SRGB.forEach((c, i) => {
    const r = Math.floor(i / cols), k = i % cols;
    s += `<rect x="${M + k * (P + G)}" y="${M + r * (P + G)}" width="${P}" height="${P}" fill="${hex(c)}"/>`;
  });
  // corner marks show where to tap (centres of the four corner patches)
  for (const [k, r] of [[0, 0], [cols - 1, 0], [cols - 1, rows - 1], [0, rows - 1]]) {
    const x = M + k * (P + G) + P / 2, y = M + r * (P + G) + P / 2;
    s += `<circle cx="${x}" cy="${y}" r="1.2" fill="none" stroke="#808080" stroke-width="0.35"/>`;
  }
  const ty = M + rows * P + (rows - 1) * G + 9;
  s += `<text x="${M}" y="${ty}" font-family="sans-serif" font-size="4" fill="#333">${title}</text>`;
  if (note) s += `<text x="${M}" y="${ty + 6}" font-family="sans-serif" font-size="3" fill="#555">${note}</text>`;
  return s + '</svg>';
}

/** Short label for a confidence level and the typical error of each source (simulation medians). */
export const TYPICAL_DE = { camera: 5, paper: 4, torch: 5, 'torch+paper': 2, chart: 1.7, print: 3.3 };
