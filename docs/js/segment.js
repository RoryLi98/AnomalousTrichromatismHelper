// Color-region segmentation around the reticle + smooth contour extraction.
//
// 1. Convert the (downscaled) frame to OKLab and box-blur it to suppress sensor noise.
// 2. Region-grow (flood fill, 4-connected) from the seed: a pixel joins if its weighted
//    OKLab distance to the seed color is below the tolerance. Following He et al. (2017)
//    lightness is down-weighted for chromatic seeds so shading/shadows on one object stay
//    in the same region; for neutral seeds (white/gray/black) lightness is all we have.
// 3. Morphological closing + small-hole filling, temporal smoothing.
// 4. Marching squares on the soft mask -> sub-pixel contour segments.
import { LIN } from './color.js';

function cbrt(x) { return Math.cbrt(x); }

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
    this.tmp = new Float32Array(n);
    this.mask = new Uint8Array(n);
    this.mask2 = new Uint8Array(n);
    this.queue = new Int32Array(n);
    this.soft = new Float32Array(n);
    this.prevSoft = new Float32Array(n);
    this.blurred = new Float32Array(n);
    this.segs = new Float32Array(n * 2); // grows if needed
    this.hasPrev = false;
  }

  /** Convert RGBA pixels to OKLab planes (optionally with white-balance gains, linear). */
  _toLab(data, gains) {
    const n = this.w * this.h;
    const { L, A, B } = this;
    const gr = gains ? gains[0] : 1, gg = gains ? gains[1] : 1, gb = gains ? gains[2] : 1;
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const r = Math.min(1, LIN[data[p]] * gr), g = Math.min(1, LIN[data[p + 1]] * gg), b = Math.min(1, LIN[data[p + 2]] * gb);
      const l = cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
      const m = cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
      const s = cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
      L[i] = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
      A[i] = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
      B[i] = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
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

  /**
   * @param {ImageData} img   downscaled frame
   * @param {number} sx, sy  seed in image pixel coords
   * @param {number} tol     tolerance in OKLab units (≈ ΔE/100), e.g. 0.07
   * @param {number[]|null} gains white-balance gains (linear)
   * @param {boolean} temporal  blend with previous mask (live video)
   */
  run(img, sx, sy, tol, gains = null, temporal = true) {
    const w = img.width, h = img.height;
    this._alloc(w, h);
    const n = w * h;
    this._toLab(img.data, gains);
    this._blur(this.L); this._blur(this.A); this._blur(this.B);
    const { L, A, B, mask, queue } = this;

    sx = Math.max(0, Math.min(w - 1, Math.round(sx)));
    sy = Math.max(0, Math.min(h - 1, Math.round(sy)));
    // seed = mean over 5x5
    let sL = 0, sA = 0, sB = 0, cnt = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const x = sx + dx, y = sy + dy;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const i = y * w + x; sL += L[i]; sA += A[i]; sB += B[i]; cnt++;
    }
    sL /= cnt; sA /= cnt; sB /= cnt;
    const seedC = Math.hypot(sA, sB);
    // lightness weight: 1 for neutrals, 0.3 for strongly chromatic seeds
    const wL = seedC < 0.03 ? 1 : seedC > 0.08 ? 0.3 : 1 - ((seedC - 0.03) / 0.05) * 0.7;
    // dark pixels have noisy chroma: accept slightly larger chroma deviations there
    const tol2 = tol * tol;

    mask.fill(0);
    let head = 0, tail = 0;
    const seedIdx = sy * w + sx;
    mask[seedIdx] = 1; queue[tail++] = seedIdx;
    let area = 0, minX = sx, maxX = sx, minY = sy, maxY = sy;
    while (head < tail) {
      const i = queue[head++];
      area++;
      const x = i % w, y = (i - x) / w;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      // 4 neighbours
      for (let k = 0; k < 4; k++) {
        let j;
        if (k === 0) { if (x === 0) continue; j = i - 1; }
        else if (k === 1) { if (x === w - 1) continue; j = i + 1; }
        else if (k === 2) { if (y === 0) continue; j = i - w; }
        else { if (y === h - 1) continue; j = i + w; }
        if (mask[j]) continue;
        const dL = L[j] - sL, da = A[j] - sA, db = B[j] - sB;
        const darkBoost = L[j] < 0.25 ? 1.6 : 1;
        if (wL * dL * dL + (da * da + db * db) / darkBoost < tol2) { mask[j] = 1; queue[tail++] = j; }
      }
    }

    this._close(minX, minY, maxX, maxY);
    this._fillHoles(area);

    // soft mask (+ temporal smoothing when the seed color is stable)
    const soft = this.soft;
    for (let i = 0; i < n; i++) soft[i] = mask[i];
    this._blur(soft);
    const seed = [sL, sA, sB];
    if (temporal && this.hasPrev && this.prevSeed) {
      const d = Math.hypot(seed[0] - this.prevSeed[0], seed[1] - this.prevSeed[1], seed[2] - this.prevSeed[2]);
      if (d < tol * 0.8) {
        const prev = this.prevSoft;
        for (let i = 0; i < n; i++) soft[i] = soft[i] * 0.6 + prev[i] * 0.4;
      }
    }
    this.prevSoft.set(soft); this.prevSeed = seed; this.hasPrev = true;

    // recompute bbox of the soft mask
    minX = w; minY = h; maxX = -1; maxY = -1;
    let a2 = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (soft[y * w + x] > 0.5) { a2++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    }
    const segCount = maxX >= 0 ? this._marchingSquares(minX - 1, minY - 1, maxX + 1, maxY + 1) : 0;
    return {
      w, h, soft, area: a2 / n, bbox: [minX, minY, maxX, maxY],
      segments: this.segs, segCount, seedLab: seed,
    };
  }

  /** 3x3 morphological closing restricted to the bbox (+1). */
  _close(x0, y0, x1, y1) {
    const { w, h, mask, mask2 } = this;
    x0 = Math.max(0, x0 - 2); y0 = Math.max(0, y0 - 2); x1 = Math.min(w - 1, x1 + 2); y1 = Math.min(h - 1, y1 + 2);
    // dilate -> mask2
    mask2.fill(0);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      let v = 0;
      for (let dy = -1; dy <= 1 && !v; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx; if (xx < 0 || xx >= w) continue;
          if (mask[yy * w + xx]) { v = 1; break; }
        }
      }
      mask2[y * w + x] = v;
    }
    // erode mask2 -> mask (image border counts as "inside" so regions touching it stay)
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      let v = 1;
      for (let dy = -1; dy <= 1 && v; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx; if (xx < 0 || xx >= w) continue;
          if (!mask2[yy * w + xx]) { v = 0; break; }
        }
      }
      mask[y * w + x] = v;
    }
  }

  /** Fill enclosed holes that are small relative to the region (text, glare, specks). */
  _fillHoles(area) {
    const { w, h, mask, mask2, queue } = this;
    const n = w * h;
    // mask2: 1 = background reachable from border, 2 = visited hole
    mask2.fill(0);
    let tail = 0;
    const push = (i) => { if (!mask[i] && !mask2[i]) { mask2[i] = 1; queue[tail++] = i; } };
    for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
    let head = 0;
    while (head < tail) {
      const i = queue[head++]; const x = i % w;
      if (x > 0) push(i - 1); if (x < w - 1) push(i + 1);
      if (i >= w) push(i - w); if (i < n - w) push(i + w);
    }
    const maxHole = Math.max(12, area * 0.04);
    for (let s = 0; s < n; s++) {
      if (mask[s] || mask2[s]) continue;
      // collect this hole
      let t = 0, hd = 0; queue[t++] = s; mask2[s] = 2;
      while (hd < t) {
        const i = queue[hd++]; const x = i % w;
        const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i >= w ? i - w : -1, i < n - w ? i + w : -1];
        for (const j of nb) if (j >= 0 && !mask[j] && !mask2[j]) { mask2[j] = 2; queue[t++] = j; }
      }
      if (t <= maxHole) for (let k = 0; k < t; k++) mask[queue[k]] = 1;
    }
  }

  /** Marching squares on this.soft at iso 0.5 → this.segs (x0,y0,x1,y1)*count. */
  _marchingSquares(x0, y0, x1, y1) {
    const { w, h, soft } = this;
    x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(w - 1, x1); y1 = Math.min(h - 1, y1);
    let segs = this.segs, c = 0;
    const iso = 0.5;
    const ensure = () => {
      if (c + 8 > segs.length) { const s2 = new Float32Array(segs.length * 2); s2.set(segs); segs = this.segs = s2; }
    };
    const lerp = (a, b) => (iso - a) / (b - a);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = y * w + x;
        const a = soft[i], b = soft[i + 1], d = soft[i + w], e = soft[i + w + 1];
        // corners: a(top-left) b(top-right) e(bottom-right) d(bottom-left)
        const idx = (a > iso ? 8 : 0) | (b > iso ? 4 : 0) | (e > iso ? 2 : 0) | (d > iso ? 1 : 0);
        if (idx === 0 || idx === 15) continue;
        // edge points
        const top = () => [x + lerp(a, b), y];
        const right = () => [x + 1, y + lerp(b, e)];
        const bottom = () => [x + lerp(d, e), y + 1];
        const left = () => [x, y + lerp(a, d)];
        let pairs;
        switch (idx) {
          case 1: case 14: pairs = [[left(), bottom()]]; break;
          case 2: case 13: pairs = [[bottom(), right()]]; break;
          case 3: case 12: pairs = [[left(), right()]]; break;
          case 4: case 11: pairs = [[top(), right()]]; break;
          case 6: case 9: pairs = [[top(), bottom()]]; break;
          case 7: case 8: pairs = [[left(), top()]]; break;
          case 5: pairs = [[left(), top()], [bottom(), right()]]; break;
          case 10: pairs = [[top(), right()], [left(), bottom()]]; break;
          default: pairs = [];
        }
        for (const [p, q] of pairs) {
          ensure();
          segs[c++] = p[0]; segs[c++] = p[1]; segs[c++] = q[0]; segs[c++] = q[1];
        }
      }
    }
    return c / 4;
  }
}
