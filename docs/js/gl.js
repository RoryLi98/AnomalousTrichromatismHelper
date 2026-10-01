// WebGL (1.0, for maximum phone compatibility) renderer: draws the camera frame
// full-screen ("cover" crop) and applies the CVD processing per pixel on the GPU.

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
uniform vec4 uCrop;   // xy = offset, zw = scale (texture space)
uniform float uMirror;
void main() {
  vec2 uv = aPos * 0.5 + 0.5;
  uv.y = 1.0 - uv.y;
  vec2 suv = uv;
  if (uMirror > 0.5) suv.x = 1.0 - suv.x;
  vUv = uCrop.xy + suv * uCrop.zw;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 vUv;
uniform sampler2D uTex;
uniform int uMethod;        // 0 none, 1 compensate, 2 daltonize, 3 enhance, 4 simulate
uniform mat3 uSim;          // Machado simulation (linear RGB)
uniform mat3 uInv;          // inverse simulation (compensation)
uniform mat3 uErr;          // daltonize error shift
uniform float uStrength;
uniform vec3 uEnh;          // axis (0 = red-green lost, 1 = blue-yellow lost), gain, lightness gain
uniform vec3 uWB;           // white-balance gains (linear)
uniform float uPreview;     // 1 = show through simulated CVD eyes
uniform float uSplit;       // canvas x (device px) of the compare divider, <0 disables

vec3 toLin(vec3 c) {
  vec3 lo = c / 12.92;
  vec3 hi = pow((c + 0.055) / 1.055, vec3(2.4));
  return mix(lo, hi, step(vec3(0.04045), c));
}
vec3 toSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), c));
}
vec3 cbrt3(vec3 v) { return sign(v) * pow(abs(v), vec3(1.0 / 3.0)); }
vec3 linToOklab(vec3 c) {
  vec3 lms = vec3(
    0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b,
    0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b,
    0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b);
  lms = cbrt3(lms);
  return vec3(
    0.2104542553 * lms.x + 0.7936177850 * lms.y - 0.0040720468 * lms.z,
    1.9779984951 * lms.x - 2.4285922050 * lms.y + 0.4505937099 * lms.z,
    0.0259040371 * lms.x + 0.7827717662 * lms.y - 0.8086757660 * lms.z);
}
vec3 oklabToLin(vec3 lab) {
  float l = lab.x + 0.3963377774 * lab.y + 0.2158037573 * lab.z;
  float m = lab.x - 0.1055613458 * lab.y - 0.0638541728 * lab.z;
  float s = lab.x - 0.0894841775 * lab.y - 1.2914855480 * lab.z;
  l = l * l * l; m = m * m * m; s = s * s * s;
  return vec3(
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
}

vec3 process(vec3 srgb, vec3 lin) {
  if (uMethod == 1) {
    vec3 comp = uInv * lin;
    float Y = dot(lin, vec3(0.2126, 0.7152, 0.0722));
    vec3 d = comp - vec3(Y);
    float t = 1.0;
    for (int k = 0; k < 3; k++) {
      float dk = k == 0 ? d.r : (k == 1 ? d.g : d.b);
      if (dk > 1e-5) t = min(t, (1.0 - Y) / dk);
      else if (dk < -1e-5) t = min(t, Y / -dk);
    }
    t = max(t, 0.0);
    vec3 mapped = vec3(Y) + t * d;
    return mix(lin, mapped, uStrength);
  } else if (uMethod == 2) {
    vec3 simG = toSrgb(uSim * lin);
    vec3 err = srgb - simG;
    vec3 outG = clamp(srgb + (uErr * err) * uStrength, 0.0, 1.0);
    return toLin(outG);
  } else if (uMethod == 3) {
    vec3 lab = linToOklab(lin);
    if (uEnh.x < 0.5) { lab.z -= uEnh.y * lab.y; lab.x += uEnh.z * lab.y; }
    else { lab.y -= uEnh.y * lab.z; lab.x += uEnh.z * lab.z; }
    return oklabToLin(lab);
  } else if (uMethod == 4) {
    return uSim * lin;
  }
  return lin;
}

void main() {
  vec3 srgb = texture2D(uTex, vUv).rgb;
  vec3 lin = min(toLin(srgb) * uWB, vec3(1.0));
  srgb = toSrgb(lin);
  bool original = uSplit >= 0.0 && gl_FragCoord.x < uSplit;
  vec3 outLin = original ? lin : process(srgb, lin);
  if (uPreview > 0.5) outLin = uSim * clamp(outLin, 0.0, 1.0);
  vec3 col = toSrgb(outLin);
  if (uSplit >= 0.0) {
    float dx = abs(gl_FragCoord.x - uSplit);
    col = mix(col, vec3(1.0), 1.0 - smoothstep(1.0, 2.5, dx));
  }
  gl_FragColor = vec4(col, 1.0);
}`;

// Pass-through used for analysis read-back: renders a source region into a small
// framebuffer (4-tap box filter for downscaling) so we never copy full video frames to the CPU.
const COPY_VERT = `
attribute vec2 aPos;
varying vec2 vUv;
uniform vec4 uCrop;
uniform float uMirror;
void main() {
  vec2 uv = aPos * 0.5 + 0.5;          // FBO row 0 = top of the region
  vec2 suv = uv;
  if (uMirror > 0.5) suv.x = 1.0 - suv.x;
  vUv = uCrop.xy + suv * uCrop.zw;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;
const COPY_FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uTap;
void main() {
  vec3 c = texture2D(uTex, vUv + vec2(-uTap.x, -uTap.y)).rgb + texture2D(uTex, vUv + vec2(uTap.x, -uTap.y)).rgb
         + texture2D(uTex, vUv + vec2(-uTap.x, uTap.y)).rgb + texture2D(uTex, vUv + vec2(uTap.x, uTap.y)).rgb;
  gl_FragColor = vec4(c * 0.25, 1.0);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error('Shader compile failed: ' + log);
  }
  return s;
}

/** Transpose row-major 3x3 to column-major for uniformMatrix3fv. */
function colMajor(m) {
  return new Float32Array([m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]);
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const opts = { antialias: false, alpha: false, preserveDrawingBuffer: false, premultipliedAlpha: false };
    const gl = canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts);
    if (!gl) throw new Error('WebGL not supported');
    this.gl = gl;
    const link = (vs, fs) => {
      const pr = gl.createProgram();
      gl.attachShader(pr, compile(gl, gl.VERTEX_SHADER, vs));
      gl.attachShader(pr, compile(gl, gl.FRAGMENT_SHADER, fs));
      gl.bindAttribLocation(pr, 0, 'aPos');
      gl.linkProgram(pr);
      if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error('Link failed: ' + gl.getProgramInfoLog(pr));
      return pr;
    };
    const prog = link(VERT, FRAG);
    this.copy = link(COPY_VERT, COPY_FRAG);
    this.cu = {
      uCrop: gl.getUniformLocation(this.copy, 'uCrop'), uMirror: gl.getUniformLocation(this.copy, 'uMirror'),
      uTap: gl.getUniformLocation(this.copy, 'uTap'), uTex: gl.getUniformLocation(this.copy, 'uTex'),
    };
    gl.useProgram(this.copy);
    gl.uniform1i(this.cu.uTex, 0);
    gl.useProgram(prog);
    this.prog = prog;
    this.targets = new Map();
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.u = {};
    for (const n of ['uTex', 'uCrop', 'uMirror', 'uMethod', 'uSim', 'uInv', 'uErr', 'uStrength', 'uEnh', 'uWB', 'uPreview', 'uSplit']) {
      this.u[n] = gl.getUniformLocation(prog, n);
    }
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.uniform1i(this.u.uTex, 0);
    this.setParams(null);
    this.setWB([1, 1, 1]);
    this.setSplit(-1);
    this.setPreview(false);
  }

  /** Where the picture goes inside the canvas, in CSS-style device px (origin top-left). */
  setViewport(x, y, w, h) {
    this.vp = [Math.round(x), Math.round(this.canvas.height - y - h), Math.round(w), Math.round(h)];
  }

  resize(w, h) {
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
    }
    if (!this.vp) this.vp = [0, 0, w, h];
  }

  /** Upload a frame from a <video>, <canvas> or <img>. */
  upload(source) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, source);
  }

  /** crop in normalized texture coords: [x, y, w, h] */
  setCrop(crop, mirror) {
    this.gl.uniform4f(this.u.uCrop, crop[0], crop[1], crop[2], crop[3]);
    this.gl.uniform1f(this.u.uMirror, mirror ? 1 : 0);
  }

  /** p = shaderParams(...) or null for passthrough */
  setParams(p) {
    const gl = this.gl, u = this.u;
    const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    gl.uniform1i(u.uMethod, p ? p.methodId : 0);
    gl.uniformMatrix3fv(u.uSim, false, colMajor(p ? p.sim : I));
    gl.uniformMatrix3fv(u.uInv, false, colMajor(p ? p.inv : I));
    gl.uniformMatrix3fv(u.uErr, false, colMajor(p ? p.err : [0, 0, 0, 0, 0, 0, 0, 0, 0]));
    gl.uniform1f(u.uStrength, p ? p.strength : 0);
    gl.uniform3f(u.uEnh, p ? p.enh.axis : 0, p ? p.enh.gain : 0, p ? p.enh.lgain : 0);
  }

  /** Show the result as the CVD viewer would perceive it (uses uSim = the user's type). */
  setPreview(on) {
    this.gl.uniform1f(this.u.uPreview, on ? 1 : 0);
  }

  setWB(g) { this.gl.uniform3f(this.u.uWB, g[0], g[1], g[2]); }
  setSplit(x) { this.gl.uniform1f(this.u.uSplit, x); }

  draw() {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.055, 0.067, 0.086, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.viewport(this.vp[0], this.vp[1], this.vp[2], this.vp[3]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /**
   * Read back the unprocessed source region (normalized crop [x,y,w,h]) at w×h pixels.
   * Returns {width, height, data: Uint8Array RGBA}, row 0 = top.
   */
  read(crop, mirror, w, h) {
    const gl = this.gl;
    const key = w + 'x' + h;
    let t = this.targets.get(key);
    if (!t) {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      t = { tex, fbo, img: { width: w, height: h, data: new Uint8Array(w * h * 4) } };
      this.targets.set(key, t);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.copy);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform4f(this.cu.uCrop, crop[0], crop[1], crop[2], crop[3]);
    gl.uniform1f(this.cu.uMirror, mirror ? 1 : 0);
    gl.uniform2f(this.cu.uTap, (crop[2] / w) * 0.25, (crop[3] / h) * 0.25);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, t.img.data);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(this.vp[0], this.vp[1], this.vp[2], this.vp[3]);
    gl.useProgram(this.prog);
    return t.img;
  }
}
