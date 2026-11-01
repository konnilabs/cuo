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
    if (this.db.prepare("PRAGMA user_version").get().user_version > 1)
      throw Error("Identity schema is newer than this CUO version");
    this.db.exec(
      `PRAGMA user_version=1; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,password TEXT NOT NULL,role TEXT NOT NULL,hosts TEXT NOT NULL,disabled INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,user TEXT NOT NULL,csrf TEXT NOT NULL,expires INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS auth_audit(id INTEGER PRIMARY KEY,actor TEXT,operation TEXT,time TEXT);`,
    );
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
    return { ...row, hosts: JSON.parse(row.hosts) };
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
