"""A dim, warm-lit camera scene (y4m) for tests/e2e_truecolor.py.

The colours are what the simulated phone (论文资料/真色测量调研/仿真代码, phone.py) records for this
scene at 3 lux under a 2700 K LED: an orange object (#FFA500 in daylight) next to white paper on a
light wall, a blue box, a dark floor, and a ColorChecker. In the picture the orange reads as brown.
Usage: python3 tests/make_tc_scene.py /tmp/tc.y4m [--no-paper]   (needs numpy, Pillow, ffmpeg)
Writes the chart's corner-patch centres (fractions of the frame) to <out>.json.
"""
import sys, os, json, subprocess, tempfile
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

out = sys.argv[1] if len(sys.argv) > 1 else '/tmp/tc.y4m'
paper = '--no-paper' not in sys.argv
W, H = 960, 720
C = {'wall': (95, 96, 80), 'floor': (31, 26, 15), 'blue': (18, 25, 48), 'target': (109, 81, 40), 'paper': (115, 116, 100)}
CC = [[41, 32, 23], [84, 68, 54], [41, 50, 54], [37, 43, 22], [54, 54, 62], [61, 84, 66], [90, 59, 31], [28, 35, 56],
      [77, 37, 39], [29, 24, 30], [75, 86, 39], [98, 77, 38], [15, 23, 44], [44, 61, 37], [65, 27, 28], [108, 97, 45],
      [72, 40, 53], [31, 53, 60], [121, 122, 102], [95, 95, 80], [71, 74, 61], [49, 50, 43], [30, 31, 28], [16, 17, 13]]
rng = np.random.default_rng(2)
img = Image.new('RGB', (W, H), C['wall'])
d = ImageDraw.Draw(img)
d.rectangle([0, 470, W, H], fill=C['floor'])
d.ellipse([480 - 105, 300 - 105, 480 + 105, 300 + 105], fill=C['target'])       # the object
if paper:
    d.rectangle([640, 210, 770, 390], fill=C['paper'])                           # white paper next to it
d.rectangle([140, 160, 290, 300], fill=C['blue'])
# ColorChecker 4 x 6 on the floor, lower left
px0, py0, P, G = 60, 500, 40, 8
corners = {}
for i, c in enumerate(CC):
    r, k = divmod(i, 6)
    x, y = px0 + k * (P + G), py0 + r * (P + G)
    d.rectangle([x, y, x + P - 1, y + P - 1], fill=tuple(c))
    if i in (0, 5, 23, 18):
        corners[i] = [(x + P / 2) / W, (y + P / 2) / H]
d.rectangle([px0 - 8, py0 - 8, px0 + 6 * (P + G), py0 + 4 * (P + G)], outline=(10, 10, 10), width=6)
arr = np.array(img.filter(ImageFilter.GaussianBlur(0.8))).astype(float)
with tempfile.TemporaryDirectory() as tmp:
    for f in range(20):  # sensor noise, no motion (the phone is held still)
        fr = arr + rng.normal(0, 1.5, arr.shape)
        Image.fromarray(np.clip(fr, 0, 255).astype(np.uint8)).save(os.path.join(tmp, f'f{f:03d}.png'))
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-framerate', '15', '-i', os.path.join(tmp, 'f%03d.png'),
                    '-pix_fmt', 'yuv420p', out], check=True)
json.dump({'target': [480 / W, 300 / H], 'paper': [705 / W, 300 / H], 'corners': [corners[0], corners[5], corners[23], corners[18]]},
          open(out + '.json', 'w'))
print('wrote', out)
