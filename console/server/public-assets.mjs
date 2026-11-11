// One public-file boundary for HTTP delivery and the PWA's explicit precache.
// Reports, server bundles, credentials and API/auth/export URLs stay private.
export function isPublicAsset(pathname) {
  return /^\/(?:index\.html|xtend\.maraca\.(?:mjs|css)|boot\.mjs|favicon\.svg|xtend\.webmanifest|xtend\.service-worker\.js|xtend\.offline\.html|icons\/(?:android-chrome-(?:192x192|512x512)\.png|apple-touch-icon\.png|favicon-(?:16x16|32x32)\.png|favicon\.ico|logo\.svg)|assets\/[a-zA-Z0-9_.-]+|chunks\/[a-zA-Z0-9_.-]+\.mjs|runtime\/[a-zA-Z0-9_.-]+\.(?:mjs|js))$/.test(
    pathname,
  );
}

export function assetContentType(filename) {
  const extension = filename.slice(filename.lastIndexOf("."));
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".mjs": "text/javascript; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".ttf": "font/ttf",
      ".css": "text/css; charset=utf-8",
      ".woff2": "font/woff2",
      ".svg": "image/svg+xml",
      ".json": "application/json; charset=utf-8",
      ".webmanifest": "application/manifest+json; charset=utf-8",
      ".png": "image/png",
      ".ico": "image/x-icon",
    }[extension] || "application/octet-stream"
  );
}
