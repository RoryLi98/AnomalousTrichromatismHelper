// Color naming: two sets.
//  - BASIC: 12 everyday color categories, rule-based on OKLCH (robust, predictable).
//  - DETAILED: ~150 named colors (zh/en), nearest neighbour by CIEDE2000,
//    plus a systematic description ("dark yellow-green", "bluish gray").
import { rgbToOklch, rgbToLab, deltaE2000, hexToRgb } from './color.js';

export const BASIC = {
  red:    { zh: '红色', en: 'Red',    hex: '#E53935' },
  orange: { zh: '橙色', en: 'Orange', hex: '#FB8C00' },
  yellow: { zh: '黄色', en: 'Yellow', hex: '#FDD835' },
  green:  { zh: '绿色', en: 'Green',  hex: '#43A047' },
  cyan:   { zh: '青色', en: 'Cyan',   hex: '#00ACC1' },
  blue:   { zh: '蓝色', en: 'Blue',   hex: '#1E63D6' },
  purple: { zh: '紫色', en: 'Purple', hex: '#8E24AA' },
  pink:   { zh: '粉色', en: 'Pink',   hex: '#F48FB1' },
  brown:  { zh: '棕色', en: 'Brown',  hex: '#795548' },
  white:  { zh: '白色', en: 'White',  hex: '#FAFAFA' },
  gray:   { zh: '灰色', en: 'Gray',   hex: '#9E9E9E' },
  black:  { zh: '黑色', en: 'Black',  hex: '#141414' },
};

/** Chroma below which a color is treated as neutral (slightly larger for light colors). */
export function achromaticLimit(L) {
  return L > 0.92 ? 0.04 : 0.03 + 0.004 * L;
}

const inRange = (h, a, b) => (a <= b ? h >= a && h < b : h >= a || h < b);

/** Rule-based basic category from OKLCH. Returns a key of BASIC. */
export function classifyBasicLch({ L, C, h }) {
  if (L < 0.17 || (L < 0.3 && C < 0.06)) return 'black';
  if (C < achromaticLimit(L)) {
    if (L >= 0.84) return 'white'; // camera exposure rarely renders white paper above L≈0.9
    if (L <= 0.26) return 'black';
    return 'gray';
  }
  // Reddish (rose .. red)
  if (inRange(h, 340, 36)) {
    if (L > 0.7) return 'pink';
    if (L > 0.66 && inRange(h, 340, 15)) return 'pink';
    if (inRange(h, 340, 5) && C > 0.18 && L > 0.6) return 'pink';
    if (inRange(h, 340, 5) && C < 0.08 && L < 0.6) return 'purple';
    if (C < 0.08 && L < 0.72) return 'brown';
    return 'red';
  }
  if (inRange(h, 36, 80)) {
    // brown = dark and/or muted orange; a dark but strongly coloured orange stays orange
    if (L < 0.58 || (L < 0.68 && C < 0.13) || (C < 0.09 && L < 0.85)) return 'brown';
    return 'orange';
  }
  if (inRange(h, 80, 100)) {
    if (L < 0.62 || (C < 0.07 && L < 0.85)) return 'brown';
    return 'yellow';
  }
  if (inRange(h, 100, 120)) {
    if (L < 0.66) return 'green'; // olive
    return 'yellow';
  }
  if (inRange(h, 120, 175)) return 'green';
  if (inRange(h, 175, 215)) return 'cyan';
  if (inRange(h, 215, 290)) return 'blue';
  // 290 .. 340
  if (L > 0.8 && inRange(h, 320, 340)) return 'pink';
  return 'purple';
}

export function classifyBasic(r, g, b) {
  return classifyBasicLch(rgbToOklch(r, g, b));
}

/**
 * Colours near a category boundary (orange/red, brown/orange, gray/blue …) are named
 * differently by different people and flip under small lighting changes. Perturb the colour
 * slightly (hue ±5°, lightness ±0.05, chroma ×0.75/×1.3) and report the most frequent other
 * category if it wins at least 2 of the 10 perturbations.
 * @returns {string|null} key of BASIC
 */
