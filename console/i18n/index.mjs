import { xtendI18n } from "../.framework/components/xtend-i18n.js";
import nativeEnglish from "../.framework/components/i18n/labels.en.js";
import { messages } from "./catalog.mjs";
export function labelKey(source) {
  let n = 2166136261;
  for (const c of source) {
    n ^= c.codePointAt(0);
    n = Math.imul(n, 16777619);
  }
  return "u" + (n >>> 0).toString(16);
}
const labels = (english) =>
  Object.fromEntries(
    Object.entries(messages).map(([de, en]) => [
      "cuo." + labelKey(de),
      english ? en : de,
    ]),
  );
// The canonical preference is in RMT. XTend supplies label lookup and switching;
// its optional Classic State/router adapters must not introduce another model.
xtendI18n.connectState(null);
xtendI18n.configure({
  locale: "de",
  defaultLocale: "de",
  fallbackLocale: "en",
  available: ["de", "en"],
  apply: false,
  labels: {
    de: {
      "x-drawer.closeLabel": "Schließen",
      "x-toast.closeLabel": "Benachrichtigung schließen",
      "x-toggle.label": "Umschalten",
      ...labels(false),
    },
    en: { ...nativeEnglish.labels, ...labels(true) },
  },
});
export async function setLocale(locale) {
  if (xtendI18n.getLocale() !== locale)
    await xtendI18n.setLocale(locale, {
      source: "cuo.rmt",
      updateRouter: false,
    });
  if (typeof document !== "undefined") document.documentElement.lang = locale;
}
export function t(source, values = {}) {
  const text = xtendI18n.getLabelRecord(
    "cuo." + labelKey(source),
    source,
  ).value;
  return text.replace(/\{(\w+)\}/g, (match, key) =>
    Object.hasOwn(values, key) ? String(values[key]) : match,
  );
}
export function localizedLabels(source) {
  return new Proxy(source, {
    get(target, key) {
      const value = Reflect.get(target, key);
      return typeof value === "string" ? t(value) : value;
    },
  });
}
export function shellLabels() {
  return Object.fromEntries(
    Object.keys(messages).map((source) => [labelKey(source), t(source)]),
  );
}
export function localeTag() {
  return xtendI18n.getLocale() === "en" ? "en-GB" : "de-DE";
}
export { xtendI18n };
