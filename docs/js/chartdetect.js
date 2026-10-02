// Find a colour chart in the analysis frame without tapping: a 4 × 6 ColorChecker or the app's
// printable 2 × 7 card. Both are grids of uniform squares separated by gaps, so:
//
//   1. smooth lightly, then join neighbouring pixels of nearly the same colour (union–find);
//   2. keep the regions that look like one patch: compact, roughly square, not tiny, not huge;
//   3. find the two grid directions from the vectors between neighbouring patches of similar size;
//   4. walk the grid from patch to patch and give every patch its (column, row);
//   5. a group whose extent is exactly 6 × 4 (or 7 × 2) with most of its cells found is a chart;
//      a least-squares perspective map from (column, row) to the picture gives the corner patches.
//
// The caller then samples the patches and fits the chart (orientAndFit in truecolor.js), which also
// rejects grids of squares that are not a chart (tiles, keyboards): their colours do not fit.
// Pure (no DOM): runs in the analysis worker.

import { LIN } from './color.js';
import { orientAndFit, CHARTS } from './truecolor.js';

const KINDS = { cc24: { cols: 6, rows: 4 }, print14: { cols: 7, rows: 2 } };

/**
 * @param img {width, height, data: RGBA}
 * @returns {kind, cols, rows, corners: [[x, y] × 4] centres of the corner patches in the picture
 *   (px, lattice order (0,0) (cols-1,0) (cols-1,rows-1) (0,rows-1)), found, pitch} or null
 */
