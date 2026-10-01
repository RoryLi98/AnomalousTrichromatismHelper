<div align="center">

<img src="docs/icons/icon-192.png" width="88" alt="Color Vision Helper icon">

# Color Vision Helper

**Point your phone at anything to hear its color. Switch on correction to tell red from green.**

A camera web app for people with color blindness or color weakness: no install, no account, and the video never leaves your phone.

[**Open the app →**](https://ruilin.li/AnomalousTrichromatismHelper/) &nbsp;·&nbsp; English &nbsp;·&nbsp; [简体中文](README.zh-CN.md)

<a href="https://ruilin.li/AnomalousTrichromatismHelper/"><img src="https://img.shields.io/badge/version-1.3.6-2ea44f" alt="version 1.3.6"></a>
<img src="https://img.shields.io/badge/PWA-installable-5a0fc8" alt="PWA">
<img src="https://img.shields.io/badge/correction-real--time_WebGL-d9480f" alt="real-time WebGL correction">
<img src="https://img.shields.io/badge/platform-Android_%7C_iOS_15%2B-1f6feb" alt="Android / iOS 15+">
<img src="https://img.shields.io/badge/privacy-on--device_only-2ea44f" alt="on-device only">

<br><br>

<img src="assets/screens-en.png" width="860" alt="Identify, Correct and Tune screens">

<sub><b>Identify</b>: the reticle on the cup reads “Maroon” and outlines the whole region · <b>Correct</b>: the original next to the picture adjusted for a deutan viewer · <b>Tune</b>: a two-minute test that measures your color vision and checks the correction</sub>

</div>

---

## Features

- **Identify colors.** Aim the reticle and get a color name, plus an outline of the whole region of that color.
  - Shadows, highlights and fabric texture don't break an object apart.
  - The outline doesn't leak into similar colors next to it.
- **Basic or exact names.** Choose 12 basic colors (red, orange, yellow…) or 150+ exact names such as “Maroon” and “Olive green”.
  - Each exact name comes with a description like “dark yellow-green”.
  - Colors near a boundary also get a “may also be called…” hint.
  - Switch with **Name: Basic | Exact** on the color card.
- **Real-time correction.** The GPU processes every pixel of the camera feed, turning the red–green differences you can't see into lightness and blue–yellow differences you can. It works for protan, deutan and tritan at 0–100 % severity, with a split-screen view.
- **Two-minute tuning.** It measures your type and severity, then checks the correction on patterns below your own threshold and strengthens it until you can read them.
- **Color-plate tests.** In **Strong** mode at 170–200 %, the hidden number in an Ishihara-style dot plate turns bright blue on yellow.
- **Made for real scenes.**
  - White balance: automatic, or one-tap white-card calibration.
  - Camera: a lens picker, full 4:3 framing, zoom and torch.
  - Also: freeze, gallery photos, spoken names, and five reticle styles that keep the centre clear.
- **English / 中文** in one tap. Everything runs on the phone, and nothing is uploaded.

## Quick start

1. Open **[ruilin.li/AnomalousTrichromatismHelper](https://ruilin.li/AnomalousTrichromatismHelper/)** in your phone's browser and allow the camera.
2. Optional, to run it full-screen like an app:
   - Android Chrome: menu → **Add to Home screen / Install app**.
   - iPhone Safari: Share → **Add to Home Screen**.
3. The first time you switch to **Correct**, tap the yellow **Tune** button, take the test, then tap **Use for correction**.

| I want to… | Do this |
| --- | --- |
| know what color something is | In **Identify**, aim the reticle at it. Tap anywhere to move the reticle, double-tap to recenter. |
| outline more or less | Use the slider on the right: toward **Less** when similar colors merge, toward **More** when a shaded or glossy object isn't fully covered. Swiping up and down on the picture works too, and a short note says what the current setting does. |
| keep the reticle out of the way | Settings → **Reticle**: open cross, ring, brackets, dot or crosshair, in three sizes. |
| tell red from green | Switch to **Correct** and keep **Auto**. If the effect is too weak, raise the strength or pick **Strong**. |
| read a color-plate test | **Strong** at 170–200 %. Fill the frame with the plate, light it evenly and avoid glare. |
| fix yellow or blue lighting | Toolbar **WB** → **White card**, put white paper in the circle and tap **Calibrate**. |
| stop the picture looking zoomed in or square | Toolbar **Lens** → **Whole frame**, or pick another rear camera. The sheet shows the current resolution and aspect ratio. |
| use another lens | Pick it in **Lens**. If the phone doesn't let the browser open it, the app says why and goes back to the previous lens. On Android, Chrome gives the most complete lens, zoom and torch support. |
| be sure I have the latest version | Settings → **Check for updates**. |

## Results

### Everyday scenes

<img src="assets/before-after.jpg" alt="The same photo: original, as seen with deutan 80 %, after Natural, after Balanced">

This is how a viewer with 80 % deuteranomaly sees the photo, simulated with a color-vision model. Compensation alone (**Natural**) is limited by what the screen can show and turns the red into gray-brown. **Balanced** moves the part it cannot compensate into blue–yellow and lightness, so the red motorbike and the green objects separate again.

| Confused color pairs that become distinguishable | Natural | Balanced | Strong |
| --- | :---: | :---: | :---: |
| Deutan 60 % | 70 % | 82 % | 93 % |
| Deutan 80 % | 53 % | 91 % | 96 % |
| Deuteranope (100 %) | 10 % | 79 % | 97 % |
| Protan 80 % | 63 % | 88 % | 94 % |
| Protanope (100 %) | 15 % | 91 % | 97 % |

<sub>5159 color pairs (ΔE 12–60) from five natural photos and everyday colors, with the type and severity set correctly.
<b>Auto</b> picks Strong at 90 % severity or more, and Balanced otherwise.
If everyone is left on the default “deutan 60 %”, Auto still recovers 67–90 %, while compensation alone drops to 21–39 %.
Strong separates the most but also changes colors the most.</sub>

### Color plates

<img src="assets/color-plates.jpg" alt="Six Ishihara-style plates as seen with normal vision, deutan 80 % and deuteranopia, uncorrected and with Strong 200 %">

Six original Ishihara-style plates. Figure and background differ only along the red–green confusion line, and dot lightness is random. Each plate was filmed through a simulated phone camera (warm light, blur, noise, shake, chroma subsampling), sent through the full app, then viewed through the color-vision model.

- **Uncorrected:** neither a deutan-80 % viewer nor a deuteranope can see any number.
- **With Strong 200 %:** all six are readable. Figure/ground separability (d′) is 3.9–16.3, at or above what normal vision gets from the original plates (2.8–7.0).

## How it works

```mermaid
flowchart LR
    CAM["Camera<br/>full 4:3 frame"] --> GPU["WebGL shader<br/>white balance + per-pixel correction"]
    GPU --> SCR["Screen"]
    GPU -- "downsampled readback" --> WK["Web Worker<br/>WB estimate · region segmentation"]
    WK -- "WB gains" --> GPU
    WK --> NAME["Color naming<br/>OKLCH / CIEDE2000"]
    NAME --> UI["Outline + color card"]
```

<details>
<summary><b>Color naming and region outline</b></summary>

- **Color spaces:** sRGB → linear RGB → OKLab / OKLCH, which is perceptually uniform and cheap to compute.
  - Exact names are matched with CIEDE2000. A name gets “≈” when the difference exceeds 12.
  - The 12 basic colors are split by hue, lightness and chroma in OKLCH, with thresholds relative to the sRGB gamut cusp of each hue (brown = dark orange/yellow, pink = light red/rose).
- **Segmentation** runs in a Web Worker, so the interface never stalls:
  1. Downsample to about 80k pixels and apply a 5×5 box filter.
  2. Use shading-invariant chromaticity (a/L, b/L). A shadow scales linear RGB, which leaves this ratio unchanged.
  3. Split the color difference into a hue direction (strict) and a saturation direction (loose), plus a log-lightness ratio.
  4. Widen the tolerance by the robust spread of the texture around the reticle, then multiply by the slider factor k. The factor runs 0.1 → 0.224 over the lower half and 0.224 → 2.0 over the upper half, both geometric, and the default in the middle is k = 0.224.
  5. Hysteresis growth: close “core” pixels spread freely, while edge pixels reach at most 4 pixels, so regions don't leak through thin contacts.
  6. Opening, keep the connected component, closing and hole filling, then Marching Squares for a sub-pixel outline.
  7. Region color: drop the darkest 15 % and brightest 10 %, then take the median chroma and the 60th-percentile lightness.

</details>

<details>
<summary><b>White balance</b></summary>

- **Automatic:**
  - A gray-world estimate on the brightest 15 % of pixels, then two passes over near-neutral pixels to estimate the light color. The object being measured is left out.
  - Correction strength follows the share of gray pixels, and is clamped and smoothed over time.
- **White-card calibration:** per-channel gains are computed directly from the reference white. On Android the camera's own white balance is locked as well.

</details>

<details>
<summary><b>Correction methods</b></summary>

Color-vision deficiency is simulated with the physiological model of Machado et al. (2009) in linear RGB, interpolated over 0–100 % severity.

| Method | For | How |
| --- | --- | --- |
| Auto (default) | most people | Balanced below 90 % severity, Strong at 90 % or more; tritan always uses Balanced |
| Balanced | color weakness | Inverse compensation within the screen gamut (Ro & Yang 2004). The model then estimates the red–green difference e you still miss, and that difference is encoded into blue–yellow and lightness (b −= 1.5·e, L += 0.35·e) |
| Natural | mild color weakness | Inverse compensation with hue-preserving gamut mapping only; colors stay closest to the original |
| Strong | color blindness, plate tests | The whole red–green axis is added onto blue–yellow and lightness in OKLab. Above 100 %, the lightness term grows as (strength − 1)², which beats the lightness camouflage of color plates |
| Simulate | people with normal vision | Shows what a viewer with the chosen deficiency sees |

The GPU shader matches the CPU reference implementation pixel for pixel.

</details>

<details>
<summary><b>Tuning</b></summary>

- **Step 1: measure.**
  - The test uses dot-pattern Landolt C rings in the style of the Cambridge Colour Test, with random dot lightness so that lightness gives no cue.
  - The three test directions are the colors protanopes, deuteranopes and tritanopes find hardest to see (the smallest singular vectors of the Machado matrices).
  - A 2-down/1-up staircase finds each threshold. Type, severity and personal sensitivity are fitted together, so an uncalibrated screen doesn't matter.
- **Step 2: verify.** The model is only an approximation, so the correction is checked on your own eyes.
  - Plates are shown at 60 % of your threshold, where they are invisible without correction: 4 corrected and 3 uncorrected, shuffled.
  - Reading 3 of the 4 corrected plates passes. Otherwise the correction steps up to Balanced 130 %, then Strong 100 %, then Strong 200 %.
- **In simulation,** observers with deutan 50–90 %, protan 70–100 % and tritan 80–100 % ended with a verified setting in 78–100 % of runs.

</details>

## Development

No build step: plain ES modules served from `docs/`.

```bash
npm start              # http://localhost:8765 (localhost may use the camera)
npm test               # unit tests, Node 18+
npm run test:e2e       # end-to-end: synthetic camera video + Playwright Chromium
npm run test:e2e:lens  # lens picker: three fake cameras, failing and slow-to-release opens
                       # end-to-end tests need numpy, Pillow, ffmpeg and playwright
```

To use a real photo as the fake camera:

```bash
python3 tests/make_photo_scene.py photo.png /tmp/real.y4m
python3 tests/e2e_real.py /tmp/real.y4m /tmp/shots
```

The 27 unit tests cover:

- CIEDE2000 reference data, color naming and the Machado matrices;
- separation gains from compensation and Balanced;
- segmentation under strong shading, texture and thin-gap leaks, and the size-slider mapping;
- auto white balance, lens-label parsing and switching to a full 4:3 camera frame;
- tuner fitting and the two-step flow;
- Ishihara-style plates.

<details>
<summary><b>Project layout</b></summary>

```
docs/                       site root (served by GitHub Pages)
├── index.html              page and icon sprite
├── manifest.webmanifest    PWA manifest
├── sw.js                   offline cache
├── css/style.css
├── icons/
└── js/
    ├── main.js             UI and main loop
    ├── gl.js               WebGL renderer and correction shader
    ├── cvd.js              simulate / compensate / balanced / strong
    ├── machado.js          Machado 2009 matrices
    ├── color.js            color spaces and CIEDE2000
    ├── naming.js           basic / exact color names
    ├── segment.js          region segmentation, outline, size slider
    ├── wb.js               auto white balance
    ├── analysis-worker.js  background analysis thread
    ├── camera.js           lens / zoom / torch / WB lock
    ├── reticle.js          reticle styles
    ├── selftest.js         color-vision tuning
    └── i18n.js             English and Chinese strings
tests/                      unit and end-to-end tests
assets/                     README images
```

</details>

<details>
<summary><b>Deploy to GitHub Pages</b></summary>

1. Push to GitHub.
2. In the repository, open **Settings → Pages**. Under **Build and deployment**, choose **Deploy from a branch**, branch `main`, folder **`/docs`**.
3. About a minute later, open `https://<user>.github.io/AnomalousTrichromatismHelper/`. If your user site has a custom domain, project pages appear under that domain automatically, so the project repo needs no custom domain of its own.

Pages on a private repository needs GitHub Pro, Team or Enterprise; the Pages site itself is still public. Browsers only allow the camera on HTTPS pages.

</details>

## Limitations

- **An aid, not a diagnosis.** It does not replace a clinical color-vision exam (Ishihara, FM-100, anomaloscope). The numbers above come from simulated viewers; real people differ, so trust your own Tune result.
- **Cameras shift colors.** Exposure and white balance change what the camera sees.
  - Auto white balance can be off when nothing white or gray is in view; use the white card then.
  - Safari on iPhone doesn't let web pages lock the camera's white balance.
- **Correction changes colors.** Balanced and Strong change the lightness and yellow/blue tint of some colors. The aim is to make colors distinguishable, not to show them as they really are.
- **Browsers limit lens access.**
  - Many Android phones expose only some lenses to browsers and label them only by number.
  - Some browsers, such as Firefox, don't support hardware zoom or the torch yet.

## References

**Methods used in the app**

- G. M. Machado, M. M. Oliveira, L. A. F. Fernandes. A physiologically-based model for simulation of color vision deficiency. *IEEE TVCG* 15(6), 2009.
- Y. M. Ro, S. Yang. Color adaptation for anomalous trichromats. *Int. J. Imaging Systems and Technology* 14, 16–20, 2004.
- B. C. Regan, J. P. Reffin, J. D. Mollon. Luminance noise and the rapid determination of discrimination ellipses in colour deficiency. *Vision Research* 34(10), 1994. (Cambridge Colour Test)
- B. Ottosson. A perceptual color space for image processing (OKLab), 2020.
- G. Sharma, W. Wu, E. N. Dalal. The CIEDE2000 color-difference formula: implementation notes, supplementary test data, and mathematical observations. *Color Research & Application* 30(1), 2005.
- He Z., Zhan P., Li J., Cai J., Zeng X., Zhang X. Partial rectification method of color blindness based on image segmentation. *Computer Systems & Applications* 26(3), 2017. (in Chinese)

**Background reading**

- H. Brettel, F. Viénot, J. D. Mollon. Computerized simulation of color appearance for dichromats. *JOSA A* 14(10), 2647–2655, 1997.
- K. Rasche, R. Geist, J. Westall. Re-coloring images for gamuts of lower dimension. *Computer Graphics Forum* 24(3), 2005.
- K. Rasche, R. Geist, J. Westall. Detail preserving reproduction of color images for monochromats and dichromats. *IEEE Computer Graphics and Applications* 25(3), 2005.
- A. A. Gooch, S. C. Olsen, J. Tumblin, B. Gooch. Color2Gray: salience-preserving color removal. *ACM Transactions on Graphics* 24(3), 2005.
- T. Wachtler, U. Dohrmann, R. Hertel. Modeling color percepts of dichromats. *Vision Research* 44, 2843–2855, 2004.
- C. E. Martin, J. G. Keller, S. K. Rogers, M. Kabrisky. Color blindness and a color human visual system model. *IEEE Trans. SMC — Part A* 30(4), 2000.
- S. Nakauchi, S. Usui. Multilayered neural network models for color blindness. *IJCNN*, 1991.
- J. Lee, W. P. dos Santos. An adaptive fuzzy-based system to simulate, quantify and compensate color blindness. arXiv:1711.10662, 2017.
- Five Chinese theses on color-blindness correction (Sun Y., Liu Y., Bao J., Wang E., Wu L.), listed in the [Chinese README](README.zh-CN.md#参考文献).

---

<div align="center"><sub>Made by <a href="https://ruilin.li">RoryLi98</a></sub></div>
