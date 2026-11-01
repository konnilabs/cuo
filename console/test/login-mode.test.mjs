import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Auth } from "../server/auth.mjs";
import { OIDC } from "../server/oidc.mjs";
import { provider } from "./oidc-provider.mjs";

test(
  "OIDC-only mode requires verified enabled OIDC, survives restart, blocks direct passwords and supports host recovery",
  { timeout: 15000 },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuo-login-mode-"));
    const auth = new Auth(dir);
    const p = await provider();
    const probe = http.createServer();
    await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    const origin = `http://127.0.0.1:${port}`;
    const oidc = new OIDC(auth, origin, { allowHTTP: true });
    let server;
    try {
      const owner = await auth.create(
        { name: "fixture-owner", password: "fixture-owner-password" },
        true,
      );
      let existingCookie;
      auth.issue(
        {
          setHeader(key, value) {
            existingCookie = value.split(";")[0];
          },
        },
        owner,
        false,
      );
      assert.equal(oidc.publicConfig().localLoginEnabled, true);
      const config = {
        enabled: true,
        localLoginEnabled: false,
        label: "SSO",
        issuer: p.issuer,
        clientId: "fixture-client",
        clientSecret: "fixture-secret",
        authMethod: "client_secret_post",
        scope: "openid profile email",
        defaultRole: "Viewer",
        autoProvision: true,
      };
      await assert.rejects(
        oidc.save({ ...config, enabled: false }),
        /OIDC muss aktiviert/,
      );
      await assert.rejects(
        oidc.save({ ...config, issuer: p.issuer + "/invalid" }),
      );
      assert.equal(oidc.publicConfig().localLoginEnabled, true);
      await oidc.save(config);
      assert.deepEqual(oidc.publicConfig(), {
        enabled: true,
        label: "SSO",
        localLoginEnabled: false,
      });
      auth.db.close();
      const env = {
        ...process.env,
        CUO_AUTH_DATA: dir,
        CUO_ORIGIN: origin,
        CUO_PORT: String(port),
        CUO_BIND: "127.0.0.1",
        CUO_OIDC_ALLOW_HTTP: "1",
      };
      server = spawn(process.execPath, ["server/index.mjs"], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let errors = "";
      server.stderr.on("data", (data) => (errors += data));
      await Promise.race([
        once(server.stdout, "data"),
        once(server, "exit").then(() => {
          throw Error(errors || "Server did not start");
        }),
      ]);
      const call = (url, method = "GET", body, cookie) =>
        fetch(origin + url, {
          method,
          headers: {
            Origin: origin,
            "Content-Type": "application/json",
            ...(cookie ? { Cookie: cookie } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          redirect: "manual",
        });
      const session = await (await call("/auth/session")).json();
      assert.equal(session.oidc.localLoginEnabled, false);
      const blocked = await call("/auth/login", "POST", {
        name: "fixture-owner",
        password: "fixture-owner-password",
      });
      assert.equal(blocked.status, 403);
      assert.equal((await blocked.json()).code, "LOCAL_LOGIN_DISABLED");
      assert.equal(blocked.headers.has("set-cookie"), false);
      assert.equal(
        (
          await (
            await call("/auth/session", "GET", null, existingCookie)
          ).json()
        ).user.role,
        "Owner",
      );
      assert.equal((await call("/auth/oidc/start")).status, 303);
      execFileSync(process.execPath, ["server/recover-login.mjs"], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env,
        stdio: "pipe",
      });
      const recovered = await call("/auth/login", "POST", {
        name: "fixture-owner",
        password: "fixture-owner-password",
      });
      assert.equal(recovered.status, 200);
      assert.match(recovered.headers.get("set-cookie"), /HttpOnly/);
      assert.equal(
        (await (await call("/auth/session")).json()).oidc.enabled,
        true,
      );
      const verification = new Auth(dir);
      assert.equal(
        verification.db
          .prepare(
            "SELECT COUNT(*) n FROM auth_audit WHERE operation='login.local.recovered'",
          )
          .get().n,
        1,
      );
      verification.db.close();
    } finally {
      if (server) {
        server.kill("SIGTERM");
        await once(server, "exit");
      }
      if (auth.db.isOpen) auth.db.close();
      await p.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
