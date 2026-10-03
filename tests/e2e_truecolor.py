"""End-to-end test of the Real (true colour) and Screen scenes with a dim, warm-lit scene through
Chrome's fake camera.

  python3 tests/make_tc_scene.py /tmp/tc.y4m && python3 tests/make_tc_scene.py /tmp/tc_nopaper.y4m --no-paper
  (cd docs && python3 -m http.server 8765 &)
  python3 tests/e2e_truecolor.py /tmp/tc.y4m /tmp/tc_nopaper.y4m /tmp/shots

The object is orange (#FFA500) but reads as brown in the picture. Checks:
  * Screen scene: picture colour, brown; the guide line explains the screen mode
  * Real scene, automatic: the ColorChecker in view is found live and used; orange
  * white paper: found next to the object; orange
  * camera only: the white anchor is shown, and "not white → light gray" makes the object darker
  * the hint line opens the explanation sheet; closed with ×, it stays closed and the ⓘ chip on the
    colour card reopens the explanation; Settings shows hints again and changes the text size
  * chart: freezing averages several frames; the chart is found on the frozen frame without
    tapping and saved as this lens's calibration; tapping the four corners (any order) also works;
    the paper estimate then goes through the calibration
  * validation: every method scored on the 24 patches, stored on the phone and exported as JSON
  * Correct mode in the Real scene: the whole picture is restored before the correction
  * torch: unavailable is explained; manual exposure without effect is detected and undone
  * a photo from the gallery asks whether it shows real objects or a screen
"""
import sys, os, json, subprocess
from playwright.sync_api import sync_playwright
from PIL import Image

Y4M, Y4M_NP, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
URL = os.environ.get('APP_URL', 'http://localhost:8765/')
os.makedirs(OUT, exist_ok=True)
META = json.load(open(Y4M + '.json'))
STATE = """() => { const {R} = window.__cvh; const n = R.lastNaming; const tc = R.tc.last;
  return n && {basic: n.basicKey, desc: n.desc.en, rgb: R.lastRgb, tc: tc && {src: tc.source, conf: tc.conf, notes: tc.notes, profiled: !!tc.profiled,
    anchorAt: !!(tc.anchor && tc.anchor.at)},
    paper: !!(R.tc.stats && R.tc.stats.paper && R.tc.stats.paper.found), anchor: R.tc.anchor && R.tc.anchor.neutral,
    status: document.getElementById('colorStatus').textContent + ' · ' + document.getElementById('colorMsgs').textContent,
    bar: document.getElementById('hint').hidden ? '' : document.getElementById('hintLine').textContent + ' ' + document.getElementById('hintActions').textContent,
    guide: document.getElementById('hintLine').textContent, guideShown: !document.getElementById('hint').hidden,
    gline: window.__cvh.guideContent().line, gmore: window.__cvh.guideContent().more, hintStep: document.getElementById('hint').classList.contains('step'),
    chart: R.tc.chart && +R.tc.chart.residual.toFixed(2), live: !!R.tc.liveChart, kind: R.kind, scene: window.__cvh.S.scene,
    toast: document.getElementById('toast').textContent}; }"""

def settle(page, n=4):
    page.evaluate("() => { window.__c0 = window.__cvh.R.resCount || 0; }")
    page.wait_for_function(f"() => (window.__cvh.R.resCount || 0) >= window.__c0 + {n}", timeout=30000)

def run(y4m, fn):
    with sync_playwright() as p:
        b = p.chromium.launch(args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
                                    f'--use-file-for-fake-video-capture={y4m}', '--use-angle=swiftshader',
                                    '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        ctx = b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, locale='zh-CN',
                            permissions=['camera'], accept_downloads=True)
        page = ctx.new_page(); errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
        page.goto(URL); page.wait_for_timeout(1500)
        if page.is_visible('#start'): page.click('#btnStart')
        page.wait_for_function("() => window.__cvh && window.__cvh.R.lastNaming && window.__cvh.R.lastRes", timeout=30000)
        page.evaluate(f"() => window.__cvh.setReticle({META['target'][0]}, {META['target'][1]})")
        settle(page)
        r = fn(page)
        b.close()
        return r, errs

