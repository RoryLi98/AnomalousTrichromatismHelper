"""Generate a synthetic 720x1280 camera scene (y4m) for tests/e2e.py.
Usage: python3 tests/make_scene.py /tmp/scene.y4m   (needs numpy, Pillow, ffmpeg)"""
import sys, os, subprocess, tempfile
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

out = sys.argv[1] if len(sys.argv) > 1 else '/tmp/scene.y4m'
W, H = 720, 1280
rng = np.random.default_rng(1)
y = np.linspace(0, 1, H)[:, None, None]
top, bot = np.array([218, 211, 198]), np.array([196, 188, 175])
wall = np.broadcast_to(top * (1 - y) + bot * y, (H, W, 3)).copy()
img = Image.fromarray(wall.astype(np.uint8))
d = ImageDraw.Draw(img)
d.rectangle([0, 860, W, H], fill=(120, 86, 60))                        # table
yy, xx = np.mgrid[0:H, 0:W]
a = np.array(img).astype(float)
m = np.hypot(xx - 360, yy - 640) < 150                                  # shaded red apple
shade = 1.0 - 0.35 * np.clip(np.hypot(xx - 307, yy - 587) / 240, 0, 1)
for k, c in enumerate((200, 24, 40)): a[..., k][m] = c * shade[m]
img = Image.fromarray(a.astype(np.uint8)); d = ImageDraw.Draw(img)
d.ellipse([230, 230, 490, 380], fill=(58, 125, 44))                      # green leaf
d.polygon([(360, 470), (345, 385), (375, 385)], fill=(90, 60, 30))     # stem
d.rectangle([250, 930, 470, 1100], fill=(31, 78, 156))                  # blue box
d.ellipse([60, 950, 200, 1090], fill=(240, 200, 30))                    # yellow ball
d.rectangle([520, 920, 680, 1110], fill=(110, 70, 40))                  # brown block
d.rectangle([540, 120, 690, 260], fill=(230, 120, 170))                 # pink card
d.rectangle([30, 120, 180, 260], fill=(250, 250, 248))                  # white card
arr = np.array(img.filter(ImageFilter.GaussianBlur(1.2))).astype(float)
with tempfile.TemporaryDirectory() as tmp:
    for f in range(30):  # small circular camera shake + sensor noise
        dx, dy = int(round(3 * np.sin(f / 30 * 2 * np.pi))), int(round(2 * np.cos(f / 30 * 2 * np.pi)))
        fr = np.roll(np.roll(arr, dy, 0), dx, 1) + rng.normal(0, 3.0, arr.shape)
        Image.fromarray(np.clip(fr, 0, 255).astype(np.uint8)).save(os.path.join(tmp, f'f{f:03d}.png'))
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-framerate', '15', '-i', os.path.join(tmp, 'f%03d.png'),
                    '-pix_fmt', 'yuv420p', out], check=True)
print('wrote', out)
