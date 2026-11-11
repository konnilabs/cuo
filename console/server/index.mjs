import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { createNodeAppServiceHost } from "../.framework/xtend-maraca/node-app-service-host.mjs";
import services from "../dist/server/xtend.maraca.services.mjs";
import { Auth, ranks } from "./auth.mjs";
import { OIDC } from "./oidc.mjs";
import { isPublicAsset, assetContentType } from "./public-assets.mjs";
const root = fileURLToPath(new URL("../dist", import.meta.url)),
  auth = new Auth(process.env.CUO_AUTH_DATA || "/data"),
  origin = process.env.CUO_ORIGIN || "http://127.0.0.1:8095",
  secure = origin.startsWith("https:");
if (!secure && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin))
  throw Error("Non-loopback ingress requires HTTPS CUO_ORIGIN");
const oidc = new OIDC(auth, origin);
const host = createNodeAppServiceHost({
  services,
  historyLimit: 0,
  manifest: JSON.parse(
    fs.readFileSync(path.join(root, "xtend.maraca.services.json"), "utf8"),
  ),
});
function json(res, status, data) {
  if (status >= 400 && !data.code)
    data = {
      code:
        {
          400: "INVALID_REQUEST",
          401: "UNAUTHENTICATED",
          403: "FORBIDDEN",
          404: "NOT_FOUND",
          405: "METHOD_NOT_ALLOWED",
          409: "CONFLICT",
          429: "RATE_LIMITED",
        }[status] || "REQUEST_FAILED",
      ...data,
    };
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}
async function body(req) {
  let data = "";
  for await (const b of req) {
    data += b;
    if (Buffer.byteLength(data) > 65536) throw Error("Anfrage zu groß");
  }
  try {
    return JSON.parse(data || "{}");
  } catch {
    throw Error("Ungültiges JSON");
  }
}
const attempts = new Map();
function limited(key, max = 60) {
  const now = Date.now();
  let value = attempts.get(key);
  if (!value || value.until < now) {
    value = { count: 0, until: now + 60000 };
    attempts.set(key, value);
  }
  value.count++;
  if (attempts.size > 2000)
    for (const [k, v] of attempts) if (v.until < now) attempts.delete(k);
  return value.count > max;
}
function audit(user, operation) {
  auth.audit(user?.id || "anonymous", operation);
}
async function hasCapability(session, capability) {
  if (session.role === "Owner") return true;
  const response = await fetch(
    (process.env.CUO_CORE_URL || "http://core:8091") + "/api/v1/permissions/me",
    {
      headers: {
        Authorization: "Bearer " + process.env.CUO_CORE_TOKEN,
        "X-CUO-Actor": session.id,
        "X-CUO-Role": session.role,
        "X-CUO-Hosts": session.hosts.join(","),
      },
      signal: AbortSignal.timeout(5000),
    },
  );
  if (!response.ok) return false;
  const data = await response.json();
  return (
    Array.isArray(data.capabilities) && data.capabilities.includes(capability)
  );
}
const authPending = { enrollment: false };
const server = http.createServer(async (req, res) => {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; worker-src 'self'; manifest-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self' https://github.com; require-trusted-types-for 'script'",
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  if (secure) res.setHeader("Strict-Transport-Security", "max-age=31536000");
  try {
    const url = new URL(req.url, origin),
      session = auth.session(req);
    const modifying = !["GET", "HEAD"].includes(req.method);
    if (url.pathname === "/health") {
      json(res, 200, { ok: true, version: "0.3.1" });
      return;
    }
    if (url.pathname === "/auth/oidc/start" && req.method === "GET") {
      if (limited(req.socket.remoteAddress + ":oidc", 12)) {
        json(res, 429, { message: "Zu viele Anmeldeversuche" });
        return;
      }
      try {
        res.writeHead(303, {
          Location: await oidc.start(res),
          "Cache-Control": "no-store",
        });
        res.end();
      } catch {
        json(res, 400, {
          message:
            "SSO konnte nicht gestartet werden. Bitte Konfiguration und Provider-Erreichbarkeit prüfen.",
        });
      }
      return;
    }
    if (url.pathname === "/auth/oidc/callback" && req.method === "GET") {
      try {
        const user = await oidc.callback(url, req);
        auth.issue(res, user, secure);
        const sessionCookie = res.getHeader("Set-Cookie");
        res.setHeader("Set-Cookie", [sessionCookie, oidc.cookie("", 0)]);
        audit(user, "oidc.login");
        res.writeHead(303, { Location: "/", "Cache-Control": "no-store" });
        res.end();
      } catch {
        audit(null, "oidc.login.failed");
        res.setHeader("Set-Cookie", oidc.cookie("", 0));
        res.writeHead(303, {
          Location: "/?login_error=oidc",
          "Cache-Control": "no-store",
        });
        res.end();
      }
      return;
    }
    if (url.pathname.startsWith("/hooks/github/")) {
      const id = url.pathname.slice("/hooks/github/".length);
      if (req.method !== "POST" || !/^[a-f0-9]{32}$/.test(id)) {
        json(res, 404, { message: "Webhook nicht gefunden" });
        return;
      }
      if (limited(req.socket.remoteAddress + ":webhook", 120)) {
        json(res, 429, { message: "Zu viele Webhooks" });
        return;
      }
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) {
          json(res, 413, { message: "Webhook zu groß" });
          return;
        }
        chunks.push(chunk);
      }
      const response = await fetch(
        (process.env.CUO_CORE_URL || "http://core:8091") +
          "/internal/github/webhooks/" +
          id,
        {
          method: "POST",
          headers: {
            Authorization: "Bearer " + process.env.CUO_CORE_TOKEN,
            "Content-Type": "application/json",
            "X-Hub-Signature-256": req.headers["x-hub-signature-256"] || "",
            "X-GitHub-Delivery": req.headers["x-github-delivery"] || "",
            "X-GitHub-Event": req.headers["x-github-event"] || "",
          },
          body: Buffer.concat(chunks),
          signal: AbortSignal.timeout(8000),
        },
      );
      json(res, response.status, await response.json());
      return;
    }
    if (
      [
        "/connect/github/manifest/callback",
        "/connect/github/install/callback",
      ].includes(url.pathname) &&
      req.method === "GET"
    ) {
      const match = /(?:^|;\s*)cuo_github_setup=([a-f0-9]{64})(?:;|$)/.exec(
        req.headers.cookie || "",
      );
      res.setHeader(
        "Set-Cookie",
        `cuo_github_setup=; Path=/connect/github; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`,
      );
      let success = false;
      if (match) {
        const endpoint = url.pathname.includes("/manifest/")
          ? "manifest-callback"
          : "install-callback";
        const response = await fetch(
          (process.env.CUO_CORE_URL || "http://core:8091") +
            "/internal/github/" +
            endpoint,
          {
            method: "POST",
            headers: {
              Authorization: "Bearer " + process.env.CUO_CORE_TOKEN,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              state: url.searchParams.get("state") || "",
              code: url.searchParams.get("code") || "",
              nonce: match[1],
              installationId: url.searchParams.get("installation_id") || "",
            }),
            signal: AbortSignal.timeout(28000),
          },
        );
        success = response.ok;
      }
      res.writeHead(303, {
        Location:
          "/?github_setup=" +
          (success ? "success" : "failed") +
          "#/integrations/github",
        "Cache-Control": "no-store",
      });
      res.end();
      return;
    }
    if (modifying) {
      if (req.headers.origin !== origin) {
        json(res, 403, {
          code: "ORIGIN_REJECTED",
          message: "Ungültiger Ursprung",
        });
        return;
      }
      if (limited(req.socket.remoteAddress + ":all")) {
        json(res, 429, { message: "Zu viele Anfragen" });
        return;
      }
      if (!["/auth/login", "/auth/enroll"].includes(url.pathname)) {
        const csrf = req.headers["x-csrf-token"] || "";
        if (
          !session ||
          csrf.length !== session.csrf.length ||
          !timingSafeEqual(Buffer.from(csrf), Buffer.from(session.csrf))
        ) {
          json(res, 403, {
            code: "CSRF_REJECTED",
            message: "Sitzung abgelaufen. Bitte erneut anmelden.",
          });
          return;
        }
      }
    }
    if (url.pathname === "/auth/session" && req.method === "GET") {
      json(res, 200, {
        enrollment: auth.count() === 0,
        user: session
          ? {
              id: session.id,
              name: session.name,
              role: session.role,
              hosts: session.hosts,
              profile: session.profile,
            }
          : null,
        csrf: session?.csrf || null,
        oidc: oidc.publicConfig(),
        dismissed: session ? auth.dismissed(session) : [],
      });
      return;
    }
    if (url.pathname === "/auth/enroll" && req.method === "POST") {
      if (auth.count() > 0 || authPending.enrollment) {
        json(res, 409, { message: "Administrator wurde bereits eingerichtet" });
        return;
      }
      authPending.enrollment = true;
      try {
        const user = await auth.create(await body(req), true);
        auth.issue(res, user, secure);
        audit(user, "enroll");
        json(res, 201, { user });
      } finally {
        authPending.enrollment = false;
      }
      return;
    }
    if (url.pathname === "/auth/login" && req.method === "POST") {
      if (!oidc.config().localLoginEnabled) {
        audit(null, "login.disabled");
        json(res, 403, {
          code: "LOCAL_LOGIN_DISABLED",
          message: "Die lokale Anmeldung ist deaktiviert. Bitte SSO verwenden.",
        });
        return;
      }
      if (limited(req.socket.remoteAddress + ":login", 6)) {
        json(res, 429, {
          message: "Zu viele Anmeldeversuche. Bitte eine Minute warten.",
        });
        return;
      }
      const data = await body(req);
      const user = auth.db
        .prepare("SELECT * FROM users WHERE name=? AND disabled=0")
        .get(typeof data.name === "string" ? data.name : "");
      const valid = await auth.verify(
        data.password,
        user?.password || "00000000000000000000000000000000:" + "00".repeat(64),
      );
      if (!user || !valid) {
        audit(null, "login.failed");
        json(res, 401, { message: "Benutzername oder Passwort ungültig" });
        return;
      }
      // Password verification is asynchronous; respect a mode change made by
      // an Owner while this login request was in flight.
      if (!oidc.config().localLoginEnabled) {
        json(res, 403, {
          code: "LOCAL_LOGIN_DISABLED",
          message: "Die lokale Anmeldung ist deaktiviert. Bitte SSO verwenden.",
        });
        return;
      }
      auth.issue(res, user, secure);
      audit(user, "login");
      json(res, 200, { ok: true });
      return;
    }
    if (url.pathname.startsWith("/auth/") || url.pathname.startsWith("/api/")) {
      if (!session) {
        json(res, 401, { code: "UNAUTHENTICATED", message: "Bitte anmelden" });
        return;
      }
      if (url.pathname === "/auth/profile" && req.method === "POST") {
        const profile = auth.saveProfile(session, await body(req));
        audit(session, "profile.update");
        json(res, 200, { profile });
        return;
      }
      if (
        url.pathname === "/auth/notifications/dismiss" &&
        req.method === "POST"
      ) {
        auth.dismiss(session, (await body(req)).ids);
        json(res, 200, { dismissed: auth.dismissed(session) });
        return;
      }
      if (
        url.pathname === "/auth/oidc/config" &&
        ["GET", "POST"].includes(req.method)
      ) {
        if (session.role !== "Owner") {
          json(res, 403, { message: "Owner erforderlich" });
          return;
        }
        if (req.method === "GET") json(res, 200, oidc.publicConfig(true));
        else {
          const config = await oidc.save(await body(req));
          audit(session, "oidc.configure");
          json(res, 200, config);
        }
        return;
      }
      if (url.pathname === "/auth/logout" && req.method === "POST") {
        auth.revoke(session.id);
        res.setHeader(
          "Set-Cookie",
          `cuo_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`,
        );
        audit(session, "logout");
        json(res, 200, { ok: true });
        return;
      }
      if (url.pathname === "/auth/users" && req.method === "GET") {
        if (!(await hasCapability(session, "users.manage"))) {
          json(res, 403, { message: "Administrator erforderlich" });
          return;
        }
        const users = auth.db
          .prepare(
            "SELECT id,name,role,hosts,disabled FROM users ORDER BY name",
          )
          .all()
          .map((u) => ({
            ...u,
            name: auth.profile(u).displayName,
            hosts: JSON.parse(u.hosts),
          }));
        json(res, 200, { items: users });
        return;
      }
      if (url.pathname === "/auth/users" && req.method === "POST") {
        if (!(await hasCapability(session, "users.manage"))) {
          json(res, 403, { message: "Administrator erforderlich" });
          return;
        }
        const data = await body(req);
        if (ranks[data.role] >= ranks[session.role]) {
          json(res, 403, {
            message: "Nur untergeordnete Rollen können angelegt werden",
          });
          return;
        }
        const user = await auth.create(data);
        audit(session, "user.create:" + user.id);
        json(res, 201, { user });
        return;
      }
      if (url.pathname === "/auth/users/revoke" && req.method === "POST") {
        if (!(await hasCapability(session, "users.manage"))) {
          json(res, 403, { message: "Administrator erforderlich" });
          return;
        }
        const data = await body(req);
        const user = auth.db
          .prepare("SELECT role FROM users WHERE id=?")
          .get(data.id);
        if (!user || ranks[user.role] >= ranks[session.role]) {
          json(res, 403, { message: "Nicht erlaubt" });
          return;
        }
        auth.revoke(data.id);
        audit(session, "session.revoke:" + data.id);
        json(res, 200, { ok: true });
        return;
      }
      const controller = new AbortController();
      res.on("close", () => controller.abort());
      if (url.pathname === "/api/v1/events" && req.method === "GET") {
        const r = await fetch(
          (process.env.CUO_CORE_URL || "http://core:8091") +
            url.pathname +
            url.search,
          {
            headers: {
              Authorization: "Bearer " + process.env.CUO_CORE_TOKEN,
              "X-CUO-Actor": session.id,
              "X-CUO-Role": session.role,
              "X-CUO-Hosts": session.hosts.join(","),
              "Last-Event-ID": req.headers["last-event-id"] || "",
            },
            signal: controller.signal,
          },
        );
        if (!r.ok) {
          json(res, r.status, { message: "Eventstream nicht verfügbar" });
          return;
        }
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
          "X-Accel-Buffering": "no",
        });
        const expiry = setTimeout(
          () => controller.abort(),
          Math.min(60000, Math.max(1, session.expires - Date.now())),
        );
        try {
          for await (const chunk of Readable.fromWeb(r.body)) {
            if (!auth.session(req)) break;
            res.write(chunk);
          }
        } finally {
          clearTimeout(expiry);
          res.end();
        }
        return;
      }
      if (url.pathname.startsWith("/api/v1/")) {
        const input = {
          method: req.method,
          path: url.pathname + url.search,
          key: req.headers["idempotency-key"],
          body: modifying ? await body(req) : undefined,
        };
        const result = await host.registry.invoke("cuo.core", input, {
          principal: session,
          signal: controller.signal,
          concurrencyKey: "bff:" + randomUUID(),
        });
        if (result.body?._correlation) {
          res.setHeader(
            "Set-Cookie",
            `cuo_github_setup=${result.body._correlation}; Path=/connect/github; HttpOnly; SameSite=Lax; Max-Age=900${secure ? "; Secure" : ""}`,
          );
          delete result.body._correlation;
        }
        json(res, result.status, result.body);
        return;
      }
      json(res, 404, { message: "Endpunkt nicht gefunden" });
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      json(res, 405, { message: "Methode nicht erlaubt" });
      return;
    }
    const requested = decodeURIComponent(
      url.pathname === "/" ? "/index.html" : url.pathname,
    );
    if (!isPublicAsset(requested)) {
      json(res, 404, { message: "Nicht gefunden" });
      return;
    }
    const filename = path.join(root, requested);
    if (!fs.existsSync(filename)) {
      json(res, 404, { message: "Nicht gefunden" });
      return;
    }
    const type = assetContentType(filename);
    const headers = { "Content-Type": type, "Cache-Control": "no-cache" };
    if (requested === "/xtend.service-worker.js") {
      headers["Service-Worker-Allowed"] = "/";
      // A worker has no DOM sinks. Its separate policy permits only same-origin
      // imports and fetches; the document keeps its strict Trusted Types policy.
      headers["Content-Security-Policy"] =
        "default-src 'none'; script-src 'self'; connect-src 'self'";
    }
    if (req.method === "HEAD") {
      res.writeHead(200, headers);
      res.end();
      return;
    }
    const asset = fs.createReadStream(filename);
    asset.once("open", () => {
      if (res.destroyed) {
        asset.destroy();
        return;
      }
      res.writeHead(200, headers);
      asset.pipe(res);
    });
    asset.on("error", () => {
      if (res.destroyed) return;
      if (!res.headersSent)
        json(res, 500, {
          code: "STATIC_ASSET_ERROR",
          message: "Datei konnte nicht geladen werden",
        });
      else res.destroy();
    });
    res.once("close", () => asset.destroy());
  } catch (error) {
    if (!res.headersSent)
      json(res, 400, {
        code: "REQUEST_FAILED",
        message: error.message?.slice(0, 300) || "Anfrage fehlgeschlagen",
      });
    else res.end();
  }
});
server.requestTimeout = 30000;
server.headersTimeout = 10000;
server.listen(
  Number(process.env.CUO_PORT || 8095),
  process.env.CUO_BIND || "0.0.0.0",
  () => console.log(JSON.stringify({ service: "cuo-console", origin })),
);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    server.close();
    host.dispose(signal);
  });
