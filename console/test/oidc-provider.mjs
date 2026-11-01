import http from "node:http";
import {
  generateKeyPairSync,
  sign,
  createHash,
  randomBytes,
} from "node:crypto";
export async function provider({ hostname = "127.0.0.1" } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const jwk = {
    ...publicKey.export({ format: "jwk" }),
    kid: "fixture",
    alg: "RS256",
    use: "sig",
  };
  const flows = new Map();
  let issuer,
    mode = "valid";
  function json(res, value) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(value));
  }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, issuer);
    const prefix = new URL(issuer).pathname;
    if (
      [
        prefix + "/openid-configuration",
        prefix + "/.well-known/openid-configuration",
      ].includes(url.pathname)
    )
      return json(res, {
        issuer,
        authorization_endpoint: issuer + "/authorize",
        token_endpoint: issuer + "/token",
        jwks_uri: issuer + "/jwks",
        userinfo_endpoint: issuer + "/userinfo",
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported: [
          "client_secret_post",
          "client_secret_basic",
          "none",
        ],
      });
    if (url.pathname.endsWith("/jwks")) return json(res, { keys: [jwk] });
    if (url.pathname.endsWith("/userinfo")) {
      if (req.headers.authorization !== "Bearer fixture-access") {
        res.writeHead(401);
        return res.end();
      }
      return json(res, {
        sub:
          mode === "userinfo-subject" ? "different-subject" : "fixture-subject",
        name: "Federated Test User",
        preferred_username: "provider-user",
      });
    }
    if (url.pathname.endsWith("/authorize")) {
      const code = randomBytes(16).toString("hex");
      flows.set(code, Object.fromEntries(url.searchParams));
      const target = new URL(url.searchParams.get("redirect_uri"));
      target.searchParams.set("code", code);
      target.searchParams.set("state", url.searchParams.get("state"));
      res.writeHead(303, { Location: target.href });
      return res.end();
    }
    if (url.pathname.endsWith("/token")) {
      let raw = "";
      for await (const b of req) raw += b;
      const data = new URLSearchParams(raw),
        flow = flows.get(data.get("code"));
      flows.delete(data.get("code"));
      const challenge = createHash("sha256")
        .update(data.get("code_verifier") || "")
        .digest("base64url");
      const authenticated =
        (data.get("client_id") === "fixture-client" &&
          data.get("client_secret") === "fixture-secret") ||
        (req.headers.authorization?.startsWith("Basic ") &&
          Buffer.from(req.headers.authorization.slice(6), "base64")
            .toString()
            .split(":")
            .map(decodeURIComponent)
            .join(":") === "fixture-client:fixture-secret");
      if (
        !flow ||
        !authenticated ||
        data.get("redirect_uri") !== flow.redirect_uri ||
        challenge !== flow.code_challenge ||
        flow.code_challenge_method !== "S256"
      ) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "invalid_grant" }));
      }
      const now = Math.floor(Date.now() / 1000),
        payload = {
          iss: issuer,
          sub: "fixture-subject",
          aud: "fixture-client",
          iat: now,
          exp: now + 300,
          nonce: flow.nonce,
          name: "Federated Test User",
          email: "owner@example.test",
          preferred_username: "provider-user",
          role: "Owner",
        };
      if (mode === "nonce") payload.nonce = "wrong";
      if (mode === "audience") payload.aud = "different";
      if (mode === "expired") payload.exp = now - 1000;
      if (mode === "issuer") payload.iss = issuer + "/wrong";
      const encoded =
        Buffer.from(
          JSON.stringify({ alg: "RS256", kid: "fixture", typ: "JWT" }),
        ).toString("base64url") +
        "." +
        Buffer.from(JSON.stringify(payload)).toString("base64url");
      const signature = sign(
        "RSA-SHA256",
        Buffer.from(encoded),
        privateKey,
      ).toString("base64url");
      return json(res, {
        access_token: "fixture-access",
        token_type: "Bearer",
        expires_in: 300,
        id_token:
          encoded +
          "." +
          (mode === "signature" ? "A".repeat(signature.length) : signature),
      });
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, hostname, resolve));
  issuer = `http://${hostname}:${server.address().port}/index.php/apps/oidc`;
  return {
    issuer,
    server,
    setMode(value) {
      mode = value;
    },
    close() {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
