"""End-to-end test of the lens picker with three fake cameras (Chromium + Playwright).

Simulates two things real Android browsers do:
  * the camera just closed is released late, so opening the next one fails a couple of times
    (NotReadableError) before it works;
  * a lens the system does not expose to browsers always fails (AbortError, as Firefox reports it).
The picker must switch in the first case, and in the second say so and go back to the previous lens
instead of silently reopening the main camera.

  (cd docs && python3 -m http.server 8765 &)
  python3 tests/e2e_lens.py /tmp/shots
"""
import sys, os, json
from playwright.sync_api import sync_playwright

OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/shots'
URL = os.environ.get('APP_URL', 'http://localhost:8765/')
os.makedirs(OUT, exist_ok=True)

# wrap getUserMedia: device #1 fails twice then works, device #2 always fails
HOOK = """
(() => {
  localStorage.setItem('cvh.settings.v1', JSON.stringify({ tipsShown: true, autoMainDone: true, lang: 'zh' }));
  const md = navigator.mediaDevices, orig = md.getUserMedia.bind(md);
  window.__gum = { calls: [], fails: {} };
  md.getUserMedia = async (c) => {
    const devs = (await md.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    const id = c && c.video && c.video.deviceId && c.video.deviceId.exact;
    const idx = devs.findIndex((d) => d.deviceId === id);
    window.__gum.calls.push(idx);
    if (idx === 1 && (window.__gum.fails[1] = (window.__gum.fails[1] || 0) + 1) <= 2) {
      throw new DOMException('Could not start video source', 'NotReadableError');
    }
    if (idx === 2) throw new DOMException('Starting videoinput failed', 'AbortError');
    return orig(c);
  };
})();
"""

errors, results = [], {}
with sync_playwright() as p:
    browser = p.chromium.launch(args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream=device-count=3',
                                      '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
    ctx = browser.new_context(viewport={'width': 390, 'height': 760}, device_scale_factor=2, is_mobile=True, has_touch=True,
                              locale='zh-CN', permissions=['camera'])
    ctx.add_init_script(HOOK)
    page = ctx.new_page()
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(URL)
    page.wait_for_timeout(1200)
    if page.is_visible('#start'):
        page.click('#btnStart')
    page.wait_for_function("() => window.__cvh && document.getElementById('video').videoWidth > 0", timeout=30000)
    ids = page.evaluate("async () => (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput').map(d => d.deviceId)")
    cur = lambda: ids.index(page.evaluate("() => window.__cvh.camera.deviceId"))
    results['start'] = cur()

    page.click('#btnLens'); page.wait_for_timeout(600)
    items = page.locator('#camList .cam-item')
    results['listed'] = items.count()
    results['limits_hint'] = page.is_visible('#camLimits')

    # lens 2 (index 1): fails twice while the old camera is released, then opens
    page.evaluate("window.__gum.calls = []")
    page.locator('#camList .cam-item').nth(1).click()
    page.wait_for_function("() => !document.querySelector('#camList .cam-item[disabled]')", timeout=20000)
    page.wait_for_timeout(400)
    results['after_lens2'] = cur()
    results['lens2_calls'] = page.evaluate("window.__gum.calls")
    page.screenshot(path=f'{OUT}/lens_switched.png')

    # lens 3 (index 2): always fails -> message, back to lens 2, item marked
    page.evaluate("window.__gum.calls = []")
    page.locator('#camList .cam-item').nth(2).click()
    page.wait_for_function("() => document.getElementById('toast').classList.contains('show')", timeout=20000)
    results['toast'] = page.inner_text('#toast')
    page.wait_for_function("() => !document.querySelector('#camList .cam-item[disabled]')", timeout=20000)
    page.wait_for_timeout(600)
    results['after_lens3'] = cur()
    results['lens3_calls'] = page.evaluate("window.__gum.calls")
    results['marked_failed'] = page.locator('#camList .cam-item.failed').count()
    results['live'] = page.evaluate("() => window.__cvh.camera.live && document.getElementById('video').videoWidth > 0")
    page.screenshot(path=f'{OUT}/lens_failed.png')
    browser.close()

ok = (results['listed'] == 3 and results['after_lens2'] == 1 and results['after_lens3'] == 1
      and results['marked_failed'] == 1 and results['live'] and '打不开' in results['toast'] and not errors)
print(json.dumps(results, ensure_ascii=False, indent=1))
print('errors:', errors)
print('OK' if ok else 'FAIL')
sys.exit(0 if ok else 1)
