"""Build a fake-camera video (4:3, y4m) from a real photo for tests/e2e_real.py.

The photo fills the top of the frame; the bottom strip is "white paper" lit by the same warm
light (so automatic / white-card white balance has a reference), with sensor noise and a small
hand-shake. Usage: python3 tests/make_photo_scene.py photo.png /tmp/real.y4m
(needs numpy, Pillow, ffmpeg; any photo works, e.g. scikit-image's data/coffee.png)"""
import sys, os, subprocess, tempfile
import numpy as np
from PIL import Image

src, out = sys.argv[1], sys.argv[2]
W, H, STRIP = 960, 720, 90
photo = Image.open(src).convert('RGB').resize((W, H - STRIP), Image.LANCZOS)
frame = np.zeros((H, W, 3), np.float64)
frame[:H - STRIP] = np.asarray(photo, np.float64)
# white paper under warm light: linear (0.75,0.75,0.75) * (1, 0.86, 0.66), slight falloff
y = np.linspace(0, 1, STRIP)[:, None, None]
lin = 0.75 * np.array([1.0, 0.86, 0.66]) * (1 - 0.12 * y) * np.ones((STRIP, W, 3))
srgb = np.where(lin <= 0.0031308, lin * 12.92, 1.055 * lin ** (1 / 2.4) - 0.055) * 255
frame[H - STRIP:] = srgb
rng = np.random.default_rng(2)
with tempfile.TemporaryDirectory() as tmp:
    for f in range(20):
        dx, dy = int(round(2 * np.sin(f / 20 * 2 * np.pi))), int(round(2 * np.cos(f / 20 * 2 * np.pi)))
        fr = np.roll(np.roll(frame, dy, 0), dx, 1) + rng.normal(0, 2.5, frame.shape)
        Image.fromarray(np.clip(fr, 0, 255).astype(np.uint8)).save(os.path.join(tmp, f'f{f:03d}.png'))
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-framerate', '15', '-i', os.path.join(tmp, 'f%03d.png'),
                    '-pix_fmt', 'yuv420p', out], check=True)
print('wrote', out)
