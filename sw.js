// Service worker: la app funciona sin conexión una vez abierta.
const VER = "pe-v5";
const SHELL = ["./", "index.html", "data.js", "programas.js", "manifest.webmanifest", "icon-192.png", "lib/pdf.min.js", "lib/pdf.worker.min.js"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VER).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VER).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  // datos y programas: primero red, si no hay conexión lo último guardado
  if (/data\.json$|\/programas\//.test(url.pathname)) {
    e.respondWith(fetch(req).then(r => { const cp = r.clone(); caches.open(VER).then(c => c.put(req, cp)); return r; }).catch(() => caches.match(req)));
    return;
  }
  // la app: lo guardado al instante y se refresca en segundo plano
  e.respondWith(caches.match(req).then(hit => {
    const net = fetch(req).then(r => { if (r.ok) { const cp = r.clone(); caches.open(VER).then(c => c.put(req, cp)); } return r; }).catch(() => hit);
    return hit || net;
  }));
});
