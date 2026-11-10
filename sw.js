const CACHE_PREFIX = "neon-void-";
const CACHE_NAME = `${CACHE_PREFIX}v19`;
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icons/neon-void.svg",
  "./icons/neon-void-192.png",
  "./icons/neon-void-512.png",
  "./css/style.css?v=27",
  "./js/config.js",
  "./js/app.js?v=34",
  "./SITES/site.css",
  "./SITES/request-admin.html",
  "./SITES/request-admin.js",
  "./SITES/master.html",
  "./SITES/master.js",
  "./data/missions.json",
  "./data/skins.json",
  "./data/store.json",
  "./data/events.json",
  "./data/badges.json",
  "./data/promo-codes.json",
  "./data/battle-pass.json"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME)
    .then((cache) => cache.addAll(APP_SHELL.map((asset) =>
      new Request(new URL(asset, self.registration.scope)))))
    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys
      .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
      .map((key) => caches.delete(key))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(fetch(request).then((response) => {
      if (!response.ok) return response;
      return caches.open(CACHE_NAME)
        .then((cache) => cache.put(request, response.clone()))
        .then(() => response, () => response);
    }, async () => (await caches.match(request)) ||
      (await caches.match(new URL("./index.html", self.registration.scope)))));
    return;
  }

  if (url.pathname.endsWith(".json")) {
    event.respondWith(fetch(request).then((response) => {
      if (!response.ok) return response;
      return caches.open(CACHE_NAME)
        .then((cache) => cache.put(request, response.clone()))
        .then(() => response, () => response);
    }, async () => (await caches.match(request))));
    return;
  }

  event.respondWith(caches.match(request)
    .then((cached) => cached || fetch(request)));
});
