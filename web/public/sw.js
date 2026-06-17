// lfg v2 service worker — makes the SPA installable + offline-capable for the
// app shell, without getting in the way of Vite's dev module graph or the
// streaming /api endpoints.
//
// Strategy: network-first for navigations and built assets (so a fresh deploy
// is picked up immediately when online, cache is only a fallback offline).
// Everything else — dev modules (/@vite, /src, /node_modules), websockets and
// the whole /api surface (SSE live streams!) — is passed straight through.
const CACHE = "lfg-v2-shell";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

function cacheable(url, request) {
  if (url.pathname.startsWith("/api")) return false; // never cache API / SSE
  if (request.mode === "navigate") return true;
  if (url.pathname.startsWith("/assets/")) return true; // hashed Vite build output
  return /\.(svg|png|ico|webmanifest|woff2?)$/.test(url.pathname);
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (!cacheable(url, request)) return; // pass through (dev modules, etc.)

  event.respondWith(
    (async () => {
      try {
        const response = await fetch(request);
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
        }
        return response;
      } catch {
        const cached = await caches.match(request);
        if (cached) return cached;
        if (request.mode === "navigate") {
          const shell = await caches.match("/");
          if (shell) return shell;
        }
        throw new Error("offline");
      }
    })(),
  );
});
