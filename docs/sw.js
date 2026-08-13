// Azyvion AI — Service Worker
//
// SUBE ESTE NÚMERO EN CADA ACTUALIZACIÓN QUE PUBLIQUES.
// Cambiar VERSION es lo que dispara todo el mecanismo de actualización:
// crea una caché nueva, borra las cachés viejas, y avisa a las pestañas /
// PWA abiertas para que se recarguen solas (como un Ctrl+Shift+R remoto).
const VERSION = "3.2";
const CACHE_NAME = `azyvion-ai-cache-v${VERSION}`;

// Solo se usan como respaldo offline — nunca como fuente principal.
// La estrategia real es "network-first" (ver fetch más abajo).
const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./config.js",
  "./manifest.json",
  "./logo.png",
  "./favicon.ico",
];

self.addEventListener("install", (event) => {
  // No esperar a que se cierren las pestañas viejas: tomar el control ya.
  self.skipWaiting();
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .catch(() => {
        /* precache best-effort — el fetch network-first cubre el resto */
      })
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Borra TODAS las cachés de versiones anteriores. Esto es lo que
      // evita que alguien quede "atascado" viendo una versión vieja.
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      );
      await self.clients.claim();

      // Avisa a todas las pestañas / instancias de la PWA abiertas que
      // hay una versión nueva activa, para que se recarguen solas.
      const clientsList = await self.clients.matchAll({ type: "window" });
      clientsList.forEach((client) => {
        client.postMessage({ type: "SW_ACTIVATED", version: VERSION });
      });
    })()
  );
});

// Permite que app.js pida explícitamente saltarse la espera (por si en el
// futuro se agrega alguna lógica que retenga el service worker en "waiting").
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING" || event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

// Network-first para todo lo mismo-origen: siempre intenta traer la
// versión más nueva de la red primero. La caché es solo un respaldo para
// cuando no hay conexión — nunca la fuente preferida. Así una actualización
// publicada se ve de inmediato, sin depender de que expire ningún caché.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // no tocar el backend (API_BASE_URL)
  if (url.pathname.startsWith("/api/")) return; // no cachear el backend local

  event.respondWith(
    fetch(req, { cache: "no-store" })
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(async () => {
        const cached = await caches.match(req);
        return cached || caches.match("./index.html");
      })
  );
});
