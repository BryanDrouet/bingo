const CACHE_NAME = "bingo-network-first-v1";
const APP_PATH_PREFIXES = ["/", "/js/", "/css/"];

self.addEventListener("install", event => {
    self.skipWaiting();
});

self.addEventListener("activate", event => {
    event.waitUntil((async () => {
        const cacheNames = await caches.keys();
        await Promise.all(cacheNames
            .filter(name => name.startsWith("bingo-network-first-") && name !== CACHE_NAME)
            .map(name => caches.delete(name)));
        await self.clients.claim();
    })());
});

self.addEventListener("fetch", event => {
    const request = event.request;
    if (request.method !== "GET") return;

    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;

    const isAppAsset = APP_PATH_PREFIXES.some(prefix =>
        prefix === "/" ? url.pathname === "/" || url.pathname === "/index.html" : url.pathname.startsWith(prefix)
    );
    if (!isAppAsset) return;

    event.respondWith((async () => {
        const cache = await caches.open(CACHE_NAME);
        const cacheUrl = new URL(url);
        cacheUrl.search = "";
        const cacheRequest = new Request(cacheUrl.href, { method: "GET" });

        try {
            const response = await fetch(request, { cache: "no-store" });
            if (response.ok) await cache.put(cacheRequest, response.clone());
            return response;
        } catch (error) {
            const cachedResponse = await cache.match(cacheRequest);
            if (cachedResponse) return cachedResponse;
            throw error;
        }
    })());
});