def pixel(path, page, fx, fy):
    """Mean colour of a 9×9 block of a screenshot at a picture position (fractions)."""
    rc = page.evaluate("() => window.__cvh.R.rect")
    x, y = int(rc['x'] + fx * rc['w']), int(rc['y'] + fy * rc['h'])
    im = Image.open(path).convert('RGB')
    px = [im.getpixel((x + dx, y + dy)) for dx in range(-4, 5) for dy in range(-4, 5)]
    return [round(sum(p[k] for p in px) / len(px)) for k in range(3)]

def with_paper(page):
    out = {}
    # ---- Screen scene: the old picture-colour path
    page.click('#sceneScreen'); settle(page)
    out['picture'] = page.evaluate(STATE)
    page.screenshot(path=f'{OUT}/tc_screen.png')
    # ---- Real scene: four ways to measure (no "auto"); normal mode is the default
    page.click('#sceneReal')
    out['sources'] = page.evaluate("() => ({ srcs: [...document.querySelectorAll('#tcSrc button')].map(b => b.dataset.src + ':' + b.textContent), def: window.__cvh.S.tc.src })")
    # ---- chart: the chart in the live picture is found and used
    page.evaluate("() => window.__cvh.setTCSource('chart')")
    page.wait_for_function("() => window.__cvh.R.tc.liveChart", timeout=15000); settle(page, 4)
    out['auto'] = page.evaluate(STATE)
    page.screenshot(path=f'{OUT}/tc_auto_chart.png')
    # ---- white paper
    page.evaluate("() => window.__cvh.setTCSource('paper')"); settle(page, 6)
    out['paper'] = page.evaluate(STATE)
    page.screenshot(path=f'{OUT}/tc_paper.png')
    # ---- camera only: the white anchor, and the user saying it is light gray
    page.evaluate("() => window.__cvh.setTCSource('camera')"); settle(page, 6)
    out['camera'] = page.evaluate(STATE)
    page.screenshot(path=f'{OUT}/tc_camera.png')
    page.click('#hint [data-act=notWhite]'); page.wait_for_timeout(150)
    out['anchorMenu'] = page.evaluate("() => document.getElementById('hint').textContent")
    page.click('#hint [data-act=rhoLight]'); settle(page, 4)
    out['gray'] = page.evaluate(STATE)
    page.click('#hint [data-act=rhoWhite]'); settle(page, 3)
    # ---- tapping the hint opens the explanation sheet
    page.click('#hintText'); page.wait_for_timeout(300)
    out['guideMore'] = page.evaluate("() => ({ shown: !document.getElementById('infoSheet').hidden, text: document.getElementById('infoSheet').textContent })")
    page.screenshot(path=f'{OUT}/tc_guide.png')
    page.click('#btnInfoClose'); page.wait_for_timeout(100)
    # ---- closing the hint: it stays closed (also after switching scenes), the card's chip reopens the explanation
    page.click('#hintClose'); page.wait_for_timeout(200)
    page.click('#sceneScreen'); page.wait_for_timeout(300); page.click('#sceneReal'); settle(page, 3)
    out['hintClosed'] = page.evaluate("() => ({ hidden: document.getElementById('hint').hidden, saved: JSON.parse(localStorage.getItem('cvh.settings.v1')).hintsOff })")
    page.screenshot(path=f'{OUT}/tc_hint_closed.png')
    page.click('#colorStatus'); page.wait_for_timeout(300)
    out['reopen'] = page.evaluate("() => !document.getElementById('infoSheet').hidden")
    page.click('#btnInfoClose')
    # ---- Settings: text size, and showing the hints again
    page.click('#btnSettings'); page.click('#textSizeSeg button[data-size=l]'); page.click('#btnHintsReset'); page.click('#btnSettingsClose')
    settle(page, 3)
    out['display'] = page.evaluate("() => ({ fs: getComputedStyle(document.documentElement).getPropertyValue('--fs').trim(), name: parseFloat(getComputedStyle(document.getElementById('colorName')).fontSize), hint: !document.getElementById('hint').hidden })")
    page.click('#btnSettings'); page.click('#textSizeSeg button[data-size=m]'); page.click('#btnSettingsClose')
    # ---- chart on a frozen frame: averaged freeze, found without tapping, saved as lens calibration
    page.evaluate("() => window.__cvh.setTCSource('chart')")
    page.evaluate("() => window.__cvh.startChartPick('measure')")
    page.wait_for_function("() => window.__cvh.R.tc.chart && !window.__cvh.R.tc.pick", timeout=20000)
    page.evaluate(f"() => window.__cvh.setReticle({META['target'][0]}, {META['target'][1]})")
    settle(page, 1)
    out['chart'] = page.evaluate(STATE)
    out['freeze'] = page.evaluate("() => window.__cvh.R.tc.freezeInfo")
    out['chartAuto'] = page.evaluate("() => !!window.__cvh.R.tc.chart.auto")
    out['profile'] = page.evaluate("() => Object.values(window.__cvh.S.tc.cams).map(c => c.profile && {residual: c.profile.residual})[0] || null")
    page.screenshot(path=f'{OUT}/tc_chart.png')
    page.evaluate("() => window.__cvh.resumeLive()"); settle(page)
    # the same chart by tapping its four corner patches, in a scrambled order
    page.evaluate("() => window.__cvh.startChartPick('measure', { auto: false })")
    page.wait_for_function("() => window.__cvh.R.kind === 'frozen' && window.__cvh.R.tc.pick", timeout=15000)
    c = META['corners']
    for x, y in [c[2], c[0], c[3], c[1]]:
        page.evaluate(f"() => window.__cvh.chartTap({x}, {y})")
    page.wait_for_timeout(200)
    out['chartTapped'] = page.evaluate("() => ({ residual: window.__cvh.R.tc.chart && window.__cvh.R.tc.chart.residual, auto: window.__cvh.R.tc.chart && window.__cvh.R.tc.chart.auto })")
    page.evaluate("() => window.__cvh.resumeLive()"); settle(page)
    page.evaluate("() => window.__cvh.setTCSource('paper')"); settle(page, 6)
    out['paperProfiled'] = page.evaluate(STATE)
    # the light panel says the lens is calibrated and offers to clear it (kept for later)
    page.click('#btnWBTool'); page.wait_for_timeout(300)
    out['panel'] = page.evaluate("() => ({ desc: document.getElementById('tcDesc').textContent, reset: !document.getElementById('btnTCReset').hidden })")
    page.screenshot(path=f'{OUT}/tc_panel.png')
    page.click('#btnWBTool'); page.wait_for_timeout(200)
    # ---- validation: 24 patches, every method, stored and exported
    page.evaluate("() => window.__cvh.startValidation()")
    page.wait_for_function("() => !document.getElementById('valSheet').hidden", timeout=20000)
    page.wait_for_timeout(200)
    page.screenshot(path=f'{OUT}/tc_validation.png')
    out['val'] = page.evaluate("() => ({ rows: document.querySelectorAll('#valBody table:first-of-type tbody tr').length, runs: window.__cvh.loadRuns().length, summary: window.__cvh.loadRuns()[0].summary })")
    with page.expect_download() as dl:
        page.click('#btnValExport')
    path = dl.value.path()
    exp = json.load(open(path))
    out['export'] = {'runs': len(exp['runs']), 'meas': len(exp['runs'][0]['meas']), 'name': dl.value.suggested_filename}
    page.click('#btnValClose')
    page.evaluate("() => window.__cvh.resumeLive()"); settle(page)
    # ---- Correct mode in the Real scene: the picture is restored before the correction
    page.evaluate("() => { const {S} = window.__cvh; S.cvd.method = 'compensate'; S.cvd.strength = 0; window.__cvh.setTCSource('camera'); window.__cvh.setMode('correct'); }")
    page.wait_for_function("() => !!window.__cvh.R.tc.gpu", timeout=15000); page.wait_for_timeout(600)
    page.screenshot(path=f'{OUT}/tc_correct_real.png')
    out['corReal'] = {'px': pixel(f'{OUT}/tc_correct_real.png', page, *META['target']), 'guide': page.evaluate("() => document.getElementById('hintLine').textContent")}
    page.click('#sceneScreen'); page.wait_for_timeout(600)
    page.screenshot(path=f'{OUT}/tc_correct_screen.png')
    out['corScreen'] = {'px': pixel(f'{OUT}/tc_correct_screen.png', page, *META['target']), 'gpu': page.evaluate("() => window.__cvh.R.tc.gpu")}
    page.click('#sceneReal'); page.evaluate("() => window.__cvh.setMode('identify')"); settle(page)
    # ---- torch on a camera without a torch
    page.evaluate("() => window.__cvh.setTCSource('torch')"); settle(page)
    out['torch'] = page.evaluate(STATE)
    # a camera that lists torch + manual exposure but whose picture never changes (the fake camera)
    page.evaluate("""() => { const tr = window.__cvh.camera.track, base = tr.getCapabilities();
      tr.getCapabilities = () => ({ ...base, torch: true, exposureMode: ['continuous', 'manual'], exposureTime: { min: 1, max: 3330, step: 1 },
        iso: { min: 50, max: 3200, step: 1 }, whiteBalanceMode: ['continuous', 'manual'], colorTemperature: { min: 2850, max: 7000, step: 50 } });
      window.__applied = []; tr.applyConstraints = async (c) => { window.__applied.push(JSON.stringify(c)); }; }""")
    page.evaluate("() => window.__cvh.measureTorch()")
    page.wait_for_function("() => !window.__cvh.R.tc.busy && Object.values(window.__cvh.S.tc.cams).some(c => c.manual)", timeout=60000)
    out['torchVerify'] = page.evaluate("""() => ({ toast: document.getElementById('toast').textContent,
      manual: Object.values(window.__cvh.S.tc.cams).map(c => c.manual)[0], applied: window.__applied.slice(0, 6),
      last: window.__applied.slice(-3), bar: document.getElementById('hint').textContent,
      recheckShown: !document.getElementById('btnTorchRecheck').hidden })""")
    out['recheck'] = page.evaluate("""() => { document.getElementById('btnTorchRecheck').click();
      return { cleared: Object.values(window.__cvh.S.tc.cams).every(c => !c.manual), hidden: document.getElementById('btnTorchRecheck').hidden }; }""")
    # clearing the lens calibration
    page.click('#btnWBTool'); page.wait_for_timeout(200)
    page.click('#tcMore summary'); page.wait_for_timeout(150)   # less-used options are folded away
    page.click('#btnTCReset'); page.wait_for_timeout(200)
    out['afterReset'] = page.evaluate("() => ({ cams: Object.keys(window.__cvh.S.tc.cams).length, reset: !document.getElementById('btnTCReset').hidden })")
    page.click('#btnWBTool'); page.wait_for_timeout(200)
    return out