export function basicAlternative(r, g, b) {
  const base = rgbToOklch(r, g, b);
  const main = classifyBasicLch(base);
  const P = [[5, 0, 1], [-5, 0, 1], [0, 0.05, 1], [0, -0.05, 1], [0, 0, 0.75], [0, 0, 1.3],
    [5, -0.05, 1], [-5, 0.05, 1], [5, 0, 0.75], [-5, 0, 1.3]];
  const votes = {};
  for (const [dh, dl, kc] of P) {
    const k = classifyBasicLch({ L: Math.max(0, Math.min(1, base.L + dl)), C: base.C * kc, h: (base.h + dh + 360) % 360 });
    if (k !== main) votes[k] = (votes[k] || 0) + 1;
  }
  let best = null, n = 0;
  for (const [k, v] of Object.entries(votes)) if (v > n) { best = k; n = v; }
  return n >= 2 ? best : null;
}

// ---------- systematic description ----------
// sRGB gamut "cusp" (lightness & chroma of the most saturated color) per hue,
// so modifiers like light/dark/vivid are relative to what is possible at that hue.
const CUSP_L = new Float32Array(360), CUSP_C = new Float32Array(360);
(function buildCusp() {
  const seen = new Uint8Array(360);
  const corners = [[255, 0, 0], [255, 255, 0], [0, 255, 0], [0, 255, 255], [0, 0, 255], [255, 0, 255], [255, 0, 0]];
  for (let e = 0; e < 6; e++) {
    const a = corners[e], b = corners[e + 1];
    for (let i = 0; i <= 255; i++) {
      const t = i / 255;
      const c = rgbToOklch(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);
      const k = Math.floor(c.h) % 360;
      if (!seen[k] || c.C > CUSP_C[k]) { CUSP_C[k] = c.C; CUSP_L[k] = c.L; seen[k] = 1; }
    }
  }
  // fill gaps
  for (let k = 0; k < 360; k++) {
    if (seen[k]) continue;
    let p = k, n = k;
    while (!seen[(p + 359) % 360]) p--;
    while (!seen[(n + 1) % 360]) n++;
    const pi = (p + 359) % 360, ni = (n + 1) % 360;
    CUSP_L[k] = (CUSP_L[pi] + CUSP_L[ni]) / 2;
    CUSP_C[k] = (CUSP_C[pi] + CUSP_C[ni]) / 2;
  }
})();

/** Approximate max chroma available in sRGB at lightness L and hue h. */
export function maxChroma(L, h) {
  const k = Math.floor(h) % 360;
  const Lc = CUSP_L[k], Cc = CUSP_C[k];
  return L <= Lc ? (Cc * L) / Lc : (Cc * (1 - L)) / (1 - Lc);
}
export function cuspL(h) { return CUSP_L[Math.floor(h) % 360]; }

const HUES = [
  // [start angle (OKLCH hue, deg), zh, en]
  [12, '红', 'red'],
  [35, '橙红', 'red-orange'],
  [50, '橙', 'orange'],
  [75, '橙黄', 'amber'],
  [90, '黄', 'yellow'],
  [112, '黄绿', 'yellow-green'],
  [135, '绿', 'green'],
  [162, '青绿', 'cyan-green'],
  [182, '青', 'cyan'],
  [212, '青蓝', 'azure'],
  [240, '蓝', 'blue'],
  [275, '蓝紫', 'blue-violet'],
  [298, '紫', 'purple'],
  [322, '紫红', 'magenta'],
  [345, '玫红', 'rose'],
];

function hueSector(h) {
  const hh = h < HUES[0][0] ? h + 360 : h;
  for (let i = 0; i < HUES.length; i++) {
    const end = i + 1 < HUES.length ? HUES[i + 1][0] : 360 + HUES[0][0];
    if (hh >= HUES[i][0] && hh < end) return i;
  }
  return HUES.length - 1;
}

