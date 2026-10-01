// Automatic white balance for colour naming ("gray-pixel" illuminant estimation).
//
// Phone cameras already run their own auto white balance, but under warm indoor light they
// often keep a deliberate yellow cast (to look "cosy"), and they get confused when one big
// coloured object fills the view. We estimate the remaining cast from pixels that are close
// to neutral (white walls, paper, gray floors, metal), which in a real scene are the only
// pixels whose colour mostly reflects the light rather than the object:
//
//  pass 0: "bright gray world": the brightest 15 % of usable pixels (white surfaces and
//          specular highlights reflect the light's colour; a dominant object colour does not)
//  pass 1: pixels that look nearly gray after that rough correction  -> illuminant
//  pass 2: re-select with a tighter gray threshold                    -> refined illuminant
//
// Pixels inside the object currently being measured are excluded, so the thing you point at
// never "corrects itself away". When too few gray pixels exist the caller keeps the previous
// estimate. Gains are clamped and applied at 80 % strength (a beige wall can pass for gray).
import { LIN } from './color.js';

const CLAMP = [0.67, 1.5];
const STRENGTH = 0.8;

function pass(data, w, h, step, exclude, g, satMax, minY = 0.035) {
  let sr = 0, sg = 0, sb = 0, sw = 0, cnt = 0, total = 0;
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = y * w + x;
      if (exclude && exclude[i] > 0.3) continue;
      total++;
      const p = i * 4;
      const r = LIN[data[p]], gg = LIN[data[p + 1]], b = LIN[data[p + 2]];
      const mx0 = Math.max(r, gg, b);
      if (mx0 > 0.94) continue; // clipped: colour unknown
      const Y = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
      if (Y < minY) continue;  // too dark / noisy
      const rc = r * g[0], gc = gg * g[1], bc = b * g[2];
      const mx = Math.max(rc, gc, bc), mn = Math.min(rc, gc, bc);
      if ((mx - mn) / mx > satMax) continue;
      const wt = Math.sqrt(Y);
      sr += (r / Y) * wt; sg += (gg / Y) * wt; sb += (b / Y) * wt; sw += wt; cnt++;
    }
  }
  if (!sw) return { illum: null, frac: 0, total };
  let il = [sr / sw, sg / sw, sb / sw];
  const Yi = 0.2126 * il[0] + 0.7152 * il[1] + 0.0722 * il[2];
  il = il.map((v) => v / Yi);
  return { illum: il, frac: total ? cnt / total : 0, total };
}

/** Luminance above which the brightest 15 % of usable pixels lie. */
function brightThreshold(data, w, h, step, exclude) {
  const ys = [];
  for (let y = 0; y < h; y += step * 2) for (let x = 0; x < w; x += step * 2) {
    const i = y * w + x;
    if (exclude && exclude[i] > 0.3) continue;
    const p = i * 4, r = LIN[data[p]], g = LIN[data[p + 1]], b = LIN[data[p + 2]];
    if (Math.max(r, g, b) > 0.94) continue;
    ys.push(0.2126 * r + 0.7152 * g + 0.0722 * b);
  }
  if (!ys.length) return 0.035;
  ys.sort((a, b) => a - b);
  return Math.max(0.035, ys[Math.floor(ys.length * 0.85)]);
}

/**
 * Estimate white-balance gains from an RGBA frame.
 * @param exclude optional Float32Array mask (same w×h) of pixels to ignore (the measured object)
 * @returns {{ok:boolean, gains:number[], frac:number, cast:string|null}}
 */
export function estimateWB(data, w, h, exclude = null) {
  const step = w * h > 40000 ? 2 : 1;
  const p0 = pass(data, w, h, step, exclude, [1, 1, 1], 0.6, brightThreshold(data, w, h, step, exclude));
  if (!p0.illum || p0.total < 200) return { ok: false, gains: [1, 1, 1], frac: 0, cast: null };
  const g0 = p0.illum.map((v) => Math.max(CLAMP[0], Math.min(CLAMP[1], 1 / v)));
  const p1 = pass(data, w, h, step, exclude, g0, 0.25);
  if (!p1.illum || p1.frac < 0.02) return { ok: false, gains: [1, 1, 1], frac: p1.frac, cast: null };
  const g1 = p1.illum.map((v) => 1 / v);
  const p2 = pass(data, w, h, step, exclude, g1, 0.12);
  const il = p2.illum && p2.frac >= 0.012 ? p2.illum : p1.illum;
  // confidence: few gray pixels -> weaker correction
  const frac = p2.frac || p1.frac;
  const strength = STRENGTH * Math.max(0, Math.min(1, (frac - 0.01) / 0.04));
  let gains = il.map((v) => 1 + strength * (1 / v - 1));
  gains = gains.map((v) => Math.max(CLAMP[0], Math.min(CLAMP[1], v)));
  return { ok: strength > 0, gains, frac, cast: describeCast(il) };
}

/** Name the colour cast of an illuminant estimate (luminance-normalised RGB). */
export function describeCast(il) {
  const rb = il[0] / il[2];
  const gm = il[1] / Math.sqrt(il[0] * il[2]);
  if (rb > 1.22) return 'warm';
  if (rb < 0.84) return 'cool';
  if (gm > 1.08) return 'green';
  if (gm < 0.93) return 'magenta';
  return null;
}

/** Gains that turn a sampled reference (linear RGB) into neutral gray of the same luminance. */
export function gainsFromReference(lin) {
  const Y = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  return lin.map((v) => Math.max(0.5, Math.min(2, Y / Math.max(1e-4, v))));
}

/** Cast of a set of gains (inverse of the illuminant). */
export function castOfGains(g) {
  return describeCast(g.map((v) => 1 / v));
}
