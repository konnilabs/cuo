import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Auth } from "../server/auth.mjs";
import { OIDC } from "../server/oidc.mjs";
import { provider } from "./oidc-provider.mjs";
test("OIDC discovery, PKCE, signed ID tokens, account isolation and replay protection", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuo-oidc-")),
    auth = new Auth(dir),
    p = await provider();
  try {
    const owner = await auth.create(
      { name: "owner@example.test", password: "local-owner-password" },
      true,
    );
    const oidc = new OIDC(auth, "http://127.0.0.1:8095", { allowHTTP: true });
    const input = {
      enabled: true,
      label: "Mit SSO anmelden",
      issuer: p.issuer,
      discoveryUrl: p.issuer + "/openid-configuration",
      clientId: "fixture-client",
      clientSecret: "fixture-secret",
      authMethod: "client_secret_post",
      scope: "openid profile email",
      defaultRole: "Viewer",
      autoProvision: true,
    };
    const publicConfig = await oidc.save(input);
    assert.equal(publicConfig.secretConfigured, true);
    assert.equal("clientSecret" in publicConfig, false);
    assert.equal(
      publicConfig.redirectUri,
      "http://127.0.0.1:8095/auth/oidc/callback",
    );
    async function begin() {
      let cookie;
      const location = await oidc.start({
        setHeader(k, v) {
          cookie = v.split(";")[0];
        },
      });
      const response = await fetch(location, { redirect: "manual" });
      return {
        url: new URL(response.headers.get("location")),
        req: { headers: { cookie } },
      };
    }
    const valid = await begin(),
      user = await oidc.callback(valid.url, valid.req);
    assert.notEqual(user.id, owner.id);
    assert.equal(user.role, "Viewer");
    assert.equal(auth.count(), 2);
    await assert.rejects(oidc.callback(valid.url, valid.req));
    const missing = await begin();
    await assert.rejects(oidc.callback(missing.url, { headers: {} }));
    const state = await begin();
    state.url.searchParams.set("state", "wrong");
    await assert.rejects(oidc.callback(state.url, state.req));
    for (const mode of [
      "nonce",
      "signature",
      "expired",
      "audience",
      "issuer",
      "userinfo-subject",
    ]) {
      p.setMode(mode);
      const flow = await begin();
      await assert.rejects(oidc.callback(flow.url, flow.req), undefined, mode);
    }
    p.setMode("valid");
    await oidc.save({
      ...input,
      clientSecret: "",
      authMethod: "client_secret_basic",
      discoveryUrl: "",
    });
    const again = await begin();
    assert.equal((await oidc.callback(again.url, again.req)).id, user.id);
    await oidc.save({ ...input, autoProvision: false });
    const existing = await begin();
    assert.equal((await oidc.callback(existing.url, existing.req)).id, user.id);
    auth.db.prepare("UPDATE users SET disabled=1 WHERE id=?").run(user.id);
    const disabled = await begin();
    await assert.rejects(oidc.callback(disabled.url, disabled.req));
    const secureOnly = new OIDC(auth, "http://127.0.0.1:8095", {
      allowHTTP: false,
    });
    await assert.rejects(secureOnly.save(input), /HTTPS/);
  } finally {
    await p.close();
    auth.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("profile and notification preferences are durable and cannot change privileges", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuo-profile-"));
  let auth = new Auth(dir);
  try {
    const user = await auth.create(
      { name: "local-user", password: "long-local-password" },
      true,
    );
    auth.saveProfile(user, {
      displayName: "Anzeigename",
      avatar: "cloud",
      theme: "system",
      updateNotifications: false,
      role: "Viewer",
    });
    auth.dismiss(user, ["update:container:sha256:target"]);
    let cookie;
    auth.issue(
      {
        setHeader(k, v) {
          cookie = v.split(";")[0];
        },
      },
      user,
      false,
    );
    auth.db.close();
    auth = new Auth(dir);
    const session = auth.session({ headers: { cookie } });
    assert.equal(session.name, "Anzeigename");
    assert.equal(session.role, "Owner");
    assert.equal(session.profile.theme, "system");
    assert.equal(session.profile.updateNotifications, false);
    assert.deepEqual(auth.dismissed(user), ["update:container:sha256:target"]);
    assert.throws(() =>
      auth.saveProfile(user, {
        displayName: "Test",
        avatar: "https://tracking.invalid/a",
        theme: "system",
      }),
    );
    assert.equal(
      auth.db.prepare("SELECT name FROM users WHERE id=?").get(user.id).name,
      "local-user",
    );
  } finally {
    auth.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
