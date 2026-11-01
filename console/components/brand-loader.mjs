import { validateBrandPack } from "./brand-contract.mjs";

export function createBrandLoader({
  fetchPack,
  registerPack,
  timeoutMs = 5000,
}) {
  let pending;
  return () =>
    (pending ||= (async () => {
      const response = await fetchPack("/assets/container-brands.json", {
        signal: AbortSignal.timeout(timeoutMs),
        credentials: "same-origin",
      });
      if (!response.ok) throw Error("Brand pack unavailable");
      const text = await response.text();
      if (text.length > 256000) throw Error("Brand pack too large");
      const pack = validateBrandPack(JSON.parse(text));
      registerPack({
        id: pack.id,
        label: "CUO product icons",
        icons: pack.icons,
        cdnAllowed: false,
      });
      return pack;
    })());
}
