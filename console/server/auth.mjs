import { DatabaseSync } from "node:sqlite";
import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
const scrypt = promisify(scryptCallback);
export const ranks = { Viewer: 0, Operator: 1, Administrator: 2, Owner: 3 };
const hash = (s) => createHash("sha256").update(s).digest("hex");
export class Auth {
  constructor(dir) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(dir, "identity.db"));
    if (this.db.prepare("PRAGMA user_version").get().user_version > 2)
      throw Error("Identity schema is newer than this CUO version");
    this.db.exec(
      `PRAGMA journal_mode=WAL; BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,password TEXT NOT NULL,role TEXT NOT NULL,hosts TEXT NOT NULL,disabled INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,user TEXT NOT NULL,csrf TEXT NOT NULL,expires INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS auth_audit(id INTEGER PRIMARY KEY,actor TEXT,operation TEXT,time TEXT);`,
    );
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS profiles(user TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS oidc_identities(issuer TEXT NOT NULL,subject TEXT NOT NULL,user TEXT NOT NULL,PRIMARY KEY(issuer,subject));
      CREATE TABLE IF NOT EXISTS oidc_flows(state TEXT PRIMARY KEY,binding TEXT NOT NULL,verifier TEXT NOT NULL,nonce TEXT NOT NULL,expires INTEGER NOT NULL,revision TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notification_dismissals(user TEXT NOT NULL,key TEXT NOT NULL,PRIMARY KEY(user,key));
      PRAGMA user_version=2; COMMIT;`);
    fs.chmodSync(path.join(dir, "identity.db"), 0o600);
  }
  setting(key) {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key=?")
      .get(key);
    return row ? JSON.parse(row.value) : null;
  }
  setSetting(key, value) {
    this.db
      .prepare(
        "INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, JSON.stringify(value));
  }
  profile(user) {
    const row = this.db
      .prepare("SELECT data FROM profiles WHERE user=?")
      .get(user.id);
    return row
      ? JSON.parse(row.data)
      : {
          displayName: user.name,
          avatar: "initials",
          theme: "system",
          updateNotifications: true,
        };
  }
  saveProfile(user, data) {
    const name =
      typeof data.displayName === "string" ? data.displayName.trim() : "";
    if (!name || name.length > 80)
      throw Error("Anzeigename benötigt 1–80 Zeichen");
    if (!["initials", "user", "shield", "cube", "cloud"].includes(data.avatar))
      throw Error("Ungültiges Profil-Icon");
    if (!["light", "dark", "system"].includes(data.theme))
      throw Error("Ungültiges Farbschema");
    const profile = {
      displayName: name,
      avatar: data.avatar,
      theme: data.theme,
      updateNotifications: data.updateNotifications !== false,
    };
    this.db
      .prepare(
        "INSERT INTO profiles VALUES(?,?) ON CONFLICT(user) DO UPDATE SET data=excluded.data",
      )
      .run(user.id, JSON.stringify(profile));
    return profile;
  }
  federated(issuer, claims, config) {
    if (
      typeof claims.sub !== "string" ||
      !claims.sub ||
      claims.sub.length > 255
    )
      throw Error("OIDC-Subject fehlt");
    let user = this.db
      .prepare(
        "SELECT u.* FROM oidc_identities i JOIN users u ON u.id=i.user WHERE i.issuer=? AND i.subject=?",
      )
      .get(issuer, claims.sub);
    if (user?.disabled) throw Error("Dieses Benutzerkonto ist deaktiviert");
    if (!user) {
      if (!config.autoProvision)
        throw Error("Dieses Konto ist für CUO noch nicht freigeschaltet");
      const id = randomBytes(16).toString("hex");
      const displayName = String(
        claims.name || claims.preferred_username || "OIDC-Benutzer",
      ).slice(0, 80);
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db
          .prepare(
            "INSERT INTO users(id,name,password,role,hosts) VALUES(?,?,?,?,?)",
          )
          .run(
            id,
            "oidc-" + id,
            "!oidc",
            config.defaultRole,
            JSON.stringify(["local"]),
          );
        this.db
          .prepare("INSERT INTO oidc_identities VALUES(?,?,?)")
          .run(issuer, claims.sub, id);
        this.saveProfile(
          { id, name: displayName },
          {
            displayName,
            avatar: "initials",
            theme: "system",
            updateNotifications: true,
          },
        );
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
      user = this.db.prepare("SELECT * FROM users WHERE id=?").get(id);
    }
    return user;
  }
  dismissed(user) {
    return this.db
      .prepare("SELECT key FROM notification_dismissals WHERE user=?")
      .all(user.id)
      .map((r) => r.key);
  }
  dismiss(user, ids) {
    if (
      !Array.isArray(ids) ||
      ids.length > 500 ||
      ids.some((id) => typeof id !== "string" || id.length > 400)
    )
      throw Error("Ungültige Benachrichtigungen");
    const statement = this.db.prepare(
      "INSERT OR IGNORE INTO notification_dismissals VALUES(?,?)",
    );
    this.db.exec("BEGIN");
    try {
      for (const id of ids) statement.run(user.id, id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  count() {
    return this.db.prepare("SELECT COUNT(*) n FROM users").get().n;
  }
  async password(value) {
    if (typeof value !== "string" || value.length < 12 || value.length > 256)
      throw Error("Passwort muss 12 bis 256 Zeichen enthalten");
    const salt = randomBytes(16).toString("hex");
    return (
      salt + ":" + Buffer.from(await scrypt(value, salt, 64)).toString("hex")
    );
  }
  async verify(value, stored) {
    const [salt, key] = stored.split(":");
    if (!salt || !/^[a-f0-9]{128}$/.test(key || "")) return false;
    const actual = Buffer.from(
      await scrypt(
        typeof value === "string" ? value.slice(0, 256) : "",
        salt,
        64,
      ),
    );
    return (
      actual.length === Buffer.from(key, "hex").length &&
      timingSafeEqual(actual, Buffer.from(key, "hex"))
    );
  }
  session(req) {
    const cookies = Object.fromEntries(
      (req.headers.cookie || "").split(";").map((s) => s.trim().split("=")),
    );
    const id = cookies.cuo_session;
    if (!id) return null;
    const row = this.db
      .prepare(
        "SELECT s.csrf,s.expires,u.id,u.name,u.role,u.hosts,u.disabled FROM sessions s JOIN users u ON u.id=s.user WHERE s.id=?",
      )
      .get(hash(id));
    if (!row || row.disabled || row.expires < Date.now()) return null;
    const profile = this.profile(row);
    return {
      ...row,
      name: profile.displayName,
      profile,
      hosts: JSON.parse(row.hosts),
    };
  }
  issue(res, user, secure) {
    const id = randomBytes(32).toString("hex"),
      csrf = randomBytes(32).toString("hex");
    this.db.prepare("DELETE FROM sessions WHERE expires<?").run(Date.now());
    this.db
      .prepare("INSERT INTO sessions VALUES(?,?,?,?)")
      .run(hash(id), user.id, csrf, Date.now() + 12 * 3600000);
    res.setHeader(
      "Set-Cookie",
      `cuo_session=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${secure ? "; Secure" : ""}`,
    );
    return csrf;
  }
  revoke(id) {
    this.db.prepare("DELETE FROM sessions WHERE user=?").run(id);
  }
  audit(actor, operation) {
    this.db
      .prepare("INSERT INTO auth_audit(actor,operation,time) VALUES(?,?,?)")
      .run(actor, operation, new Date().toISOString());
  }
  async create(data, owner = false) {
    if (
      typeof data.name !== "string" ||
      !/^[\p{L}\p{N} ._@-]{3,80}$/u.test(data.name)
    )
      throw Error("Benutzername benötigt 3–80 Zeichen");
    const role = owner ? "Owner" : data.role;
    if (!(role in ranks) || (!owner && role === "Owner"))
      throw Error("Ungültige Rolle");
    const password = await this.password(data.password);
    const id = randomBytes(16).toString("hex");
    this.db
      .prepare(
        "INSERT INTO users(id,name,password,role,hosts) VALUES(?,?,?,?,?)",
      )
      .run(id, data.name, password, role, JSON.stringify(["local"]));
    return { id, name: data.name, role, hosts: ["local"] };
  }
}
