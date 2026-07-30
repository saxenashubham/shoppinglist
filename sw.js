// Cartpath service worker — network-first (new deploys land on next open),
// cache fallback so the app shell opens offline. Firestore handles data offline itself.
const CACHE = "cartpath-v6";
const SHELL = ["./","./index.html","./styles.css","./app.js","./config.js","./manifest.webmanifest","./icon-192.png","./icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;                 // never cache POSTs (worker/parse, Firestore)
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;  // let Firebase/fonts/CDN go straight to network
  e.respondWith(
    fetch(req)
      .then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return res; })
      .catch(() => caches.match(req).then(r => r || caches.match("./index.html")))
  );
});
