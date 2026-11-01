import * as oidc from "../runtime/oidc-client.mjs";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const defaults = {
  enabled: false,
  localLoginEnabled: true,
  label: "Mit SSO anmelden",
  issuer: "",
  discoveryUrl: "",
  clientId: "",
  clientSecret: "",
  scope: "openid profile email",
  authMethod: "client_secret_post",
  defaultRole: "Viewer",
  autoProvision: true,
  revision: "",
};
export class OIDC {
  constructor(
    auth,
    origin,
    { allowHTTP = process.env.CUO_OIDC_ALLOW_HTTP === "1" } = {},
  ) {
    this.auth = auth;
    this.origin = origin;
    this.allowHTTP = allowHTTP;
    this.redirectUri = new URL("/auth/oidc/callback", origin).href;
  }
  config() {
    return { ...defaults, ...this.auth.setting("oidc") };
  }
  publicConfig(owner = false) {
    const { clientSecret, revision, ...config } = this.config();
    return owner
      ? {
          ...config,
          secretConfigured: !!clientSecret,
          redirectUri: this.redirectUri,
        }
      : {
          enabled: config.enabled,
          label: config.label,
          localLoginEnabled: config.localLoginEnabled,
        };
  }
  url(value) {
    const url = new URL(value);
    if (
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      (url.protocol !== "https:" &&
        !(this.allowHTTP && url.protocol === "http:"))
    )
      throw Error(
        "OIDC-Endpunkte benötigen HTTPS ohne Zugangsdaten oder URL-Parameter",
      );
    return url;
  }
  async discover(config) {
    const issuer = this.url(config.issuer);
    const authentication =
      config.authMethod === "none"
        ? oidc.None()
        : config.authMethod === "client_secret_basic"
          ? oidc.ClientSecretBasic(config.clientSecret)
          : oidc.ClientSecretPost(config.clientSecret);
    let client;
    if (config.discoveryUrl) {
      // A custom metadata endpoint need not contain /.well-known/. Treat it as
      // an exact document URL rather than asking the library to append a path.
      const response = await fetch(this.url(config.discoveryUrl), {
        headers: { Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok || !response.body)
        throw Error("Discovery-Dokument konnte nicht geladen werden");
      let size = 0,
        chunks = [];
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 131072) throw Error("Discovery-Dokument zu groß");
        chunks.push(Buffer.from(chunk));
      }
      const metadata = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      client = new oidc.Configuration(
        metadata,
        config.clientId,
        undefined,
        authentication,
      );
      client.timeout = 10;
      oidc.enableNonRepudiationChecks(client);
      if (this.allowHTTP) oidc.allowInsecureRequests(client);
    } else {
      client = await oidc.discovery(
        issuer,
        config.clientId,
        undefined,
        authentication,
        {
          timeout: 10,
          execute: [
            oidc.enableNonRepudiationChecks,
            ...(this.allowHTTP ? [oidc.allowInsecureRequests] : []),
          ],
        },
      );
    }
    const meta = client.serverMetadata();
    if (meta.issuer !== config.issuer)
      throw Error(
        "Der entdeckte Issuer stimmt nicht mit dem konfigurierten Issuer überein",
      );
    for (const key of ["authorization_endpoint", "token_endpoint", "jwks_uri"])
      this.url(meta[key]);
    if (meta.userinfo_endpoint) this.url(meta.userinfo_endpoint);
    return client;
  }
  async save(data) {
    if (
      data.localLoginEnabled !== undefined &&
      typeof data.localLoginEnabled !== "boolean"
    )
      throw Error("Die lokale Anmeldeoption muss ein boolescher Wert sein");
    const current = this.config();
    const config = {
      ...defaults,
      enabled: data.enabled === true,
      localLoginEnabled:
        data.localLoginEnabled === undefined
          ? current.localLoginEnabled
          : data.localLoginEnabled !== false,
      label: String(data.label || defaults.label)
        .trim()
        .slice(0, 80),
      issuer: String(data.issuer || "").trim(),
      discoveryUrl: String(data.discoveryUrl || "").trim(),
      clientId: String(data.clientId || "").trim(),
      clientSecret: data.clearSecret
        ? ""
        : String(data.clientSecret || current.clientSecret),
      scope: String(data.scope || defaults.scope).trim(),
      authMethod: data.authMethod,
      defaultRole: data.defaultRole,
      autoProvision: data.autoProvision === true,
      revision: randomBytes(16).toString("hex"),
    };
    if (
      !["client_secret_post", "client_secret_basic", "none"].includes(
        config.authMethod,
      ) ||
      !["Viewer", "Operator", "Administrator"].includes(config.defaultRole)
    )
      throw Error("Ungültige OIDC-Konfiguration");
    if (!config.scope.split(/\s+/).includes("openid"))
      throw Error("Der Scope openid ist erforderlich");
    if (
      config.scope.length > 500 ||
      config.clientId.length > 500 ||
      config.clientSecret.length > 4096
    )
      throw Error("OIDC-Konfiguration zu lang");
    if (!config.localLoginEnabled && !config.enabled)
      throw Error(
        "OIDC muss aktiviert sein, bevor die lokale Anmeldung deaktiviert wird",
      );
    if (config.enabled) {
      if (
        !config.clientId ||
        (config.authMethod !== "none" && !config.clientSecret)
      )
        throw Error("Client-ID und Client-Secret sind erforderlich");
      await this.discover(config);
    }
    this.auth.setSetting("oidc", config);
    this.auth.db.exec("DELETE FROM oidc_flows");
    return this.publicConfig(true);
  }
  cookie(value, maxAge = 300) {
    return `cuo_oidc=${value}; Path=/auth/oidc; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${this.origin.startsWith("https:") ? "; Secure" : ""}`;
  }
  async start(res) {
    const config = this.config();
    if (!config.enabled || !this.auth.count())
      throw Error("SSO ist nicht aktiviert");
    const client = await this.discover(config),
      state = oidc.randomState(),
      nonce = oidc.randomNonce(),
      verifier = oidc.randomPKCECodeVerifier(),
      binding = randomBytes(32).toString("hex");
    this.auth.db
      .prepare("DELETE FROM oidc_flows WHERE expires<?")
      .run(Date.now());
    this.auth.db
      .prepare("INSERT INTO oidc_flows VALUES(?,?,?,?,?,?)")
      .run(
        hash(state),
        hash(binding),
        verifier,
        nonce,
        Date.now() + 300000,
        config.revision,
      );
    const url = oidc.buildAuthorizationUrl(client, {
      redirect_uri: this.redirectUri,
      response_type: "code",
      scope: config.scope,
      state,
      nonce,
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: "S256",
    });
    res.setHeader("Set-Cookie", this.cookie(binding));
    return url.href;
  }
  async callback(url, req) {
    const config = this.config(),
      state = url.searchParams.get("state") || "";
    const flow = this.auth.db
      .prepare("DELETE FROM oidc_flows WHERE state=? RETURNING *")
      .get(hash(state));
    const binding =
      (req.headers.cookie || "")
        .split(";")
        .map((s) => s.trim())
        .find((s) => s.startsWith("cuo_oidc="))
        ?.slice(9) || "";
    const actual = hash(binding);
    if (
      !config.enabled ||
      !flow ||
      flow.expires < Date.now() ||
      flow.revision !== config.revision ||
      !binding ||
      !timingSafeEqual(Buffer.from(flow.binding), Buffer.from(actual))
    )
      throw Error(
        "SSO-Anmeldung abgelaufen oder ungültig. Bitte erneut anmelden.",
      );
    const client = await this.discover(config);
    const tokens = await oidc.authorizationCodeGrant(client, url, {
      pkceCodeVerifier: flow.verifier,
      expectedState: state,
      expectedNonce: flow.nonce,
      idTokenExpected: true,
    });
    const claims = tokens.claims();
    if (!claims) throw Error("OIDC-ID-Token fehlt");
    if (client.serverMetadata().userinfo_endpoint) {
      const info = await oidc.fetchUserInfo(
        client,
        tokens.access_token,
        claims.sub,
      );
      if (typeof info.name === "string") claims.name = info.name;
      if (typeof info.preferred_username === "string")
        claims.preferred_username = info.preferred_username;
    }
    // Subject is bound to the issuer. Never link accounts by email or username.
    return this.auth.federated(config.issuer, claims, config);
  }
}
