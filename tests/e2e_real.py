"""End-to-end test on a real photo fed through Chrome's fake camera.

  python3 tests/make_photo_scene.py coffee.png /tmp/real.y4m
  (cd docs && python3 -m http.server 8765 &)
  python3 tests/e2e_real.py /tmp/real.y4m /tmp/shots
Points are given in photo coordinates (fractions of the photo area at the top of the frame).
"""
import sys, os, json
from playwright.sync_api import sync_playwright

Y4M, OUT = sys.argv[1], sys.argv[2]
POINTS = json.loads(os.environ.get('POINTS', '{"cup": [0.38, 0.55, "red"], "wood": [0.88, 0.45, "brown"], "crema": [0.47, 0.28, "orange"]}'))
URL = os.environ.get('APP_URL', 'http://localhost:8765/')
FRAME_W, FRAME_H, STRIP = 960, 720, 90
os.makedirs(OUT, exist_ok=True)
errors, results = [], {}

STATE = """() => { const {R,S} = window.__cvh; const n = R.lastNaming; if (!n) return null;
  return {basic: n.basicKey, alt: n.altKey, detailed: n.detailed.en, desc: n.desc.en, rgb: R.lastRgb, src: R.colorSrc,
          area: R.lastRes ? +R.lastRes.area.toFixed(4) : null, wb: R.autoWB.map(v => +v.toFixed(3)), cast: R.autoCast,
          wbMode: S.wbMode, rect: R.rect, sens: S.segSens, status: document.getElementById('colorStatus').textContent,
          name: document.getElementById('colorName').textContent}; }"""

def frame_to_view(page, fx, fy):
    """photo-area fraction -> reticle fraction of the displayed picture"""
    vw, vh = page.evaluate("() => [document.getElementById('video').videoWidth, document.getElementById('video').videoHeight]")
    # Chrome's fake camera scales/crops the y4m to the delivered size; we requested 4:3 = same aspect
    sx, sy = fx * FRAME_W, fy * (FRAME_H - STRIP)
    return sx / FRAME_W, sy / FRAME_H

def settle(page, n=3, timeout=30000):
    page.evaluate("() => { window.__c0 = window.__cvh.R.resCount || 0; }")
    page.wait_for_function(f"() => (window.__cvh.R.resCount || 0) >= window.__c0 + {n}", timeout=timeout)

with sync_playwright() as p:
    browser = p.chromium.launch(args=[
        '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
        f'--use-file-for-fake-video-capture={Y4M}',
        '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
    ctx = browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=1, is_mobile=True,
                              has_touch=True, locale='zh-CN', permissions=['camera'])
    page = ctx.new_page()
    page.on('console', lambda m: errors.append(f'{m.type}: {m.text}') if m.type == 'error' else None)
    page.on('pageerror', lambda e: errors.append(f'pageerror: {e}'))
    page.goto(URL)
    page.wait_for_timeout(1500)  # the app auto-starts the camera when permission is already granted
    if page.is_visible('#start'):
        page.click('#btnStart', timeout=5000)
    page.wait_for_function("() => window.__cvh && window.__cvh.R.lastNaming && window.__cvh.R.lastRes", timeout=30000)
    settle(page, 4)
    results['video'] = page.evaluate("() => [document.getElementById('video').videoWidth, document.getElementById('video').videoHeight]")
    results['start'] = page.evaluate(STATE)
    page.screenshot(path=f'{OUT}/r01_fit.png')

    for name, (fx, fy, want) in POINTS.items():
        vx, vy = frame_to_view(page, fx, fy)
        page.evaluate(f"window.__cvh.setReticle({vx}, {vy})")
        settle(page, 3)
        st = page.evaluate(STATE); st['expected'] = want; st['ok'] = st['basic'] == want
        results[name] = st
        page.screenshot(path=f'{OUT}/r_{name}.png')

    # the white paper strip: auto WB should call it white
    page.evaluate(f"window.__cvh.setReticle(0.5, {(FRAME_H - STRIP / 2) / FRAME_H})")
    settle(page, 4)
    results['paper_auto'] = page.evaluate(STATE)
    page.screenshot(path=f'{OUT}/r_paper_auto.png')
    page.click('#btnWBTool'); page.wait_for_timeout(200)
    page.click('#wbSeg button[data-wb=off]')
    settle(page, 3)
    results['paper_off'] = page.evaluate(STATE)
    page.click('#wbSeg button[data-wb=manual]')
    page.wait_for_timeout(200)
    page.screenshot(path=f'{OUT}/r_wb_pop.png')
    page.click('#btnWBCal')
    page.wait_for_timeout(1500)
    settle(page, 3)
    results['paper_manual'] = page.evaluate(STATE)
    results['manual_gains'] = page.evaluate("() => window.__cvh.S.wb")
    page.click('#wbClose')

    # range control changes the region size
    vx, vy = frame_to_view(page, *POINTS['cup'][:2])
    page.evaluate(f"window.__cvh.setReticle({vx}, {vy})")
    areas = {}
    for s in (0.3, 0.6, 1.2):
        page.evaluate(f"window.__cvh.setSens({s})")
        settle(page, 3)
        areas[s] = page.evaluate("() => window.__cvh.R.lastRes.area")
    results['range_areas'] = areas
    page.screenshot(path=f'{OUT}/r_range.png')
    page.evaluate("window.__cvh.setSens(0.6)")

    # lens sheet + framing
    page.click('#btnLens'); page.wait_for_timeout(600)
    results['cams'] = page.eval_on_selector_all('#camList .cam-item', 'els => els.map(e => e.textContent)')
    page.screenshot(path=f'{OUT}/r_lens.png')
    page.click('#frameSeg button[data-frame=fill]'); page.wait_for_timeout(300)
    results['rect_fill'] = page.evaluate("() => window.__cvh.R.rect")
    page.click('#frameSeg button[data-frame=fit]'); page.wait_for_timeout(300)
    results['rect_fit'] = page.evaluate("() => window.__cvh.R.rect")
    page.click('#btnCamClose')
    # digital zoom chips
    chips = page.eval_on_selector_all('#zoomChips button', 'els => els.map(e => e.textContent)')
    results['zoom_chips'] = chips
    if chips:
        page.click('#zoomChips button[data-z="2"]'); page.wait_for_timeout(500)
        results['zoom'] = page.evaluate("() => window.__cvh.R.zoom")
        page.screenshot(path=f'{OUT}/r_zoom2.png')
        page.click('#zoomChips button[data-z="1"]')
    # correct mode: no colour identification at all
    page.click('#modeCorrect'); page.wait_for_timeout(800)
    page.screenshot(path=f'{OUT}/r_correct.png')
    page.touchscreen.tap(195, 330); page.wait_for_timeout(600)   # collapses the panel
    page.touchscreen.tap(120, 300); page.wait_for_timeout(600)   # must not move a reticle
    results['correct'] = page.evaluate("""() => ({ card: getComputedStyle(document.getElementById('card')).display,
        reticle: getComputedStyle(document.getElementById('reticle')).display,
        range: getComputedStyle(document.getElementById('rangeCtl')).display,
        reticlePos: window.__cvh.R.reticle, region: window.__cvh.R.lastRes, rect: window.__cvh.R.rect })""")
    page.screenshot(path=f'{OUT}/r_correct_collapsed.png')
    browser.close()

print(json.dumps(results, ensure_ascii=False, indent=1))
print('--- errors ---')
for e in errors: print(e)
