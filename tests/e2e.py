"""End-to-end test with a fake camera (Chromium + Playwright).

Usage:
  python3 tests/make_scene.py /tmp/scene.y4m        # synthetic camera video
  (cd docs && python3 -m http.server 8765 &)
  python3 tests/e2e.py /tmp/scene.y4m /tmp/shots
"""
import sys, json, os, time
from playwright.sync_api import sync_playwright

Y4M = sys.argv[1] if len(sys.argv) > 1 else '/tmp/scene.y4m'
OUT = sys.argv[2] if len(sys.argv) > 2 else '/tmp/shots'
URL = os.environ.get('APP_URL', 'http://localhost:8765/')
os.makedirs(OUT, exist_ok=True)
errors = []
results = {}

def state(page):
    return page.evaluate("""() => { const {R,S} = window.__cvh; const n = R.lastNaming;
      return n ? {basic: n.basicKey, detailed: n.detailed.en, desc: n.desc.en, rgb: R.lastRgb,
                  area: R.lastRes ? R.lastRes.area : null, segs: R.lastRes ? R.lastRes.segCount : 0,
                  name: document.getElementById('colorName').textContent,
                  alt: document.getElementById('colorAlt').textContent,
                  kind: R.kind, gl: R.glOk, mode: S.mode} : null; }""")

with sync_playwright() as p:
    browser = p.chromium.launch(args=[
        '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
        f'--use-file-for-fake-video-capture={Y4M}',
        '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    ])
    ctx = browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=float(os.environ.get('DPR', '1')),
                              is_mobile=True, has_touch=True, locale='zh-CN',
                              permissions=['camera'])
    page = ctx.new_page()
    page.on('console', lambda m: errors.append(f'{m.type}: {m.text}') if m.type in ('error', 'warning') else None)
    page.on('pageerror', lambda e: errors.append(f'pageerror: {e}'))
    page.goto(URL)
    page.wait_for_timeout(800)
    page.screenshot(path=f'{OUT}/01_start.png')
    if page.is_visible('#start'):
        page.click('#btnStart')
    page.wait_for_function("() => window.__cvh && window.__cvh.R.lastNaming", timeout=15000)
    # this test maps scene coordinates assuming the picture fills the screen
    page.evaluate("() => { window.__cvh.S.frame = 'fill'; window.__cvh.layout(); }")
    page.wait_for_timeout(1500)
    results['center'] = state(page)
    page.screenshot(path=f'{OUT}/02_identify_basic.png')

    # map scene px -> view fraction: crop is cover; video 720x1280, view 390x844 (aspect .462 vs .5625)
    vw, vh = page.evaluate("() => [document.getElementById('video').videoWidth, document.getElementById('video').videoHeight]")
    def scene_to_view(sx, sy):
        # Chrome's fake camera center-crops the 720x1280 y4m to the delivered size
        fx, fy = sx - (720 - vw) / 2, sy - (1280 - vh) / 2
        va = 390 / 844
        if vw / vh > va: ch = vh; cw = vh * va
        else: cw = vw; ch = vw / va
        return ((fx - (vw - cw) / 2) / cw, (fy - (vh - ch) / 2) / ch)
    expected = {'leaf': ((360, 305), 'green'), 'blue': ((360, 1015), 'blue'), 'pink': ((615, 190), 'pink'),
                'white': ((120, 190), 'white'), 'yellow': ((130, 1020), 'yellow'), 'wall': ((600, 450), None),
                'table': ((300, 1200), 'brown')}
    for name, ((sx, sy), want) in expected.items():
        vx, vy = scene_to_view(sx, sy)
        page.evaluate(f"window.__cvh.setReticle({vx}, {vy})")
        page.wait_for_timeout(1200)
        st = state(page)
        st['expected'] = want
        st['ok'] = (want is None) or st['basic'] == want
        results[name] = st
    # a real touch tap on the leaf moves the reticle there
    vx, vy = scene_to_view(360, 300)
    page.touchscreen.tap(vx * 390, vy * 844)
    page.wait_for_timeout(1200)
    results['tap_leaf'] = state(page)
    page.screenshot(path=f'{OUT}/03_identify_wall.png')

    # detailed set + english + dim outside
    vx, vy = scene_to_view(360, 640)
    page.evaluate(f"window.__cvh.setReticle({vx}, {vy})")
    page.click('#setSeg button[data-set=detailed]')
    page.click('#btnLang')
    page.wait_for_timeout(800)
    results['detailed_en'] = state(page)
    page.screenshot(path=f'{OUT}/04_detailed_en.png')

    # settings sheet
    page.click('#btnSettings')
    page.wait_for_timeout(300)
    page.screenshot(path=f'{OUT}/05_settings.png')
    page.click('#optDim', force=True)
    page.click('#btnSettingsClose')
    page.wait_for_timeout(700)
    page.screenshot(path=f'{OUT}/06_dim.png')

    # correction mode
    page.click('#btnLang')  # back to zh
    page.click('#modeCorrect')
    page.wait_for_timeout(700)
    page.screenshot(path=f'{OUT}/07_correct.png')
    page.click('#optSplit', force=True)
    page.click('#methodChips button[data-method=enhance]')
    page.wait_for_timeout(700)
    page.screenshot(path=f'{OUT}/08_correct_split_enhance.png')
    page.click('#optPreview', force=True)
    page.wait_for_timeout(700)
    page.screenshot(path=f'{OUT}/09_preview.png')
    # read pixel from view canvas to verify processing changes the image (via WebGL readback of a 2D copy)
    results['gl'] = page.evaluate("""() => new Promise(res => requestAnimationFrame(() => {
        const v = document.getElementById('view');
        const c = document.createElement('canvas'); c.width = v.width; c.height = v.height;
        const x = c.getContext('2d'); x.drawImage(v, 0, 0);
        const px = (fx, fy) => Array.from(x.getImageData(Math.round(fx*c.width), Math.round(fy*c.height), 1, 1).data.slice(0,3));
        res({left_original: px(0.45, 0.45), right_processed: px(0.55, 0.45)});
    }))""")

    # self-test sheet
    page.click('#optPreview', force=True)
    page.click('#optSplit', force=True)
    page.click('#btnTest')
    page.wait_for_timeout(300)
    page.click('#btnTestStart')
    page.wait_for_timeout(300)
    page.screenshot(path=f'{OUT}/10_selftest.png')
    # answer randomly until done
    for i in range(40):
        if page.is_visible('#testResult'):
            break
        page.click('.dir-pad button[data-dir="-1"]')
    page.wait_for_timeout(300)
    page.screenshot(path=f'{OUT}/11_selftest_result.png')
    results['selftest'] = page.inner_text('#testResultText')

    # freeze & photo flows
    page.click('#btnTestClose')
    page.click('#modeIdentify')
    page.click('#btnFreeze')
    page.wait_for_timeout(500)
    results['frozen'] = state(page)
    page.screenshot(path=f'{OUT}/12_frozen.png')
    # photo from the gallery (letterboxed into the view), reticle back at the center
    photo = os.environ.get('PHOTO')
    if photo:
        page.evaluate("window.__cvh.setReticle(0.5, 0.5)")
        page.set_input_files('#fileInput', photo)
        page.wait_for_timeout(2000)
        results['photo'] = state(page)
        page.screenshot(path=f'{OUT}/13_photo.png')
    browser.close()

print(json.dumps(results, ensure_ascii=False, indent=1))
print('--- console errors/warnings ---')
for e in errors: print(e)
