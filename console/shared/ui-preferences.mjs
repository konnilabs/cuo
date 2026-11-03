export const palettes = ["slate", "black", "green", "wine"];
export const preferenceDefaults = Object.freeze({
  palette: "slate",
  highContrast: false,
  language: "de",
  languageAutomatic: true,
});
/** @param {readonly string[]} [languages] */
export function preferredLanguage(languages = []) {
  for (const language of languages) {
    const base = String(language)
      .toLowerCase()
      .replaceAll("_", "-")
      .split("-")[0];
    if (base === "de" || base === "en") return base;
  }
  return "en";
}
