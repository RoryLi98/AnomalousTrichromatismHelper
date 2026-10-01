// Color-vision-deficiency (CVD) models and corrections.
//
//  simulate   : Machado et al. 2009 physiological model, any severity 0..1.
//  compensate : Ro & Yang 2004 "Color adaptation for anomalous trichromats":
//               A = T_abnormal^-1 · T_normal · c, i.e. the inverse of the simulation,
//               so the viewer perceives  M·A = c.  Out-of-gamut results are mapped
//               toward the pixel's own gray (a hue-preserving desaturation), so what the
//               viewer perceives is the ORIGINAL hue, only less saturated where the
//               display cannot produce enough "extra" color.
//  daltonize  : Fidaner et al. error redistribution (works for dichromats too).
//  enhance    : OKLab opponent-axis remapping: the red–green signal the viewer
//               cannot see is copied onto the blue–yellow and lightness axes.
import { MACHADO } from './machado.js';

export const TYPES = ['protan', 'deutan', 'tritan'];
export const METHODS = ['auto', 'compensate', 'daltonize', 'enhance', 'simulate'];

/** Interpolated 3x3 (row-major, length 9) Machado matrix. severity in [0,1]. */
export function machadoMatrix(type, severity) {
  const table = MACHADO[type];
  const s = Math.max(0, Math.min(1, severity)) * 10;
  const lo = Math.floor(s), hi = Math.min(10, lo + 1), f = s - lo;
  const A = table[lo], B = table[hi];
  const M = new Array(9);
  for (let i = 0; i < 9; i++) M[i] = A[i] * (1 - f) + B[i] * f;
  return M;
}

export function mat3Inverse(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-9) return null;
  const inv = 1 / det;
  return [
    A * inv, -(b * i - c * h) * inv, (b * f - c * e) * inv,
    B * inv, (a * i - c * g) * inv, -(a * f - c * d) * inv,
    C * inv, -(a * h - b * g) * inv, (a * e - b * d) * inv,
  ];
}

export function mat3MulVec(m, v) {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/**
 * Highest severity used for exact inversion. Protan/deutan matrices become singular
 * at 1.0 (dichromacy); the tritan model stays invertible (condition number ≈ 8.5).
 */
export function maxCompSeverity(type) {
  return type === 'tritan' ? 1 : 0.9;
}

/** Which method "auto" resolves to. Red–green dichromacy (≈100%) cannot be inverted. */
export function resolveMethod(method, severity, type) {
  if (method !== 'auto') return method;
  if (type === 'tritan') return 'compensate';
  return severity < 0.95 ? 'compensate' : 'daltonize';
}

/** Fidaner error-shift matrices (row-major), applied in gamma-encoded RGB. */
export const ERR_SHIFT = {
  protan: [0, 0, 0, 0.7, 1, 0, 0.7, 0, 1],
  deutan: [0, 0, 0, 0.7, 1, 0, 0.7, 0, 1],
  tritan: [1, 0, 0.7, 0, 1, 0.7, 0, 0, 0],
};

/**
 * All uniform values the shader needs for a given configuration.
 * cfg = {type, severity (0..1), method, strength (0..1)}
 */
export function shaderParams(cfg) {
  const { type, severity, strength } = cfg;
  const method = resolveMethod(cfg.method, severity, type);
  const sim = machadoMatrix(type, severity);
  const compM = machadoMatrix(type, Math.min(severity, maxCompSeverity(type)));
  const inv = mat3Inverse(compM) || [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const methodId = { compensate: 1, daltonize: 2, enhance: 3, simulate: 4 }[method] || 0;
  // enhance: which opponent axis is lost, and how to remap it
  const enh = type === 'tritan'
    ? { axis: 1, gain: 1.2 * strength, lgain: 0.2 * strength }
    : { axis: 0, gain: 1.6 * strength, lgain: (type === 'protan' ? 0.45 : 0.25) * strength };
  return { method, methodId, sim, inv, err: ERR_SHIFT[type], strength, enh };
}

// ---------- CPU reference implementation (mirrors the GLSL; used by tests) ----------
import { srgbToLinear, linearToSrgb, linRgbToOklab, oklabToLinRgb } from './color.js';

const clamp01 = (x) => Math.max(0, Math.min(1, x));

/** Hue-preserving gamut mapping: largest t in [0,1] so that Y + t·(v − Y) fits in [0,1]^3. */
export function gamutT(v, Y) {
  let t = 1;
  for (let k = 0; k < 3; k++) {
    const d = v[k] - Y;
    if (d > 1e-6) t = Math.min(t, (1 - Y) / d);
    else if (d < -1e-6) t = Math.min(t, Y / -d);
  }
  return Math.max(0, t);
}

/** Process one sRGB (0..1) color; returns sRGB (0..1). */
export function processColor(rgb, params) {
  const lin = rgb.map(srgbToLinear);
  let outLin;
  const s = params.strength;
  switch (params.methodId) {
    case 1: { // compensate
      const comp = mat3MulVec(params.inv, lin);
      const Y = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
      const t = gamutT(comp, Y);
      const mapped = comp.map((v) => Y + t * (v - Y));
      outLin = lin.map((v, k) => v + (mapped[k] - v) * s);
      break;
    }
    case 2: { // daltonize (gamma space)
      const simG = mat3MulVec(params.sim, lin).map((v) => linearToSrgb(clamp01(v)));
      const err = rgb.map((v, k) => v - simG[k]);
      const shift = mat3MulVec(params.err, err);
      return rgb.map((v, k) => clamp01(v + shift[k] * s));
    }
    case 3: { // enhance (OKLab)
      const lab = linRgbToOklab(...lin);
      const { axis, gain, lgain } = params.enh;
      if (axis === 0) { lab[2] -= gain * lab[1]; lab[0] += lgain * lab[1]; }
      else { lab[1] -= gain * lab[2]; lab[0] += lgain * lab[2]; }
      outLin = oklabToLinRgb(...lab);
      break;
    }
    case 4: // simulate
      outLin = mat3MulVec(params.sim, lin);
      break;
    default:
      outLin = lin;
  }
  return outLin.map((v) => linearToSrgb(clamp01(v)));
}

/** What a viewer with the given CVD perceives (sRGB 0..1 in/out). */
export function simulateColor(rgb, type, severity) {
  const M = machadoMatrix(type, severity);
  return mat3MulVec(M, rgb.map(srgbToLinear)).map((v) => linearToSrgb(clamp01(v)));
}
