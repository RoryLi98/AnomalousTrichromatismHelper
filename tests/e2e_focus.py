"""End-to-end test of locked focus (docs/js/focus.js wired into the app) with Chrome's fake camera.

  python3 tests/make_scene.py /tmp/scene.y4m
  (cd docs && python3 -m http.server 8765 &)
  python3 tests/e2e_focus.py /tmp/scene.y4m /tmp/shots

The fake camera has no focus control, so the page is given Android-Chrome-like focus capabilities
(focusMode manual/continuous, focusDistance 0.1–5 m) and focus constraints are recorded instead of
applied; the sharpness comes from a simulated lens (subject at 0.4 m = 2.5 diopters). Checks:
  * the camera starts → one sweep, the lens is parked at the subject
  * a tap on the picture → a short local search, still parked at the subject
  * freezing during a search stops it and puts the lens back at the last good position
  * Lens sheet: "Camera auto" gives the focus back (continuous), "Lock focus" focuses again
  * a scene without detail: the camera's own autofocus is used, the camera is not marked as bad
  * a camera without focus control: the setting explains it and stays disabled; no errors
"""
import sys, os, json
from playwright.sync_api import sync_playwright

Y4M, OUT = sys.argv[1], sys.argv[2]
URL = os.environ.get('APP_URL', 'http://localhost:8765/')
os.makedirs(OUT, exist_ok=True)

FAKE_FOCUS = """
(() => {
  window.__focusCalls = [];
  const gc = MediaStreamTrack.prototype.getCapabilities;
  MediaStreamTrack.prototype.getCapabilities = function () {
    const c = gc ? gc.call(this) : {};
    if (this.kind === 'video') { c.focusMode = ['manual', 'single-shot', 'continuous']; c.focusDistance = { min: 0.1, max: 5, step: 0.01 }; }
    return c;
  };
  const ac = MediaStreamTrack.prototype.applyConstraints;
  MediaStreamTrack.prototype.applyConstraints = function (c) {
    const adv = c && c.advanced;
    if (adv && adv.some((a) => 'focusMode' in a || 'focusDistance' in a)) { window.__focusCalls.push(adv[0]); return Promise.resolve(); }
    return ac.call(this, c);
  };
})();
"""
SIM = """(flat) => { window.__cvh.AF.sim = (D, scale) => {
  if (flat || D == null) return 1;
  const d = D - 2.5, s = scale === 'coarse' ? 0.9 : 0.22, a = scale === 'coarse' ? 6 : 10;
  return 1 + a * Math.exp(-d * d / (2 * s * s));
}; }"""
AFSTATE = """() => { const A = window.__cvh.AF; const c = window.__focusCalls || [];
  return { locked: A.locked, D: A.D, lockedD: A.lockedD, manual: A.manual, running: !!A.running, calls: c.length,
    last: c[c.length - 1] || null, bad: window.__cvh.S.focusBad, ring: !document.getElementById('afRing').hidden }; }"""

def wait_locked(page, timeout=20000):
    page.wait_for_function("() => window.__cvh.AF.locked && !window.__cvh.AF.running", timeout=timeout)