export function detectChart(img, { kinds = ['cc24', 'print14'] } = {}) {
  const { width: W, height: H, data } = img;
  const N = W * H;
  // 1. 3×3 box blur, separable (sRGB 8-bit values are fine for "same colour as the neighbour")
  const tmp = new Uint16Array(N * 3), sm = new Uint8Array(N * 3);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      const xl = x > 0 ? x - 1 : x, xr = x < W - 1 ? x + 1 : x, q = (row + x) * 3;
      const pl = (row + xl) * 4, pc = (row + x) * 4, pr = (row + xr) * 4;
      tmp[q] = data[pl] + data[pc] + data[pr]; tmp[q + 1] = data[pl + 1] + data[pc + 1] + data[pr + 1]; tmp[q + 2] = data[pl + 2] + data[pc + 2] + data[pr + 2];
    }
  }
  for (let y = 0; y < H; y++) {
    const yu = y > 0 ? y - 1 : y, yd = y < H - 1 ? y + 1 : y;
    for (let x = 0; x < W; x++) {
      const q = (y * W + x) * 3, qu = (yu * W + x) * 3, qd = (yd * W + x) * 3;
      sm[q] = (tmp[qu] + tmp[q] + tmp[qd]) / 9; sm[q + 1] = (tmp[qu + 1] + tmp[q + 1] + tmp[qd + 1]) / 9; sm[q + 2] = (tmp[qu + 2] + tmp[q + 2] + tmp[qd + 2]) / 9;
    }
  }
  // 2. union–find over 4-neighbours with a small colour difference
  const parent = new Int32Array(N);
  for (let i = 0; i < N; i++) parent[i] = i;
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const T = 7;
  const close = (a, b) => Math.abs(sm[a * 3] - sm[b * 3]) <= T && Math.abs(sm[a * 3 + 1] - sm[b * 3 + 1]) <= T && Math.abs(sm[a * 3 + 2] - sm[b * 3 + 2]) <= T;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (x + 1 < W && close(i, i + 1)) { const a = find(i), b = find(i + 1); if (a !== b) parent[a] = b; }
    if (y + 1 < H && close(i, i + W)) { const a = find(i), b = find(i + W); if (a !== b) parent[a] = b; }
  }
  // region statistics
  const id = new Int32Array(N).fill(-1);
  const regs = [];
  for (let i = 0; i < N; i++) {
    const r = find(i);
    let k = id[r];
    if (k < 0) { k = id[r] = regs.length; regs.push({ n: 0, sx: 0, sy: 0, x0: W, x1: 0, y0: H, y1: 0 }); }
    const g = regs[k], x = i % W, y = (i - x) / W;
    g.n++; g.sx += x; g.sy += y;
    if (x < g.x0) g.x0 = x; if (x > g.x1) g.x1 = x; if (y < g.y0) g.y0 = y; if (y > g.y1) g.y1 = y;
  }
  // 3. patch-like regions
  const maxA = N / 40;
  const cand = [];
  for (const g of regs) {
    if (g.n < 12 || g.n > maxA) continue;
    const bw = g.x1 - g.x0 + 1, bh = g.y1 - g.y0 + 1;
    if (g.n / (bw * bh) < 0.55 || bw / bh > 2 || bh / bw > 2) continue;
    cand.push({ x: g.sx / g.n, y: g.sy / g.n, s: Math.sqrt(g.n) });
  }
  if (cand.length < 8) return null;
  // neighbour vectors between patches of similar size, at one to two patch sizes apart
  const vecs = [];
  for (let i = 0; i < cand.length; i++) {
    const a = cand[i];
    for (let j = i + 1; j < cand.length; j++) {
      const b = cand[j];
      if (b.s / a.s > 1.6 || a.s / b.s > 1.6) continue;
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy), s = (a.s + b.s) / 2;
      if (d < 1.0 * s || d > 2.0 * s) continue;
      let ang = Math.atan2(dy, dx); if (ang < 0) ang += Math.PI; if (ang >= Math.PI) ang -= Math.PI;
      vecs.push({ dx, dy, ang, d });
    }
  }
  if (vecs.length < 8) return null;
  // two main directions (angle histogram, 6° bins, folded to 0..180°)
  const BINS = 30, hist = new Float32Array(BINS);
  for (const v of vecs) hist[Math.floor((v.ang / Math.PI) * BINS) % BINS]++;
  const sm3 = (k) => hist[(k + BINS - 1) % BINS] + hist[k] + hist[(k + 1) % BINS];
  let k1 = 0; for (let k = 1; k < BINS; k++) if (sm3(k) > sm3(k1)) k1 = k;
  let k2 = -1;
  for (let k = 0; k < BINS; k++) {
    const sep = Math.min(Math.abs(k - k1), BINS - Math.abs(k - k1));
    if (sep < 8 || sep > 22) continue;  // 48°..132° from the first direction
    if (k2 < 0 || sm3(k) > sm3(k2)) k2 = k;
  }
  if (k2 < 0 || sm3(k2) < 3) return null;
  const basis = (k) => {
    const a0 = ((k + 0.5) / BINS) * Math.PI;
    const sel = vecs.filter((v) => { let d = Math.abs(v.ang - a0); d = Math.min(d, Math.PI - d); return d < (1.5 * Math.PI) / BINS; });
    // signs: point every vector the same way as the bin direction
    const xs = [], ys = [];
    for (const v of sel) { const s = v.dx * Math.cos(a0) + v.dy * Math.sin(a0) >= 0 ? 1 : -1; xs.push(s * v.dx); ys.push(s * v.dy); }
    const med = (a) => a.sort((p, q) => p - q)[(a.length - 1) >> 1];
    return [med(xs), med(ys)];
  };
  const u = basis(k1), v = basis(k2);
  // 4. walk the grid
  const lat = new Array(cand.length).fill(null);
  let best = null;
  for (let s0 = 0; s0 < cand.length; s0++) {
    if (lat[s0]) continue;
    const group = [s0];
    lat[s0] = [0, 0];
    for (let q = 0; q < group.length; q++) {
      const a = cand[group[q]], [ia, ja] = lat[group[q]];
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const px = a.x + di * u[0] + dj * v[0], py = a.y + di * u[1] + dj * v[1];
        const tol = 0.35 * Math.hypot(di ? u[0] : v[0], di ? u[1] : v[1]);
        let bj = -1, bd = tol;
        for (let j = 0; j < cand.length; j++) {
          if (lat[j]) continue;
          const b = cand[j];
          if (b.s / a.s > 1.6 || a.s / b.s > 1.6) continue;
          const d = Math.hypot(b.x - px, b.y - py);
          if (d < bd) { bd = d; bj = j; }
        }
        if (bj >= 0) { lat[bj] = [ia + di, ja + dj]; group.push(bj); }
      }
    }
    if (group.length < 8) continue;
    const is = group.map((g) => lat[g][0]), js = group.map((g) => lat[g][1]);
    const mi = Math.min(...is), mj = Math.min(...js);
    const nI = Math.max(...is) - mi + 1, nJ = Math.max(...js) - mj + 1;
    for (const kind of kinds) {
      const { cols, rows } = KINDS[kind];
      const fits = (nI === cols && nJ === rows) || (nI === rows && nJ === cols);
      if (!fits || group.length < 0.6 * cols * rows) continue;
      if (!best || group.length > best.group.length) best = { kind, group: group.slice(), mi, mj, nI, nJ };
    }
  }
  if (!best) return null;
  // 5. least-squares perspective map lattice → picture, corner patch centres
  const src = best.group.map((g) => [lat[g][0] - best.mi, lat[g][1] - best.mj]);
  const dst = best.group.map((g) => [cand[g].x, cand[g].y]);
  const Hm = homographyLS(src, dst);
  if (!Hm) return null;
  const P = (i, j) => { const d = Hm[6] * i + Hm[7] * j + 1; return [(Hm[0] * i + Hm[1] * j + Hm[2]) / d, (Hm[3] * i + Hm[4] * j + Hm[5]) / d]; };
  const err = src.map(([i, j], k) => { const p = P(i, j); return Math.hypot(p[0] - dst[k][0], p[1] - dst[k][1]); }).sort((a, b) => a - b);
  const pitch = (Math.hypot(...u) + Math.hypot(...v)) / 2;
  if (err[(err.length - 1) >> 1] > 0.25 * pitch) return null;
  const I = best.nI - 1, J = best.nJ - 1;
  const { cols, rows } = KINDS[best.kind];
  return { kind: best.kind, cols, rows, corners: [P(0, 0), P(I, 0), P(I, J), P(0, J)], found: best.group.length, pitch };
}