def no_paper(page):
    out = {}
    page.evaluate("() => { window.__cvh.setScene('real'); window.__cvh.setTCSource('camera'); }"); settle(page, 6)
    out['cameraNoPaper'] = page.evaluate(STATE)
    page.screenshot(path=f'{OUT}/tc_camera_nopaper.png')
    # a photo from the gallery: the app asks what it shows
    png = os.path.join(OUT, 'tc_photo.png')
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-i', Y4M_NP, '-frames:v', '1', png], check=True)
    page.set_input_files('#fileInput', png)
    page.wait_for_function("() => !document.getElementById('photoAsk').hidden", timeout=10000)
    page.screenshot(path=f'{OUT}/tc_photo_ask.png')
    page.click('#photoReal'); settle(page, 1)
    out['photoReal'] = page.evaluate(STATE)
    page.set_input_files('#fileInput', png)
    page.wait_for_function("() => !document.getElementById('photoAsk').hidden", timeout=10000)
    page.click('#photoScreen'); settle(page, 1)
    out['photoScreen'] = page.evaluate(STATE)
    # a phone that saved the old "auto" source opens in normal mode
    page.evaluate("() => { const s = JSON.parse(localStorage.getItem('cvh.settings.v1')); s.tc.src = 'auto'; s.scene = 'real'; localStorage.setItem('cvh.settings.v1', JSON.stringify(s)); }")
    page.reload(); page.wait_for_timeout(1200)
    if page.is_visible('#start'): page.click('#btnStart')
    page.wait_for_function("() => window.__cvh && window.__cvh.R.lastNaming", timeout=30000)
    out['migrated'] = page.evaluate("() => window.__cvh.S.tc.src")
    return out