const LEAN = {
  // short hue adjectives used for tinted neutrals: "bluish gray"
  zh: ['红', '橙', '橙', '黄', '黄', '黄绿', '绿', '青', '青', '蓝', '蓝', '紫', '紫', '紫红', '红'],
  en: ['reddish', 'orangish', 'orangish', 'yellowish', 'yellowish', 'greenish', 'greenish', 'bluish-green', 'cyan', 'bluish', 'bluish', 'violet', 'purplish', 'purplish', 'pinkish'],
};

const out = (mods, modsEn, zh, en) => ({ zh: mods.join('') + zh + '色', en: [...modsEn, en].join(' ') });

/**
 * Systematic, compositional description of a color.
 * Returns {zh, en} e.g. {zh:'深黄绿色', en:'dark yellow-green'}.
 */
export function describe(r, g, b) {
  const { L, C, h } = rgbToOklch(r, g, b);
  const sec = hueSector(h);
  // Neutrals (optionally tinted: "bluish gray")
  if (L < 0.17 || C < achromaticLimit(L)) {
    let zh, en;
    if (L >= 0.84) { zh = '白'; en = 'white'; }
    else if (L >= 0.75) { zh = '浅灰'; en = 'light gray'; }
    else if (L >= 0.5) { zh = '灰'; en = 'gray'; }
    else if (L >= 0.28) { zh = '深灰'; en = 'dark gray'; }
    else { zh = '黑'; en = 'black'; }
    if (C > 0.012 && L >= 0.2) return { zh: `偏${LEAN.zh[sec]}的${zh}色`, en: `${LEAN.en[sec]} ${en}` };
    return { zh: zh + '色', en };
  }

  const relC = Math.min(1, C / Math.max(1e-4, maxChroma(L, h)));
  const Lc = cuspL(h);
  const mods = [], modsEn = [];

  // --- special families: brown, olive, pink, purple ---
  const darkRed = sec === 0 && L < 0.6 && C < 0.12;
  const mutedRed = sec === 0 && C < 0.085 && L < 0.8;
  const orangeBrown = (sec === 1 || sec === 2) && (L < 0.6 || (C < 0.085 && L < 0.8));
  const amberBrown = (sec === 3 || (sec === 4 && h < 100)) && (L < 0.6 || (C < 0.075 && L < 0.82));
  if (darkRed || mutedRed || orangeBrown || amberBrown) {
    const [zh, en] = sec === 0 ? ['红棕', 'reddish brown'] : sec >= 3 ? ['黄棕', 'yellowish brown'] : ['棕', 'brown'];
    if (L < 0.36) { mods.push('深'); modsEn.push('dark'); } else if (L > 0.72) { mods.push('浅'); modsEn.push('light'); }
    return out(mods, modsEn, zh, en);
  }
  if ((sec === 4 || sec === 5) && L < 0.62) {
    if (L < 0.4) { mods.push('深'); modsEn.push('dark'); }
    return sec === 4 ? out(mods, modsEn, '橄榄', 'olive') : out(mods, modsEn, '橄榄绿', 'olive green');
  }
  if ((sec === 0 || sec === 14 || sec === 1) && L > 0.72) {
    if (L > 0.86 || C < 0.09) { mods.push('浅'); modsEn.push('light'); } else if (C > 0.17) { mods.push('艳'); modsEn.push('hot'); }
    if (sec === 14) return out(mods, modsEn, '玫粉', 'rose pink');
    if (sec === 1) return out(mods, modsEn, '橙粉', 'salmon pink');
    return out(mods, modsEn, '粉红', 'pink');
  }
  let hueZh = HUES[sec][1], hueEn = HUES[sec][2];
  let skipDark = false;
  if (sec === 13 && L < 0.5) { hueZh = '紫'; hueEn = 'purple'; skipDark = L >= 0.32; } // #800080 is "purple"

  // --- lightness ---
  const light = L > 0.78 && (L > Lc + 0.04 || relC < 0.55);
  const darkLimit = sec === 10 || sec === 11 ? 0.38 : 0.45;
  if (light) {
    if (relC < 0.3) { mods.push('淡'); modsEn.push('pale'); } else { mods.push('浅'); modsEn.push('light'); }
  } else if (L < 0.28) { mods.push('暗'); modsEn.push('very dark'); }
  else if (!skipDark && (L < darkLimit || (Lc - L > 0.3 && L < 0.6))) { mods.push('深'); modsEn.push('dark'); }
  const isDark = mods.length > 0 && !light;
  // --- chroma ---
  if (C < 0.06 || (relC < 0.3 && !light)) { mods.push('灰'); modsEn.push('grayish'); }
  else if (relC > 0.9 && C > 0.12 && !light && !isDark) { mods.push('鲜'); modsEn.push('vivid'); }

  return out(mods, modsEn, hueZh, hueEn);
}