/** Least-squares homography (h33 = 1) from ≥ 4 point pairs, via the normal equations. */
export function homographyLS(src, dst) {
  const A = Array.from({ length: 8 }, () => new Float64Array(9));
  const add = (row, rhs) => { for (let a = 0; a < 8; a++) { if (!row[a]) continue; for (let b = 0; b < 8; b++) A[a][b] += row[a] * row[b]; A[a][8] += row[a] * rhs; } };
  for (let k = 0; k < src.length; k++) {
    const [x, y] = src[k], [X, Y] = dst[k];
    add([x, y, 1, 0, 0, 0, -X * x, -X * y], X);
    add([0, 0, 0, x, y, 1, -Y * x, -Y * y], Y);
  }
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-12) return null;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k <= 8; k++) A[r][k] -= f * A[c][k];
    }
  }
  return [...A.map((r, i) => r[8] / r[i]), 1];
}

/** Median raw linear colour of a disc of the analysis frame (null if mostly blown out). */
function sampler(img) {
  const { width: w, height: h, data } = img;
  return (x, y, r) => {
    const rs = [], gs = [], bs = [];
    let all = 0, clip = 0;
    for (let yy = Math.floor(y - r); yy <= Math.ceil(y + r); yy++) for (let xx = Math.floor(x - r); xx <= Math.ceil(x + r); xx++) {
      if (xx < 0 || yy < 0 || xx >= w || yy >= h || (xx - x) ** 2 + (yy - y) ** 2 > r * r) continue;
      const p = (yy * w + xx) * 4;
      all++;
      // blown-out pixels are kept: a clipped white patch is still roughly white, and leaving the
      // patch out would make the whole chart unusable
      if (data[p] >= 250 || data[p + 1] >= 250 || data[p + 2] >= 250) clip++;
      rs.push(LIN[data[p]]); gs.push(LIN[data[p + 1]]); bs.push(LIN[data[p + 2]]);
    }
    if (!rs.length) return null;
    const m = (a) => a.sort((p, q) => p - q)[(a.length - 1) >> 1];
    return [m(rs), m(gs), m(bs)];
  };
}

/** Find a chart and fit it; positions as fractions of the frame. */
export function findChart(img) {
  const det = detectChart(img);
  if (!det) return null;
  const best = orientAndFit(det.corners, sampler(img), CHARTS[det.kind]);
  if (!best || best.fit.residual > 6) return null;
  const { width: w, height: h } = img;
  return { kind: det.kind, residual: best.fit.residual, meas: best.meas, pts: best.pts.map(([x, y]) => [x / w, y / h]), found: det.found };
}

