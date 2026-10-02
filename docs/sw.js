// Offline cache for the app shell. Bump VERSION when files change.
const VERSION = 'cvh-v1.5.1';
const FILES = [
  './', 'index.html', 'manifest.webmanifest', 'css/style.css',
  'js/main.js', 'js/i18n.js', 'js/color.js', 'js/naming.js', 'js/cvd.js', 'js/machado.js',
  'js/segment.js', 'js/gl.js', 'js/camera.js', 'js/selftest.js', 'js/wb.js', 'js/analysis-worker.js', 'js/reticle.js',
  'js/truecolor.js', 'js/measure.js', 'js/chartdetect.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network first, revalidating the browser's HTTP cache (GitHub Pages lets it keep files for
// 10 minutes, which used to serve a stale version right after an update), falling back to the
// offline cache.
function fresh(req) {
  if (req.mode === 'navigate') {
    return fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }).then((r) => (r.redirected ? fetch(req) : r));
  }
  return fetch(new Request(req, { cache: 'no-cache' }));
}
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fresh(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })
        .then((r) => r || (e.request.mode === 'navigate' ? caches.match('index.html') : Response.error())))
  );
});
