/* Application policy for Maraca's native Service Worker import hook.
 * Maraca owns registration, install, activation, versioned caches and fallback.
 * The build supplies only the allowlisted public file inventory; no API cache,
 * offline writes, sync or push is enabled here.
 */
const CUO_PUBLIC_FILES = /* CUO_PUBLIC_FILES */ [];
XTEND_PRECACHE_URLS.splice(
  0,
  XTEND_PRECACHE_URLS.length,
  ...CUO_PUBLIC_FILES.map(
    (file) =>
      new Request(new URL(file, self.location.href), {
        cache: "reload",
        credentials: "omit",
      }),
  ),
);
const CUO_PUBLIC_PATHS = new Set(
  CUO_PUBLIC_FILES.map((file) => new URL(file, self.location.href).pathname),
);
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  const navigation =
    request.mode === "navigate" &&
    (url.pathname === "/" || url.pathname === "/index.html");
  if (
    request.method !== "GET" ||
    request.cache === "reload" ||
    url.origin !== self.location.origin ||
    request.headers.has("authorization") ||
    (!navigation && (url.search || !CUO_PUBLIC_PATHS.has(url.pathname)))
  ) {
    // Leave sensitive requests to the browser's network path, even when their
    // filename looks static or a user navigates to an auth/API URL offline.
    event.stopImmediatePropagation();
    return;
  }
  // Maraca's generic extension list intentionally omits JSON/text. Only these
  // exact public build files may read from the native precache; no runtime put.
  if (!navigation && /\.(?:json|txt)$/.test(url.pathname)) {
    event.respondWith(
      caches.match(request).then((cached) => cached || fetch(request)),
    );
    event.stopImmediatePropagation();
  }
});
