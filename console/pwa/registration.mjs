let policy;
export function serviceWorkerUrl() {
  const expected = new URL(
    "/xtend.service-worker.js",
    globalThis.location.origin,
  ).href;
  if (!globalThis.trustedTypes) return expected;
  policy ||= globalThis.trustedTypes.createPolicy("cuo-service-worker", {
    createScriptURL(value) {
      if (value !== expected)
        throw new TypeError("Unexpected CUO Service Worker URL");
      return value;
    },
  });
  return policy.createScriptURL(expected);
}