results, errors = {}, []
with sync_playwright() as p:
    b = p.chromium.launch(args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
                                f'--use-file-for-fake-video-capture={Y4M}', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, locale='zh-CN', permissions=['camera'])
    ctx.add_init_script(FAKE_FOCUS)
    page = ctx.new_page()
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(URL)
    page.wait_for_function("() => window.__cvh && window.__cvh.AF", timeout=10000)
    page.evaluate(SIM, False)  # before the first sweep (it starts ~0.9 s after the camera)
    page.wait_for_timeout(1000)
    if page.is_visible('#start'): page.click('#btnStart')
    page.wait_for_function("() => window.__cvh.R.kind === 'camera'", timeout=30000)
    page.wait_for_function("() => !!window.__cvh.AF.running", timeout=5000)
    results['during'] = page.evaluate(AFSTATE)
    page.screenshot(path=f'{OUT}/af_focusing.png')
    wait_locked(page)
    results['start'] = page.evaluate(AFSTATE)

    # tap somewhere else on the picture: a short local search
    n0 = results['start']['calls']
    rc = page.evaluate("() => window.__cvh.R.rect")
    page.mouse.click(rc['x'] + rc['w'] * 0.3, rc['y'] + rc['h'] * 0.6)
    page.wait_for_function("() => !!window.__cvh.AF.running", timeout=3000)
    wait_locked(page)
    results['tap'] = page.evaluate(AFSTATE)
    results['tapCalls'] = results['tap']['calls'] - n0

    # freeze in the middle of a full search: stopped, lens back at the last good position
    good = results['tap']['lockedD']
    page.evaluate("() => { window.__cvh.AF.D = 0.5; window.__cvh.focusAt(window.__cvh.R.reticle, 'full'); }")
    page.wait_for_function("() => !!window.__cvh.AF.running", timeout=3000)
    page.wait_for_timeout(120)
    page.evaluate("() => window.__cvh.freeze()")
    page.wait_for_function("() => window.__cvh.R.kind === 'frozen' && !window.__cvh.AF.running", timeout=15000)
    results['freeze'] = page.evaluate(AFSTATE)
    results['freezeGood'] = good
    page.evaluate("() => window.__cvh.resumeLive()"); page.wait_for_timeout(300)

    # Lens sheet: camera auto, then lock again
    page.click('#btnLens'); page.wait_for_timeout(300)
    results['sheet'] = page.evaluate("() => ({ disabled: [...document.querySelectorAll('#focusSeg button')].map(b => b.disabled), sel: [...document.querySelectorAll('#focusSeg button')].map(b => b.getAttribute('aria-selected')), desc: document.getElementById('focusDesc').textContent })")
    page.screenshot(path=f'{OUT}/af_sheet.png')
    page.click('#focusSeg button[data-focus=auto]'); page.wait_for_timeout(300)
    results['auto'] = page.evaluate(AFSTATE)
    page.click('#focusSeg button[data-focus=lock]')
    page.wait_for_function("() => !!window.__cvh.AF.running", timeout=3000)
    wait_locked(page)
    results['relock'] = page.evaluate(AFSTATE)
    page.click('#btnCamClose')

    # nothing to focus on: back to the camera's autofocus, not marked as bad
    page.evaluate(SIM, True)
    page.evaluate("() => window.__cvh.AF.D = null")
    page.evaluate("() => window.__cvh.focusAt(window.__cvh.R.reticle, 'full')")
    page.wait_for_function("() => !window.__cvh.AF.running", timeout=20000)
    results['flat'] = page.evaluate(AFSTATE)
    ctx.close()

    # a camera without focus control
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, locale='zh-CN', permissions=['camera'])
    page = ctx.new_page()
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(URL); page.wait_for_timeout(1200)
    if page.is_visible('#start'): page.click('#btnStart')
    page.wait_for_function("() => window.__cvh && window.__cvh.R.kind === 'camera'", timeout=30000)
    page.wait_for_timeout(1500)
    rc = page.evaluate("() => window.__cvh.R.rect")
    page.mouse.click(rc['x'] + rc['w'] * 0.4, rc['y'] + rc['h'] * 0.5); page.wait_for_timeout(300)
    page.click('#btnLens'); page.wait_for_timeout(300)
    results['noFocus'] = page.evaluate("() => ({ disabled: [...document.querySelectorAll('#focusSeg button')].every(b => b.disabled), desc: document.getElementById('focusDesc').textContent, locked: window.__cvh.AF.locked, running: !!window.__cvh.AF.running })")
    ctx.close()
    b.close()

print(json.dumps(results, ensure_ascii=False, indent=1))
R = results
near = lambda d, t=0.2: d is not None and abs(d - 2.5) < t
checks = {
    'focusing ring shown while searching': R['during']['ring'] and R['during']['running'],
    'camera start: parked at the subject (manual focus)': R['start']['locked'] and near(R['start']['lockedD']) and R['start']['last']['focusMode'] == 'manual'
        and abs(R['start']['last']['focusDistance'] - 0.4) < 0.04 and not R['start']['ring'],
    'tap: short local search, still at the subject': near(R['tap']['lockedD']) and 3 <= R['tapCalls'] <= 10,
    'freeze stops a search and restores the lens': not R['freeze']['running'] and R['freeze']['last']['focusMode'] == 'manual'
        and abs(R['freeze']['last']['focusDistance'] - 1 / R['freezeGood']) < 0.01,
    'lens sheet: lock selected and enabled': R['sheet']['disabled'] == [False, False] and R['sheet']['sel'] == ['true', 'false'] and '锁定对焦' in R['sheet']['desc'],
    'camera auto gives the focus back': R['auto']['last'] == {'focusMode': 'continuous'} and not R['auto']['locked'],
    'lock again focuses again': R['relock']['locked'] and near(R['relock']['lockedD']),
    'no detail: camera autofocus, not marked bad': not R['flat']['locked'] and R['flat']['last'] == {'focusMode': 'continuous'} and not R['flat']['bad'],
    'camera without focus control: explained, disabled': R['noFocus']['disabled'] and '不能' in R['noFocus']['desc'] and not R['noFocus']['locked'],
    'no page errors': not errors,
}
for k, v in checks.items(): print(('PASS ' if v else 'FAIL ') + k)
print('errors:', errors)
sys.exit(0 if all(checks.values()) else 1)
