// Service worker "rete prima": prende sempre la versione aggiornata quando c'è
// connessione, e usa la copia salvata solo se la rete manca. Non tocca mai le
// chiamate a Supabase (altra origine) né version.json.
const CACHE = 'florial-shell-v1';

self.addEventListener('install', () => { self.skipWaiting(); });

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;            // Supabase e CDN: sempre rete
  if (url.pathname.endsWith('version.json')) return;     // versione: sempre fresca
  e.respondWith((async () => {
    try {
      const net = await fetch(req);
      const cache = await caches.open(CACHE);
      cache.put(req, net.clone());
      return net;
    } catch (err) {
      const cached = await caches.match(req);
      if (cached) return cached;
      throw err;
    }
  })());
});
