// Color-region segmentation around the reticle, built for real camera scenes.
//
// Real objects are not flat color patches: they have shading (one side darker), texture
// (fabric, wood, fur, foliage), specular highlights and sensor noise, and they sit next to
// other objects of similar color. The pipeline therefore works like this:
//
// 1. Downscaled frame -> OKLab (after white-balance gains) -> 3×3 box blur, twice.
// 2. Shading-invariant chromaticity: scaling linear RGB by k (a shadow) scales OKLab L, a and
//    b by the same factor k^(1/3), so (a/L, b/L) does not change under shading.
// 3. Object colour model: across one real object the HUE of that chromaticity is the most
//    stable cue; saturation drops in highlights (specular white is added) and in deep shadow,
//    and lightness varies with shading. So for coloured seeds the chromaticity difference is
//    split into a tangential part (hue change, tight tolerance) and a radial part (saturation
//    change, looser — especially towards less saturated), plus a loose log-lightness term.
//    A neighbouring object of similar hue but a different hue angle AND saturation (red cup on
//    an orange-brown table) is rejected, while the glare on the cup is accepted.
//    Neutral seeds (white / gray / black) use plain chromaticity distance plus a strong
//    lightness term.
// 4. Adaptive tolerance: the robust spread (MAD of inliers) of each term in a small disc
//    around the seed measures surface texture, so fabric, wood or fur widen the tolerance
//    automatically, while a seed next to an edge does not (outliers are excluded).
//    The user's "range" multiplies all tolerances.
// 5. 4-connected region growing against the seed statistics.
// 6. Opening (cuts 1–2 px bridges along which regions leak into look-alike neighbours),
//    keep the component containing the seed, closing, fill holes (glare, logos, specks).
// 7. Temporal smoothing + marching squares for a smooth sub-pixel contour.
// 8. A robust "body colour" of the region (median chromaticity at median lightness,
//    ignoring the brightest and darkest parts) for naming, so the name describes the whole
//    object rather than a few noisy pixels under the reticle.
import { LIN, oklabToLinRgb, linearToSrgb } from './color.js';

const K = 0.04;    // softening constant in a/(L+K): keeps very dark pixels from exploding
const LOFF = 0.02; // offset in ln(L+LOFF)

function medianOf(arr, n) {
  const a = Array.from(arr.subarray ? arr.subarray(0, n) : arr.slice(0, n)).sort((x, y) => x - y);
  return n ? a[n >> 1] : 0;
}

// ---- the region-size slider (0..1) → tolerance multiplier "sens" ----
// Geometric in both halves, so each step changes the tolerance by the same factor and small
// regions get as much of the track as large ones. The middle (the default) is 0.224, which was
// the value at 20 % of the v1.2–v1.3 slider: users found the old middle (0.61) too loose.
export const SENS_MIN = 0.1, SENS_MID = 0.224, SENS_MAX = 2.0;
export function rangeToSens(p) {
  p = Math.max(0, Math.min(1, p));
  return p <= 0.5 ? SENS_MIN * (SENS_MID / SENS_MIN) ** (p / 0.5) : SENS_MID * (SENS_MAX / SENS_MID) ** ((p - 0.5) / 0.5);
}
export function sensToRange(v) {
  v = Math.max(SENS_MIN, Math.min(SENS_MAX, v));
  return v <= SENS_MID ? 0.5 * Math.log(v / SENS_MIN) / Math.log(SENS_MID / SENS_MIN)
    : 0.5 + 0.5 * Math.log(v / SENS_MID) / Math.log(SENS_MAX / SENS_MID);
}

export class Segmenter {
  constructor() {
    this.w = 0; this.h = 0;
    this.prevSeed = null;
  }

  _alloc(w, h) {
    if (w === this.w && h === this.h) return;
    const n = w * h;
    this.w = w; this.h = h;
    this.L = new Float32Array(n); this.A = new Float32Array(n); this.B = new Float32Array(n);
    this.al = new Float32Array(n); this.be = new Float32Array(n); this.lam = new Float32Array(n);
    this.tmp = new Float32Array(n);
    this.mask = new Uint8Array(n);
    this.mask2 = new Uint8Array(n);
    this.queue = new Int32Array(n);
    this.soft = new Float32Array(n);
    this.prevSoft = new Float32Array(n);
    this.segs = new Float32Array(n * 2); // grows if needed
    this.sv = new Float32Array(4096); // scratch for statistics
    this.hasPrev = false;
  }