results = {}
r1, e1 = run(Y4M, with_paper)
r2, e2 = run(Y4M_NP, no_paper)
results.update(r1); results.update(r2)
print(json.dumps(results, ensure_ascii=False, indent=1))
errors = e1 + e2
R = results
lum = lambda c: 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
checks = {
    'screen: picture reads brown': R['picture']['basic'] == 'brown' and R['picture']['scene'] == 'screen',
    'screen: guide explains the screen mode': R['picture']['guideShown'] and '屏幕模式' in R['picture']['guide'],
    'four sources, normal mode first and default': R['sources']['srcs'] == ['camera:普通模式', 'paper:白纸', 'torch:手电', 'chart:色卡'] and R['sources']['def'] == 'camera',
    'chart in the live picture found and used': R['auto']['tc']['src'] == 'chart' and R['auto']['live'] and '色卡' in R['auto']['bar'],
    'chart (live): says orange': R['auto']['basic'] == 'orange',
    'paper: found and says orange': R['paper']['tc']['src'] == 'paper' and R['paper']['paper'] and R['paper']['basic'] == 'orange',
    'normal mode: anchor shown, says orange, chip says 普通': R['camera']['tc']['src'] == 'camera' and R['camera']['tc']['anchorAt'] and R['camera']['basic'] == 'orange' and R['camera']['status'].startswith('普通')
        and '虚线框' in R['camera']['guide'],
    'normal mode: "light gray" makes it darker': 'anchorUser' in R['gray']['tc']['notes'] and lum(R['gray']['rgb']) < 0.95 * lum(R['camera']['rgb'])
        and '浅灰' in R['anchorMenu'],
    'hint opens the explanation (principle and numbers)': R['guideMore']['shown'] and '原理' in R['guideMore']['text'] and '现在用到的数据' in R['guideMore']['text'],
    'closed hint stays closed; chip reopens the explanation': R['hintClosed']['hidden'] and R['hintClosed']['saved'].get('real.identify') and R['reopen'],
    'text size setting and hints shown again': R['display']['fs'] == '1.15' and R['display']['name'] > 26 and R['display']['hint'],
    'freeze averages several frames (said in the sheet, the hint stays short)': R['freeze'] and R['freeze']['frames'] >= 5 and '帧平均' in R['chart']['gmore'] and '帧平均' not in R['chart']['gline'],
    'chart found on the frozen frame without tapping': R['chartAuto'] and R['chart']['chart'] is not None and R['chart']['chart'] < 4 and R['chart']['kind'] == 'frozen',
    'chart says orange': R['chart']['tc']['src'] == 'chart' and R['chart']['basic'] == 'orange',
    'chart by tapping four corners in any order': R['chartTapped']['residual'] is not None and R['chartTapped']['residual'] < 4 and not R['chartTapped']['auto'],
    'chart saved as lens calibration; paper uses it': R['profile'] is not None and R['paperProfiled']['tc']['profiled'] and R['paperProfiled']['basic'] == 'orange',
    'panel shows the calibration': '已用色卡标定过这颗镜头' in R['panel']['desc'] and R['panel']['reset'],
    'validation: all methods scored and stored': R['val']['rows'] >= 4 and R['val']['runs'] == 1
        and R['val']['summary']['chart']['median'] < R['val']['summary']['picture']['median'],
    'validation: exported as JSON with the raw patches': R['export']['runs'] == 1 and R['export']['meas'] == 24 and R['export']['name'].endswith('.json'),
    'correct (real): picture restored before correction': lum(R['corReal']['px']) > 1.4 * lum(R['corScreen']['px'])
        and R['corReal']['px'][0] - R['corReal']['px'][2] > 1.3 * (R['corScreen']['px'][0] - R['corScreen']['px'][2]) and R['corScreen']['gpu'] is None
        and '真色矫正' in R['corReal']['guide'],
    'torch unavailable is explained': 'torchNo' in R['torch']['tc']['notes'],
    'manual exposure without effect is detected': R['torchVerify']['manual']['ok'] is False
        and R['torchVerify']['manual']['reason'] == 'noEffect' and '手动曝光不生效' in R['torchVerify']['toast'],
    'camera restored after the check': any('continuous' in a for a in R['torchVerify']['last'])
        and any('"torch":false' in a for a in R['torchVerify']['last']),
    'check-again button offered and works': R['torchVerify']['recheckShown'] and R['recheck']['cleared'] and R['recheck']['hidden'],
    'calibration can be cleared': R['afterReset']['cams'] == 0 and not R['afterReset']['reset'],
    'saved "auto" source opens in normal mode': R['migrated'] == 'camera',
    'normal mode without paper says orange': R['cameraNoPaper']['tc']['src'] == 'camera' and R['cameraNoPaper']['basic'] == 'orange',
    'photo: asked, real photo stays in true colour': R['photoReal']['kind'] == 'photo' and R['photoReal']['scene'] == 'real' and '照片' in R['photoReal']['gmore'],
    'photo: screenshot switches to the screen scene': R['photoScreen']['scene'] == 'screen' and R['photoScreen']['tc'] is None,
    'no page errors': not errors,
}
for k, v in checks.items(): print(('PASS ' if v else 'FAIL ') + k)
print('errors:', errors)
sys.exit(0 if all(checks.values()) else 1)
