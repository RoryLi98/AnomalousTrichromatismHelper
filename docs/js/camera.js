// Camera access (getUserMedia) with rear/front switching and torch control.

export class Camera {
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.facing = 'environment';
    this.torchOn = false;
    this.gen = 0;           // guards against overlapping start() calls
    this.onEnded = null;    // called when the track ends unexpectedly (camera taken, interruption)
  }

  get active() { return !!this.stream; }
  /** True only while the video track is actually delivering frames. */
  get live() { const tr = this.track; return !!tr && tr.readyState === 'live'; }
  get track() { return this.stream ? this.stream.getVideoTracks()[0] : null; }
  get mirrored() { return this.facing === 'user'; }

  async start(facing = this.facing) {
    if (!window.isSecureContext) {
      const e = new Error('insecure'); e.name = 'InsecureContext'; throw e;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      const e = new Error('getUserMedia unavailable'); e.name = 'NotSupportedError'; throw e;
    }
    const g = ++this.gen;
    this.stop();
    const constraints = {
      audio: false,
      video: {
        facingMode: { ideal: facing },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30 },
      },
    };
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      if (err.name === 'OverconstrainedError') {
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
      } else {
        throw err;
      }
    }
    if (g !== this.gen) {
      // a newer start() (or stop()) happened while we were waiting: drop this stream
      stream.getTracks().forEach((t) => t.stop());
      const e = new Error('superseded'); e.name = 'AbortError'; throw e;
    }
    this.stream = stream;
    this.facing = facing;
    this.torchOn = false;
    const track = stream.getVideoTracks()[0];
    if (track) track.addEventListener('ended', () => { if (this.stream === stream && this.onEnded) this.onEnded(); });
    const v = this.video;
    v.srcObject = stream;
    v.setAttribute('playsinline', '');
    v.muted = true;
    await v.play().catch(() => {});
    if (!v.videoWidth) {
      await new Promise((res) => {
        const done = () => { v.removeEventListener('loadedmetadata', done); res(); };
        v.addEventListener('loadedmetadata', done);
        setTimeout(done, 3000);
      });
    }
    return stream;
  }

  stop() {
    const st = this.stream;
    this.stream = null;
    if (st) st.getTracks().forEach((t) => t.stop());
  }

  /** Cancel any start() still waiting for permission / hardware. */
  cancelPending() { this.gen++; }

  async flip() {
    const prev = this.facing;
    try {
      return await this.start(prev === 'environment' ? 'user' : 'environment');
    } catch (err) {
      if (err.name !== 'AbortError') await this.start(prev).catch(() => {}); // restore the old camera
      throw err;
    }
  }

  get torchSupported() {
    const tr = this.track;
    if (!tr || !tr.getCapabilities) return false;
    try { return !!tr.getCapabilities().torch; } catch { return false; }
  }

  async setTorch(on) {
    const tr = this.track;
    if (!tr) return false;
    try {
      await tr.applyConstraints({ advanced: [{ torch: !!on }] });
      this.torchOn = !!on;
      return true;
    } catch {
      return false;
    }
  }
}

/** Map a getUserMedia error to an i18n key. */
export function cameraErrorKey(err) {
  switch (err && err.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'err.denied';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'err.notfound';
    case 'InsecureContext':
      return 'err.insecure';
    default:
      return 'err.generic';
  }
}
