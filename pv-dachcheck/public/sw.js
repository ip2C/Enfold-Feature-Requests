// Service Worker: macht die Web-App installierbar („Zum Startbildschirm hinzufügen“)
// und lädt die Oberfläche auch bei schlechtem Netz. API-Aufrufe werden nie zwischengespeichert.
// Strategie „network first“: immer die neueste Version laden, nur offline auf den Cache zurückfallen.

const CACHE = 'pv-dachcheck-v1';
const SHELL = ['./', 'index.html', 'app.js', 'styles.css', 'icon.svg', 'manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request)),
  );
});
