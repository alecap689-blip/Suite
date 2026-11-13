/* Suite — service worker: la shell funziona anche offline. Rete per prima (si vede l'ultima versione), ma con
   attesa massima di 3,5 s: se la rete è assente o lenta si apre subito la copia in cache (che intanto si aggiorna).
   Solo file della stessa origine: le chiamate a Google non passano da qui. */
const CACHE = 'suite-shell-v2';
const FILES = ['./', 'index.html', 'styles.css', 'layout.js', 'sync.js', 'drive-web.js', 'config.js', 'app.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];
const WAIT = 3500;
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    const cached = await c.match(r, { ignoreSearch: true });
    const net = fetch(r).then((res) => { if (res.ok) c.put(r, res.clone()); return res; });
    if (!cached) return net.catch(async () => (await c.match('index.html')) || Response.error());
    net.catch(() => { /* offline: resta la copia */ });
    return Promise.race([net, new Promise((ok) => setTimeout(() => ok(cached), WAIT))]).catch(() => cached);
  })());
});
