// Reticle styles. Every style keeps the sampled spot itself uncovered or nearly so, and is drawn
// twice (a dark halo under a thin white line) so it stays visible on light and dark scenes.
// Coordinates are in a 40×40 box centred on the sample point; strokes do not scale with size.

export const RETICLE_STYLES = ['gap', 'ring', 'corners', 'dot', 'cross'];
export const RETICLE_SIZES = { s: 32, m: 42, l: 56 };

const SHAPES = {
  // four short ticks pointing at the centre, centre left open
  gap: '<path d="M0 -17V-6M0 6V17M-17 0H-6M6 0H17"/>',
  // circle showing the sampled area
  ring: '<circle r="8.5"/>',
  // four corner brackets around the sampled area
  corners: '<path d="M-11 -5V-11H-5M5 -11H11V-5M11 5V11H5M-5 11H-11V5"/>',
  // a single small dot: covers almost nothing
  dot: '<circle r="2.2" class="fill"/>',
  // classic thin crosshair with a small centre gap
  cross: '<path d="M0 -18V-3M0 3V18M-18 0H-3M3 0H18"/>',
};

/** SVG markup for a reticle style at a size key (s / m / l). */
export function reticleSVG(style = 'gap', size = 'm') {
  const shape = SHAPES[style] || SHAPES.gap;
  const px = RETICLE_SIZES[size] || RETICLE_SIZES.m;
  return `<svg class="ret-svg" width="${px}" height="${px}" viewBox="-20 -20 40 40" aria-hidden="true">`
    + `<g class="halo">${shape}</g><g class="line">${shape}</g></svg>`;
}
