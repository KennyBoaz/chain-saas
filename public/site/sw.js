const CACHE_NAME = 'chain-saas-v1';
const ASSETS_TO_CACHE = [
  '/chain-saas/site/dashboard.html',
  '/chain-saas/site/style.css',
  '/chain-saas/site/manifest.json'
];

// Install Event - Cache the shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  self.skipWaiting();
});

// Activate Event - Clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) return caches.delete(key);
        })
      );
    })
  );
  self.clients.claim();
});

// Fetch Event - Serve from cache if offline
self.addEventListener('fetch', (event) => {
  // Don't cache API calls (they need to go to the server)
  if (event.request.url.includes('/api/')) return;
  
  event.respondWith(
    fetch(event.request).catch(() => {
      return caches.match(event.request);
    })
  );
});