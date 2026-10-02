// Runs segmentation, auto white balance, the true-colour frame statistics and the colour-chart
// search off the main thread so the camera view stays smooth.
import { Segmenter } from './segment.js';
import { estimateWB } from './wb.js';
import { frameStats } from './truecolor.js';
import { findChart } from './chartdetect.js';

const seg = new Segmenter();
let prevLuma = null;

self.onmessage = (e) => {
  const m = e.data;
  const img = { width: m.w, height: m.h, data: m.buf };
  const out = { id: m.id, w: m.w, h: m.h, wb: null, res: null, tc: null, chart: undefined };
  const transfer = [];
  let soft = null;
  if (m.segment) {
    const r = seg.run(img, m.sx, m.sy, { sens: m.sens, gains: m.gains, temporal: m.temporal });
    soft = r.soft;
    const segs = r.segments.slice(0, r.segCount * 4);
    transfer.push(segs.buffer);
    out.res = { area: r.area, bbox: r.bbox, segCount: r.segCount, segs, color: r.color, tol: r.tol, w: r.w, h: r.h };
    if (m.wantAlpha) {
      const a = new Uint8ClampedArray(soft.length);
      for (let i = 0; i < soft.length; i++) a[i] = soft[i] * 255;
      out.res.alpha = a;
      transfer.push(a.buffer);
    }
  }
  if (m.wb) out.wb = estimateWB(m.buf, m.w, m.h, soft);
  if (m.tc) {
    const st = frameStats(img, { gains: m.gains, soft, sx: m.sx, sy: m.sy, prev: m.temporal ? prevLuma : null, paperAt: m.paperAt });
    prevLuma = st.lumaSmall;
    delete st.lumaSmall;
    out.tc = st;
  }
  if (m.detect) out.chart = findChart(img);
  self.postMessage(out, transfer);
};
