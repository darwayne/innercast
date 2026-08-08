const CACHE_PREFIX = "innercast-";
const APP_CACHE = `${CACHE_PREFIX}app-v3`;
const RUNTIME_CACHE = `${CACHE_PREFIX}runtime-v1`;

const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./manifest.webmanifest",
  "./assets/innercast-icon.svg",
  "./app/app.js?v=3",
  "./app/controllers.js",
  "./app/file-types.js",
  "./app/repository.js",
  "./app/timestamp.js",
  "./app/whisper-transcriber.js?v=3",
  "./app/whisper-worker.js",
];

const CACHEABLE_RUNTIME_HOSTS = new Set([
  "cdn.jsdelivr.net",
]);

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(APP_CACHE);
    await cache.addAll(APP_SHELL);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name.startsWith(CACHE_PREFIX) && ![APP_CACHE, RUNTIME_CACHE].includes(name))
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

async function cacheSuccessfulResponse(cacheName, request, response) {
  if (!response || response.status !== 200) return response;
  const cache = await caches.open(cacheName);
  await cache.put(request, response.clone());
  return response;
}

async function navigationResponse(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(APP_CACHE);
      await cache.put("./index.html", response.clone());
    }
    return response;
  } catch {
    return (await caches.match("./index.html")) || Response.error();
  }
}

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  return cacheSuccessfulResponse(cacheName, request, response);
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || request.headers.has("range")) return;

  const url = new URL(request.url);
  if (request.mode === "navigate") {
    event.respondWith(navigationResponse(request));
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(request, APP_CACHE));
    return;
  }

  // Transformers.js and ONNX Runtime are pinned remote application assets.
  // Whisper model files use Transformers.js's own browser cache, avoiding a
  // second large model copy in this service worker cache.
  if (CACHEABLE_RUNTIME_HOSTS.has(url.hostname)) {
    event.respondWith(cacheFirst(request, RUNTIME_CACHE));
  }
});
