import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Auth } from "../server/auth.mjs";
test("scrypt enrollment, HttpOnly session, revocation and password validation", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuo-auth-"));
  const auth = new Auth(dir);
  try {
    await assert.rejects(
      auth.create({ name: "admin", password: "short" }, true),
    );
    const user = await auth.create(
      { name: "admin", password: "test-long-password-42" },
      true,
    );
    const saved = auth.db
      .prepare("SELECT password FROM users WHERE id=?")
      .get(user.id);
    assert.notEqual(saved.password, "test-long-password-42");
    assert.equal(await auth.verify("wrong", saved.password), false);
    assert.equal(
      await auth.verify("test-long-password-42", saved.password),
      true,
    );
    let cookie = "";
    auth.issue(
      {
        setHeader(k, v) {
          cookie = v;
        },
      },
      user,
      true,
    );
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Secure/);
    const req = { headers: { cookie: cookie.split(";")[0] } };
    assert.equal(auth.session(req).role, "Owner");
    auth.revoke(user.id);
    assert.equal(auth.session(req), null);
  } finally {
    auth.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("users cannot self-assign Owner and identity audit is durable", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuo-auth-"));
  const auth = new Auth(dir);
  try {
    await assert.rejects(
      auth.create({
        name: "attacker",
        password: "test-password-atleast12",
        role: "Owner",
      }),
    );
    auth.audit("test", "login.failed");
    assert.equal(
      auth.db.prepare("SELECT COUNT(*) n FROM auth_audit").get().n,
      1,
    );
  } finally {
    auth.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("RMT service contract and registry are complete", () => {
  const manifest = JSON.parse(
    fs.readFileSync(
      new URL("../dist/xtend.maraca.services.json", import.meta.url),
    ),
  );
  assert.deepEqual(manifest.services.map((s) => s.id).sort(), [
    "cuo.core",
    "cuo.intent",
  ]);
  const registry = JSON.parse(
    fs.readFileSync(new URL("../components/manifest.json", import.meta.url)),
  );
  for (const tag of [
    "x-icon",
    "x-toast",
    "x-cuo-toasts",
    "x-container-table",
    "x-maintenance-planner",
    "x-policy-editor",
    "x-log-stream",
    "x-approval-dialog",
  ])
    assert.ok(registry[tag]);
});

test("schema v1 migration preserves existing owners and sessions", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuo-migration-"));
  let auth = new Auth(dir);
  try {
    const user = await auth.create(
      { name: "existing-owner", password: "existing-local-password" },
      true,
    );
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
    auth.db.exec(
      "DROP TABLE profiles;DROP TABLE settings;DROP TABLE oidc_identities;DROP TABLE oidc_flows;DROP TABLE notification_dismissals;PRAGMA user_version=1;",
    );
    auth.db.close();
    auth = new Auth(dir);
    assert.equal(auth.count(), 1);
    assert.equal(auth.session({ headers: { cookie } }).id, user.id);
    assert.equal(auth.session({ headers: { cookie } }).role, "Owner");
    assert.equal(auth.db.prepare("PRAGMA user_version").get().user_version, 2);
    assert.equal(
      auth.db.prepare("PRAGMA integrity_check").get().integrity_check,
      "ok",
    );
  } finally {
    auth.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