  /** RGBA pixels -> OKLab planes (white-balance gains applied in linear RGB). */
  _toLab(data, gains) {
    const n = this.w * this.h;
    const { L, A, B } = this;
    const gr = gains ? gains[0] : 1, gg = gains ? gains[1] : 1, gb = gains ? gains[2] : 1;
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const r = Math.min(1, LIN[data[p]] * gr), g = Math.min(1, LIN[data[p + 1]] * gg), b = Math.min(1, LIN[data[p + 2]] * gb);
      const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
      const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
      const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
      L[i] = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
      A[i] = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
      B[i] = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
    }
  }

  /** Separable 5×5 box blur in place (edges clamped) — one pass ≈ two 3×3 passes. */
  _blur5(src) {
    const { w, h, tmp } = this;
    for (let y = 0; y < h; y++) {
      const o = y * w;
      for (let x = 0; x < w; x++) {
        const x0 = x > 1 ? x - 2 : 0, x1 = x > 0 ? x - 1 : 0, x3 = x < w - 1 ? x + 1 : w - 1, x4 = x < w - 2 ? x + 2 : w - 1;
        tmp[o + x] = (src[o + x0] + src[o + x1] + src[o + x] + src[o + x3] + src[o + x4]) * 0.2;
      }
    }
    for (let y = 0; y < h; y++) {
      const y0 = (y > 1 ? y - 2 : 0) * w, y1 = (y > 0 ? y - 1 : 0) * w, o = y * w;
      const y3 = (y < h - 1 ? y + 1 : h - 1) * w, y4 = (y < h - 2 ? y + 2 : h - 1) * w;
      for (let x = 0; x < w; x++) src[o + x] = (tmp[y0 + x] + tmp[y1 + x] + tmp[o + x] + tmp[y3 + x] + tmp[y4 + x]) * 0.2;
    }
  }

  /** Separable 3x3 box blur in place (edges clamped). */
  _blur(src) {
    const { w, h, tmp } = this;
    for (let y = 0; y < h; y++) {
      const o = y * w;
      for (let x = 0; x < w; x++) {
        const xl = x > 0 ? x - 1 : x, xr = x < w - 1 ? x + 1 : x;
        tmp[o + x] = (src[o + xl] + src[o + x] + src[o + xr]) / 3;
      }
    }
    for (let y = 0; y < h; y++) {
      const yu = (y > 0 ? y - 1 : y) * w, yd = (y < h - 1 ? y + 1 : y) * w, o = y * w;
      for (let x = 0; x < w; x++) src[o + x] = (tmp[yu + x] + tmp[o + x] + tmp[yd + x]) / 3;
    }
  }

  /** Seed colour (median) and inlier texture spread of each distance term in a disc. */
  _seedStats(sx, sy, r) {
    const { w, h, al, be, lam, A, B, L, sv } = this;
    const idx = [];
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r * r) continue;
      const x = sx + dx, y = sy + dy;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      idx.push(y * w + x);
    }
    // centre statistics from the inner disc (radius 2) so an edge nearby does not shift them
    const inner = idx.filter((i) => { const x = i % w, y = (i - x) / w; return (x - sx) ** 2 + (y - sy) ** 2 <= 4; });
    const med = (plane, list) => { for (let k = 0; k < list.length; k++) sv[k] = plane[list[k]]; return medianOf(sv, list.length); };
    const ma = med(al, inner), mb = med(be, inner), ml = med(lam, inner);
    const mA = med(A, inner), mB = med(B, inner), mL = med(L, inner);
    const ss = Math.hypot(ma, mb), hs = Math.atan2(mb, ma);
    const parts = idx.map((i) => this._terms(i, ma, mb, ss, hs, ml));
    // inliers: pixels plausibly on the same surface (excludes the other side of a nearby edge)
    const inl = parts.filter((p) => Math.abs(p.t) < 0.08 && Math.abs(p.r) < 0.2 && Math.abs(p.l) < 1.0 && p.c < 0.12);
    const mad = (key) => {
      const m = inl.length;
      if (m < 5) return 0;
      for (let k = 0; k < m; k++) sv[k] = Math.abs(inl[k][key]);
      return 1.4826 * medianOf(sv, m);
    };
    return { ma, mb, ml, ss, hs, mt: mad('t'), mr: mad('r'), mlam: mad('l'), mc: mad('c'), C: Math.hypot(mA, mB), L: mL };
  }

  /**
   * Distance terms of pixel i relative to a seed: tangential (hue) and radial (saturation)
   * chromaticity difference, ln-lightness difference and plain chromaticity distance.
   */
  _terms(i, ma, mb, ss, hs, ml) {
    const da = this.al[i] - ma, db = this.be[i] - mb;
    const ux = ss > 1e-4 ? ma / ss : 1, uy = ss > 1e-4 ? mb / ss : 0;
    return {
      r: da * ux + db * uy,      // + more saturated, − less saturated than the seed
      t: -da * uy + db * ux,     // hue shift
      l: this.lam[i] - ml,
      c: Math.hypot(da, db),
    };
  }

  /**
   * @param {{width:number,height:number,data:ArrayLike<number>}} img  downscaled frame
   * @param {number} sx, sy  seed in image pixel coords
   * @param {object} opts  {sens: range multiplier (≈0.4–2.5), gains: WB gains | null, temporal: bool}
   */
  run(img, sx, sy, opts = {}) {
    const sens = opts.sens ?? 1, gains = opts.gains || null, temporal = opts.temporal ?? true;
    const w = img.width, h = img.height;
    this._alloc(w, h);
    const n = w * h;
    this._toLab(img.data, gains);
    this._blur5(this.L); this._blur5(this.A); this._blur5(this.B);
    const { L, A, B, al, be, lam, mask, queue } = this;
    for (let i = 0; i < n; i++) {
      const d = L[i] + K;
      al[i] = A[i] / d; be[i] = B[i] / d; lam[i] = Math.log(L[i] + LOFF);
    }

    sx = Math.max(0, Math.min(w - 1, Math.round(sx)));
    sy = Math.max(0, Math.min(h - 1, Math.round(sy)));
    const st = this._seedStats(sx, sy, 4);
    // chromatic vs neutral seed (saturation ≈ C/L)
    const wc = Math.max(0, Math.min(1, (st.ss - 0.05) / 0.06));
    // chromatic tolerances scale with the range; lightness more slowly (shading keeps one object
    // together even when the user narrows the range to separate two similar colours)
    const tex = (base, spread, cap, k = sens) => Math.min(cap, Math.max(base, 2.5 * spread) * k);
    const tt = tex(0.05, st.mt, 0.18);    // hue shift (tangential)
    const trm = tex(0.22, st.mr, 0.4);    // desaturation (glare, deep shadow)
    const trp = tex(0.14, st.mr, 0.3);    // more saturated than the seed
    const tl = tex(0.3 + 0.55 * wc, st.mlam, 2.0, Math.sqrt(sens)); // ln lightness ratio: 1.35× neutral … 2.3× coloured
    const tc = tex(0.045, st.mc, 0.3);    // plain chromaticity distance (neutral seeds)
    const itt2 = 1 / (tt * tt), itrm2 = 1 / (trm * trm), itrp2 = 1 / (trp * trp), itl2 = 1 / (tl * tl), itc2 = 1 / (tc * tc);
    const seedDark = st.L < 0.12;
    const { ma, mb, ss, hs, ml } = st;

    // ---- region growing with hysteresis ----
    // "core" pixels (clearly the seed colour) spread freely; "margin" pixels (within tolerance
    // but less similar) may only extend a few pixels beyond the core. A look-alike neighbour
    // that is entirely in the margin band therefore cannot be flooded through a thin contact.
    const ux = ss > 1e-4 ? ma / ss : 1, uy = ss > 1e-4 ? mb / ss : 0;
    const dist = (j) => {
      const Lj = L[j];
      if (!seedDark && Lj < 0.05) return 9; // near-black pixels carry no colour
      const da = al[j] - ma, db = be[j] - mb, dl = lam[j] - ml;
      const r = da * ux + db * uy, t = -da * uy + db * ux; // saturation / hue components
      const dChrom = t * t * itt2 + r * r * (r < 0 ? itrm2 : itrp2); // coloured-object model
      const dNeutral = (da * da + db * db) * itc2;                    // neutral model
      const noisy = Lj < 0.12 && !seedDark ? 0.5 : 1; // dark pixels: noisier chromaticity
      return (wc * dChrom + (1 - wc) * dNeutral) * noisy + dl * dl * itl2;
    };
    const CORE = 0.3, MAXDEPTH = 4;
    const depth = this.mask2; // reused as per-pixel margin depth during growth
    mask.fill(0);
    let head = 0, tail = 0;
    const visit = (j, di) => {
      if (mask[j]) return;
      const d = dist(j);
      if (d >= 1) return;
      const dj = d < CORE ? 0 : di + 1;
      if (dj > MAXDEPTH) return;
      mask[j] = 1; depth[j] = dj; queue[tail++] = j;
    };
    const seedIdx = sy * w + sx;
    mask[seedIdx] = 1; depth[seedIdx] = 0; queue[tail++] = seedIdx;
    while (head < tail) {
      const i = queue[head++];
      const x = i % w, y = (i - x) / w, di = depth[i];
      if (x > 0) visit(i - 1, di);
      if (x < w - 1) visit(i + 1, di);
      if (y > 0) visit(i - w, di);
      if (y < h - 1) visit(i + w, di);
    }

    // ---- clean-up: opening, component of the seed, closing, hole filling ----
    let bx0 = w, by0 = h, bx1 = 0, by1 = 0;
    for (let k = 0; k < tail; k++) {
      const i = queue[k], x = i % w, y = (i - x) / w;
      if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y;
    }
    const box = [Math.max(0, bx0 - 3), Math.max(0, by0 - 3), Math.min(w - 1, bx1 + 3), Math.min(h - 1, by1 + 3)];
    if (tail > 30) {
      this._morph(false, box); this._morph(true, box); // opening = erode, dilate
      this._keepComponent(sx, sy);
    }
    this._morph(true, box); this._morph(false, box); // closing = dilate, erode
    let area = 0;
    for (let i = 0; i < n; i++) area += mask[i];
    this._fillHoles(area, box);

    // ---- soft mask + temporal smoothing ----
    const soft = this.soft;
    for (let i = 0; i < n; i++) soft[i] = mask[i];
    this._blur(soft);
    const seed = [st.ma, st.mb, st.ml];
    if (temporal && this.hasPrev && this.prevSeed) {
      const d = Math.hypot((seed[0] - this.prevSeed[0]) / 0.06, (seed[1] - this.prevSeed[1]) / 0.06, (seed[2] - this.prevSeed[2]) / tl);
      if (d < 0.8) {
        const prev = this.prevSoft;
        for (let i = 0; i < n; i++) soft[i] = soft[i] * 0.6 + prev[i] * 0.4;
      }
    }
    this.prevSoft.set(soft); this.prevSeed = seed; this.hasPrev = true;

    let minX = w, minY = h, maxX = -1, maxY = -1, a2 = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (soft[y * w + x] > 0.5) { a2++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    }
    const segCount = maxX >= 0 ? this._marchingSquares(minX - 1, minY - 1, maxX + 1, maxY + 1) : 0;
    return {
      w, h, soft, area: a2 / n, bbox: [minX, minY, maxX, maxY],
      segments: this.segs, segCount, seedLab: seed,
      color: this._regionColor(),
      tol: { tt, trm, tl, tc, chroma: wc },
    };
  }

  /** 3×3 dilate (grow=true) or erode on this.mask inside box, via mask2. Image border counts as inside. */
  _morph(grow, box) {
    const { w, h, mask, mask2 } = this;
    const [X0, Y0, X1, Y1] = box;
    for (let y = Y0; y <= Y1; y++) {
      const y0 = y > 0 ? y - 1 : y, y1 = y < h - 1 ? y + 1 : y;
      for (let x = X0; x <= X1; x++) {
        const x0 = x > 0 ? x - 1 : x, x1 = x < w - 1 ? x + 1 : x;
        let v = grow ? 0 : 1;
        for (let yy = y0; yy <= y1; yy++) {
          const o = yy * w;
          for (let xx = x0; xx <= x1; xx++) {
            if (grow ? mask[o + xx] : !mask[o + xx]) { v = grow ? 1 : 0; break; }
          }
          if (v === (grow ? 1 : 0)) break;
        }
        mask2[y * w + x] = v;
      }
    }
    for (let y = Y0; y <= Y1; y++) { const o = y * w; for (let x = X0; x <= X1; x++) mask[o + x] = mask2[o + x]; }
  }

  /** Keep only the connected component containing (or nearest to) the seed. */
  _keepComponent(sx, sy) {
    const { w, h, mask, mask2, queue } = this;
    let start = -1;
    for (let r = 0; r <= 6 && start < 0; r++) {
      for (let dy = -r; dy <= r && start < 0; dy++) for (let dx = -r; dx <= r; dx++) {
        const x = sx + dx, y = sy + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        if (mask[y * w + x]) { start = y * w + x; break; }
      }
    }
    mask2.fill(0);
    if (start < 0) { mask.fill(0); mask[sy * w + sx] = 1; return; }
    let head = 0, tail = 0;
    mask2[start] = 1; queue[tail++] = start;
    const n = w * h;
    while (head < tail) {
      const i = queue[head++], x = i % w;
      if (x > 0 && mask[i - 1] && !mask2[i - 1]) { mask2[i - 1] = 1; queue[tail++] = i - 1; }
      if (x < w - 1 && mask[i + 1] && !mask2[i + 1]) { mask2[i + 1] = 1; queue[tail++] = i + 1; }
      if (i >= w && mask[i - w] && !mask2[i - w]) { mask2[i - w] = 1; queue[tail++] = i - w; }
      if (i < n - w && mask[i + w] && !mask2[i + w]) { mask2[i + w] = 1; queue[tail++] = i + w; }
    }
    mask.set(mask2);
  }

  /** Fill enclosed holes (inside box) that are small relative to the region (glare, text, specks). */
  _fillHoles(area, box) {
    const { w, mask, mask2, queue } = this;
    const [X0, Y0, X1, Y1] = box;
    for (let y = Y0; y <= Y1; y++) mask2.fill(0, y * w + X0, y * w + X1 + 1);
    // 1 = background reachable from the box border, 2 = visited hole
    let tail = 0;
    const push = (i) => { if (!mask[i] && !mask2[i]) { mask2[i] = 1; queue[tail++] = i; } };
    for (let x = X0; x <= X1; x++) { push(Y0 * w + x); push(Y1 * w + x); }
    for (let y = Y0; y <= Y1; y++) { push(y * w + X0); push(y * w + X1); }
    let head = 0;
    while (head < tail) {
      const i = queue[head++], x = i % w, y = (i - x) / w;
      if (x > X0) push(i - 1); if (x < X1) push(i + 1);
      if (y > Y0) push(i - w); if (y < Y1) push(i + w);
    }
    const maxHole = Math.max(12, area * 0.06);
    for (let y = Y0; y <= Y1; y++) for (let x = X0; x <= X1; x++) {
      const s0 = y * w + x;
      if (mask[s0] || mask2[s0]) continue;
      let t = 0, hd = 0; queue[t++] = s0; mask2[s0] = 2;
      while (hd < t) {
        const i = queue[hd++], xx = i % w, yy = (i - xx) / w;
        if (xx > X0 && !mask[i - 1] && !mask2[i - 1]) { mask2[i - 1] = 2; queue[t++] = i - 1; }
        if (xx < X1 && !mask[i + 1] && !mask2[i + 1]) { mask2[i + 1] = 2; queue[t++] = i + 1; }
        if (yy > Y0 && !mask[i - w] && !mask2[i - w]) { mask2[i - w] = 2; queue[t++] = i - w; }
        if (yy < Y1 && !mask[i + w] && !mask2[i + w]) { mask2[i + w] = 2; queue[t++] = i + w; }
      }
      if (t <= maxHole) for (let k = 0; k < t; k++) mask[queue[k]] = 1;
    }
  }

  /**
   * Robust body colour of the region: median chromaticity at median lightness, after dropping
   * the darkest 15 % (shadow side) and brightest 10 % (glare). Returns sRGB 8-bit, or null.
   */
  _regionColor() {
    const { w, h, mask, al, be, lam, sv } = this;
    const n = w * h;
    let count = 0;
    for (let i = 0; i < n; i++) count += mask[i];
    if (count < 20) return null;
    const step = Math.max(1, Math.floor(count / 1300));
    const pa = [], pb = [], pl = [];
    for (let i = 0, k = 0; i < n; i++) {
      if (!mask[i]) continue;
      if (k++ % step) continue;
      pa.push(al[i]); pb.push(be[i]); pl.push(lam[i]);
    }
    const order = pl.map((v, i) => i).sort((x, y) => pl[x] - pl[y]);
    const lo = Math.floor(order.length * 0.15), hi = Math.ceil(order.length * 0.9);
    const keep = order.slice(lo, Math.max(lo + 1, hi));
    const m = keep.length;
    const med = (arr) => { for (let k = 0; k < m; k++) sv[k] = arr[keep[k]]; return medianOf(sv, m); };
    const aM = med(pa), bM = med(pb);
    // people judge an object's colour by its lit side rather than its shadow: use the 60th
    // percentile of lightness of the trimmed set
    const lamM = pl[keep[Math.min(m - 1, Math.floor(m * 0.6))]];
    const Lm = Math.max(0, Math.exp(lamM) - LOFF);
    const lin = oklabToLinRgb(Lm, aM * (Lm + K), bM * (Lm + K));
    const rgb = lin.map((v) => Math.round(linearToSrgb(Math.max(0, Math.min(1, v))) * 255));
    return { rgb, lin: lin.map((v) => Math.max(0, Math.min(1, v))), pixels: count };
  }

  /** Marching squares on this.soft at iso 0.5 → this.segs (x0,y0,x1,y1)*count. */
  _marchingSquares(x0, y0, x1, y1) {
    const { w, h, soft } = this;
    x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(w - 1, x1); y1 = Math.min(h - 1, y1);
    let segs = this.segs, c = 0;
    const iso = 0.5;
    const lerp = (a, b) => (iso - a) / (b - a);
    const add = (px, py, qx, qy) => {
      if (c + 4 > segs.length) { const s2 = new Float32Array(segs.length * 2); s2.set(segs); segs = this.segs = s2; }
      segs[c++] = px; segs[c++] = py; segs[c++] = qx; segs[c++] = qy;
    };
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = y * w + x;
        const a = soft[i], b = soft[i + 1], d = soft[i + w], e = soft[i + w + 1];
        // corners: a(top-left) b(top-right) e(bottom-right) d(bottom-left)
        const idx = (a > iso ? 8 : 0) | (b > iso ? 4 : 0) | (e > iso ? 2 : 0) | (d > iso ? 1 : 0);
        if (idx === 0 || idx === 15) continue;
        const tx = x + lerp(a, b), ty = y;          // top
        const rx = x + 1, ry = y + lerp(b, e);      // right
        const bx = x + lerp(d, e), by = y + 1;      // bottom
        const lx = x, ly = y + lerp(a, d);          // left
        switch (idx) {
          case 1: case 14: add(lx, ly, bx, by); break;
          case 2: case 13: add(bx, by, rx, ry); break;
          case 3: case 12: add(lx, ly, rx, ry); break;
          case 4: case 11: add(tx, ty, rx, ry); break;
          case 6: case 9: add(tx, ty, bx, by); break;
          case 7: case 8: add(lx, ly, tx, ty); break;
          case 5: add(lx, ly, tx, ty); add(bx, by, rx, ry); break;
          case 10: add(tx, ty, rx, ry); add(lx, ly, bx, by); break;
          default: break;
        }
      }
    }
    return c / 4;
  }
}
