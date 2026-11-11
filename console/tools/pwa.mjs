import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { isPublicAsset } from "../server/public-assets.mjs";

function files(directory) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name, "en"))
    .flatMap((entry) => {
      const name = path.join(directory, entry.name);
      return entry.isDirectory() ? files(name) : [name];
    });
}

export function pwaBuildFingerprint(root) {
  const hash = crypto.createHash("sha256");
  // The native cache key includes cacheMode. Bind it to all application build
  // inputs because Maraca's default key alone does not cover copied CUO files.
  for (const source of [
    "src",
    "components",
    "shared",
    "i18n",
    "assets",
    "pwa",
    "tools",
    "vendor",
    "server/public-assets.mjs",
    "maraca.config.json",
    "xtend.lock.json",
    "package.json",
  ]) {
    const target = path.join(root, source);
    for (const file of fs.statSync(target).isDirectory()
      ? files(target)
      : [target]) {
      hash.update(path.relative(root, file));
      hash.update("\0");
      hash.update(fs.readFileSync(file));
      hash.update("\0");
    }
  }
  return hash.digest("hex");
}

export function preparePwaBuild(root) {
  const config = JSON.parse(
    fs.readFileSync(path.join(root, "maraca.config.json"), "utf8"),
  );
  const fingerprint = pwaBuildFingerprint(root);
  config.options.pwa.cacheMode = "cuo-public-shell-" + fingerprint.slice(0, 24);
  fs.mkdirSync(path.join(root, ".xtend-build"), { recursive: true });
  const configFile = ".xtend-build/maraca.pwa.config.json";
  fs.writeFileSync(
    path.join(root, configFile),
    JSON.stringify(config, null, 2) + "\n",
  );
  return { configFile, fingerprint };
}

export function finishPwaBuild(root, fingerprint) {
  const dist = path.join(root, "dist");
  // Maraca v1 intentionally copies icons rather than resizing them. Replace
  // the documented mobile/favicon output paths with the reviewed CUO artwork.
  fs.cpSync(path.join(root, "pwa/icons"), path.join(dist, "icons"), {
    recursive: true,
  });
  fs.copyFileSync(
    path.join(root, "assets/favicon.svg"),
    path.join(dist, "icons/logo.svg"),
  );
  fs.copyFileSync(
    path.join(root, "pwa/offline.css"),
    path.join(dist, "assets/offline.css"),
  );
  fs.copyFileSync(
    path.join(root, "pwa/registration.mjs"),
    path.join(dist, "assets/cuo-pwa-registration.mjs"),
  );
  const offline = path.join(dist, "xtend.offline.html");
  let html = fs
    .readFileSync(offline, "utf8")
    .replace('lang="en"', 'lang="de"')
    .replace(
      /<style>[\s\S]*?<\/style>/,
      '<link rel="stylesheet" href="./assets/offline.css">',
    )
    .replace(
      /<p>[\s\S]*?<\/p>/,
      '<p>CUO ist gerade offline. Für Anmeldung, aktuelle Containerdaten und Update-Läufe ist eine Verbindung zum CUO-Server erforderlich.</p><p lang="en">CUO is offline. Sign-in, current container data and update runs require a connection to the CUO server.</p><a href="./">Erneut verbinden · Reconnect</a>',
    );
  fs.writeFileSync(offline, html);
  const publicFiles = files(dist)
    .map((file) => "/" + path.relative(dist, file).split(path.sep).join("/"))
    .filter(
      (file) =>
        isPublicAsset(file) &&
        file !== "/xtend.service-worker.js" &&
        file !== "/assets/cuo-pwa-policy.js",
    );
  const template = fs.readFileSync(path.join(root, "pwa/policy.js"), "utf8");
  fs.writeFileSync(
    path.join(dist, "assets/cuo-pwa-policy.js"),
    template.replace("/* CUO_PUBLIC_FILES */ []", JSON.stringify(publicFiles)),
  );
  const manifest = JSON.parse(
    fs.readFileSync(path.join(dist, "xtend.webmanifest"), "utf8"),
  );
  const native = JSON.parse(
    fs.readFileSync(path.join(dist, "xtend.pwa.report.json"), "utf8"),
  );
  if (
    !native.generated ||
    manifest.short_name !== "CUO" ||
    manifest.icons.length !== 2
  )
    throw Error("Native Maraca PWA artifacts missing or unexpected");
  fs.writeFileSync(
    path.join(root, "reports/cuo-pwa.json"),
    JSON.stringify(
      {
        generator: "XTend Maraca",
        fingerprint,
        cacheVersion: native.cacheVersion,
        nativeManifestReport: "dist/xtend.webmanifest.report.json",
        nativePwaReport: "dist/xtend.pwa.report.json",
        businessLogicImport: native.businessLogicImport,
        publicPrecache: publicFiles,
        productIcons: manifest.icons.map((icon) => icon.src),
        apiAndAuthCaching: false,
        offlineMutations: false,
      },
      null,
      2,
    ) + "\n",
  );
}
