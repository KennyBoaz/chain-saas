/* Phase 0 service worker.
 * Registers early so PWA install works today.
 * Real caching, offline shell, outbox, and push arrive in Phases 5–6.
 */
const VERSION = "v0";
const SHELL_CACHE = `chain-shell-${VERSION}`;
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll([OFFLINE_URL, "/manifest.webmanifest"])).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => !k.endsWith(VERSION)).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Network-first for everything; fall back to offline page for navigations.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  event.respondWith(
    fetch(req).catch(() =>
      caches.match(req).then((c) => c || (req.mode === "navigate" ? caches.match(OFFLINE_URL) : undefined))
    )
  );
});