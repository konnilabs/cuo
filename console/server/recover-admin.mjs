import { Auth } from "./auth.mjs";
import { createInterface } from "node:readline/promises";
const auth = new Auth(process.env.CUO_AUTH_DATA || "/data"),
  rl = createInterface({ input: process.stdin, output: process.stdout });
const name = await rl.question("Owner-Benutzername: ");
const user = auth.db
  .prepare("SELECT id FROM users WHERE name=? AND role='Owner'")
  .get(name);
if (!user) {
  rl.close();
  throw Error("Owner nicht gefunden");
}
// Host possession is the recovery boundary; keep secret out of logs and process args.
process.stdout.write("Neues Passwort (Eingabe verborgen): ");
rl.close();
process.stdin.setRawMode?.(true);
process.stdin.resume();
let password = "";
await new Promise((resolve, reject) => {
  process.stdin.on("data", (chunk) => {
    for (const c of chunk.toString()) {
      if (c === "\r" || c === "\n") {
        process.stdin.setRawMode?.(false);
        process.stdout.write("\n");
        resolve();
        return;
      }
      if (c === "\u0003") process.exit(1);
      if (c === "\u007f") password = password.slice(0, -1);
      else password += c;
    }
  });
});
auth.db
  .prepare("UPDATE users SET password=? WHERE id=?")
  .run(await auth.password(password), user.id);
password = "";
auth.revoke(user.id);
auth.audit("host-owner", "owner.recovery:" + user.id);
console.log("Passwort aktualisiert; alle bisherigen Sitzungen widerrufen.");
process.exit(0);
