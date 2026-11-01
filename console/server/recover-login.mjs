import { Auth } from "./auth.mjs";
const auth = new Auth(process.env.CUO_AUTH_DATA || "/data");
try {
  const config = auth.setting("oidc") || {};
  auth.setSetting("oidc", { ...config, localLoginEnabled: true });
  auth.audit("host-owner", "login.local.recovered");
  console.log(
    "Lokale Anmeldung wieder aktiviert. Die OIDC-Konfiguration bleibt erhalten.",
  );
} finally {
  auth.db.close();
}