// ---------- detailed named colors ----------
// [zh, en, hex]
const DETAILED_RAW = [
  // Reds
  ['红色', 'Red', '#FF0000'],
  ['大红', 'Scarlet', '#FF2400'],
  ['中国红', 'China red', '#D7191C'],
  ['朱红', 'Vermilion', '#E34234'],
  ['绯红', 'Crimson', '#DC143C'],
  ['深红', 'Dark red', '#8B0000'],
  ['酒红', 'Burgundy', '#800020'],
  ['枣红', 'Maroon', '#800000'],
  ['胭脂红', 'Carmine', '#960018'],
  ['砖红', 'Brick red', '#B22222'],
  ['铁锈红', 'Rust', '#B7410E'],
  ['番茄红', 'Tomato red', '#FF6347'],
  ['橘红', 'Orange red', '#FF4500'],
  ['珊瑚色', 'Coral', '#FF7F50'],
  ['鲑鱼红', 'Salmon', '#FA8072'],
  ['西瓜红', 'Watermelon red', '#F4505F'],
  ['玫瑰红', 'Rose red', '#E8175D'],
  ['玫红', 'Rose', '#FF007F'],
  ['豆沙红', 'Dusty rose', '#C08081'],
  ['紫红', 'Mulberry', '#C71585'],
  ['梅红', 'Plum red', '#8E354A'],
  // Pinks
  ['深粉', 'Deep pink', '#FF1493'],
  ['亮粉', 'Hot pink', '#FF69B4'],
  ['粉红', 'Pink', '#FFC0CB'],
  ['浅粉', 'Light pink', '#FFB6C1'],
  ['樱花粉', 'Sakura pink', '#FADADD'],
  ['藕粉', 'Lotus pink', '#E4C6D0'],
  ['桃粉', 'Peach pink', '#FF9AA2'],
  ['蜜桃色', 'Peach', '#FFDAB9'],
  ['杏色', 'Apricot', '#FBCEB1'],
  // Oranges
  ['橙色', 'Orange', '#FFA500'],
  ['深橙', 'Dark orange', '#FF8C00'],
  ['橘色', 'Tangerine', '#F28500'],
  ['南瓜色', 'Pumpkin', '#FF7518'],
  ['琥珀色', 'Amber', '#FFBF00'],
  ['橙黄', 'Orange yellow', '#FFB347'],
  ['赭石色', 'Ochre', '#CC7722'],
  ['焦糖色', 'Caramel', '#C68E3F'],
  ['铜色', 'Copper', '#B87333'],
  ['古铜色', 'Bronze', '#CD7F32'],
  // Browns
  ['棕色', 'Brown', '#964B00'],
  ['咖啡色', 'Coffee', '#6F4E37'],
  ['巧克力色', 'Chocolate', '#7B3F00'],
  ['深棕', 'Dark brown', '#5C4033'],
  ['红棕', 'Sienna', '#A0522D'],
  ['栗色', 'Chestnut', '#954535'],
  ['马鞍棕', 'Saddle brown', '#8B4513'],
  ['黄褐', 'Tawny', '#CD853F'],
  ['驼色', 'Camel', '#C19A6B'],
  ['卡其色', 'Khaki', '#C3B091'],
  ['茶色', 'Tan', '#D2B48C'],
  ['沙色', 'Sand', '#C2B280'],
  ['土黄', 'Earth yellow', '#E1A95F'],
  ['褐色', 'Umber', '#635147'],
  ['乌贼墨色', 'Sepia', '#704214'],
  ['米色', 'Beige', '#F5F5DC'],
  ['小麦色', 'Wheat', '#F5DEB3'],
  // Yellows
  ['黄色', 'Yellow', '#FFFF00'],
  ['柠檬黄', 'Lemon yellow', '#FFF44F'],
  ['金黄', 'Golden yellow', '#FFDF00'],
  ['金色', 'Gold', '#FFD700'],
  ['鹅黄', 'Canary yellow', '#FFF143'],
  ['奶油色', 'Cream', '#FFFDD0'],
  ['象牙白', 'Ivory', '#FFFFF0'],
  ['芥末黄', 'Mustard', '#E1AD01'],
  ['藤黄', 'Gamboge', '#E49B0F'],
  ['金菊黄', 'Goldenrod', '#DAA520'],
  ['暗金色', 'Dark goldenrod', '#B8860B'],
  ['浅卡其', 'Light khaki', '#F0E68C'],
  ['暗卡其', 'Dark khaki', '#BDB76B'],
  ['橄榄色', 'Olive', '#808000'],
  // Greens
  ['黄绿', 'Yellow green', '#9ACD32'],
  ['嫩绿', 'Lawn green', '#7CFC00'],
  ['苹果绿', 'Apple green', '#8DB600'],
  ['青柠绿', 'Lime green', '#32CD32'],
  ['鲜绿', 'Bright green', '#00FF00'],
  ['绿色', 'Green', '#008000'],
  ['草绿', 'Grass green', '#5DA130'],
  ['深绿', 'Dark green', '#006400'],
  ['墨绿', 'Deep forest green', '#024B30'],
  ['森林绿', 'Forest green', '#228B22'],
  ['翠绿', 'Emerald', '#50C878'],
  ['玉绿', 'Jade', '#00A86B'],
  ['碧绿', 'Viridian', '#40826D'],
  ['薄荷绿', 'Mint green', '#98FF98'],
  ['浅绿', 'Light green', '#90EE90'],
  ['抹茶绿', 'Matcha green', '#B5C266'],
  ['橄榄绿', 'Olive green', '#6B8E23'],
  ['暗橄榄绿', 'Dark olive green', '#556B2F'],
  ['军绿', 'Army green', '#4B5320'],
  ['海绿', 'Sea green', '#2E8B57'],
  ['灰绿', 'Sage green', '#9CAF88'],
  ['苔藓绿', 'Moss green', '#8A9A5B'],
  ['孔雀绿', 'Peacock green', '#00A693'],
  // Cyans / teals
  ['青色', 'Cyan', '#00FFFF'],
  ['蓝绿', 'Teal', '#008080'],
  ['深青', 'Dark cyan', '#008B8B'],
  ['绿松石色', 'Turquoise', '#40E0D0'],
  ['水绿', 'Aquamarine', '#7FFFD4'],
  ['淡青', 'Pale turquoise', '#AFEEEE'],
  ['灰青', 'Cadet blue', '#5F9EA0'],
  ['孔雀蓝', 'Peacock blue', '#0093AF'],
  ['湖蓝', 'Lake blue', '#2A9DB5'],
  // Blues
  ['天蓝', 'Sky blue', '#87CEEB'],
  ['浅蓝', 'Light blue', '#ADD8E6'],
  ['粉蓝', 'Powder blue', '#B0E0E6'],
  ['婴儿蓝', 'Baby blue', '#89CFF0'],
  ['深天蓝', 'Deep sky blue', '#00BFFF'],
  ['亮蓝', 'Dodger blue', '#1E90FF'],
  ['蔚蓝', 'Azure', '#007FFF'],
  ['矢车菊蓝', 'Cornflower blue', '#6495ED'],
  ['宝蓝', 'Royal blue', '#4169E1'],
  ['蓝色', 'Blue', '#0000FF'],
  ['钴蓝', 'Cobalt blue', '#0047AB'],
  ['克莱因蓝', 'Klein blue', '#002FA7'],
  ['牛仔蓝', 'Denim', '#1560BD'],
  ['钢蓝', 'Steel blue', '#4682B4'],
  ['灰蓝', 'Blue gray', '#6699CC'],
  ['雾霾蓝', 'Dusty blue', '#8DA0B6'],
  ['深蓝', 'Dark blue', '#00008B'],
  ['藏青', 'Navy', '#000080'],
  ['午夜蓝', 'Midnight blue', '#191970'],
  ['普鲁士蓝', 'Prussian blue', '#003153'],
  // Purples
  ['石板蓝', 'Slate blue', '#6A5ACD'],
  ['蓝紫', 'Blue violet', '#8A2BE2'],
  ['靛青', 'Indigo', '#4B0082'],
  ['紫罗兰', 'Violet', '#7F00FF'],
  ['紫色', 'Purple', '#800080'],
  ['深紫', 'Deep purple', '#4E2A84'],
  ['葡萄紫', 'Grape', '#6F2DA8'],
  ['茄子紫', 'Eggplant', '#614051'],
  ['梅紫', 'Plum', '#8E4585'],
  ['薰衣草紫', 'Lavender', '#B57EDC'],
  ['丁香紫', 'Lilac', '#C8A2C8'],
  ['浅紫', 'Light purple', '#DDA0DD'],
  ['淡紫', 'Pale lavender', '#E6E6FA'],
  ['兰花紫', 'Orchid', '#DA70D6'],
  ['洋红', 'Magenta', '#FF00FF'],
  // Neutrals
  ['白色', 'White', '#FFFFFF'],
  ['米白', 'Off-white', '#F5F2EA'],
  ['浅灰', 'Light gray', '#D3D3D3'],
  ['银色', 'Silver', '#C0C0C0'],
  ['暖灰', 'Warm gray', '#A8A196'],
  ['冷灰', 'Cool gray', '#8C92AC'],
  ['灰色', 'Gray', '#808080'],
  ['石板灰', 'Slate gray', '#708090'],
  ['暗灰', 'Dim gray', '#696969'],
  ['深灰', 'Dark gray', '#4A4A4A'],
  ['炭灰', 'Charcoal', '#36454F'],
  ['黑色', 'Black', '#000000'],
];

export const DETAILED = DETAILED_RAW.map(([zh, en, hex]) => {
  const rgb = hexToRgb(hex);
  return { zh, en, hex, rgb, lab: rgbToLab(...rgb), family: classifyBasic(...rgb) };
});

/** Nearest detailed named color (CIEDE2000). Returns {entry, dE}. */
export function nearestDetailed(r, g, b) {
  const lab = rgbToLab(r, g, b);
  let best = null, bestD = Infinity;
  for (const e of DETAILED) {
    const d = deltaE2000(lab, e.lab);
    if (d < bestD) { bestD = d; best = e; }
  }
  return { entry: best, dE: bestD };
}

/** Full naming result used by the UI. */
export function nameColor(r, g, b) {
  const basicKey = classifyBasic(r, g, b);
  const near = nearestDetailed(r, g, b);
  const alt = basicAlternative(r, g, b);
  return {
    basicKey,
    basic: BASIC[basicKey],
    alt: alt ? BASIC[alt] : null,
    altKey: alt,
    detailed: near.entry,
    dE: near.dE,
    desc: describe(r, g, b),
  };
}
