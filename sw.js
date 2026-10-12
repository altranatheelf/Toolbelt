/* Toolbelt service worker: caches the launcher and every module so the installed app works
   offline. The version is stamped by tools/stamp-sw.mjs on each build; a new version installs
   in the background and the launcher offers a reload. Nothing here talks to any server but
   this site's own files. */
const VERSION = '6d0d1748fef1';
const CACHE = 'toolbelt-' + VERSION;
const FILES = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-512-maskable.png', './icons/icon-180.png',
  './modules/carousel-sequencer.html', './modules/ripper.html', './modules/mishear.html'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== RUNTIME).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('message', (e) => { if (e.data === 'skip') self.skipWaiting(); });
const RUNTIME = 'toolbelt-runtime'; // the ONNX runtime files Mishear loads once from the CDN (pinned by version in the URL)
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.hostname === 'cdn.jsdelivr.net' && url.pathname.startsWith('/npm/onnxruntime-web@')) {
    e.respondWith(caches.open(RUNTIME).then((c) => c.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      if (res.ok) c.put(e.request, res.clone()); return res;
    }))));
    return;
  }
  if (url.origin !== location.origin) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request).then((res) => {
    const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res;
  })));
});
