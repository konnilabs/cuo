// Real backup/restore scripts against a disposable Compose project. No Docker
// socket, host filesystem projects, existing CUO volumes or published ports.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));
fs.mkdirSync("work", { recursive: true });
const directory = fs.mkdtempSync(path.resolve("work/_restore-test-")),
  project = "cuo-restore-test-" + randomBytes(4).toString("hex");
const composeFile = path.join(directory, "compose.json");
const env = {
  ...process.env,
  COMPOSE_PROJECT_NAME: project,
  COMPOSE_FILE: composeFile,
  CUO_CORE_TOKEN: randomBytes(32).toString("hex"),
  CUO_AGENT_TOKEN: randomBytes(32).toString("hex"),
};
const withRegistry = process.env.CUO_RESTORE_REGISTRY === "1";
const services = {
  agent: {
    image: "cuo-agent:0.2.0",
    entrypoint: ["sh", "-c", "while :; do sleep 3600; done"],
    stop_grace_period: "1s",
    volumes: ["agent:/data"],
  },
  core: {
    image: "cuo-core:0.2.0",
    environment: {
      CUO_CORE_TOKEN: env.CUO_CORE_TOKEN,
      CUO_AGENT_URL: "http://127.0.0.1:1",
    },
    volumes: [
      "core:/data",
      `${directory}/secrets/integration.key:/run/secrets/cuo-integration-key:ro`,
    ],
    healthcheck: {
      test: [
        "CMD",
        "wget",
        "-q",
        "-O",
        "/dev/null",
        "http://127.0.0.1:8091/health",
      ],
      interval: "1s",
      retries: 30,
    },
  },
  console: {
    image: "cuo-console:0.2.0",
    environment: {
      CUO_CORE_TOKEN: env.CUO_CORE_TOKEN,
      CUO_CORE_URL: "http://core:8091",
      CUO_ORIGIN: "http://127.0.0.1:8095",
    },
    volumes: ["identity:/data"],
    depends_on: { core: { condition: "service_healthy" } },
    healthcheck: {
      test: [
        "CMD",
        "node",
        "-e",
        "fetch('http://127.0.0.1:8095/health').then(r=>process.exit(r.ok?0:1))",
      ],
      interval: "1s",
      retries: 30,
    },
  },
};
if (withRegistry) {
  const zot = JSON.parse(
    fs.readFileSync("dependencies/zot/zot.lock.json", "utf8"),
  );
  services.zot = {
    image: zot.image,
    user: "10001:10001",
    command: ["serve", "/etc/zot/config.json"],
    volumes: ["zot:/var/lib/registry", `${directory}/secrets/zot:/etc/zot:ro`],
    healthcheck: {
      test: [
        "CMD",
        "/usr/local/bin/zot-linux-amd64",
        "healthcheck",
        "/etc/zot/config.json",
      ],
      interval: "1s",
      retries: 30,
    },
  };
  Object.assign(services.core.environment, {
    CUO_ZOT_ENABLED: "1",
    CUO_ZOT_HOST: "localhost:5055",
    CUO_ZOT_INTERNAL_URL: "http://zot:5000",
    CUO_ZOT_CREDENTIALS_FILE: "/run/secrets/cuo-zot-client",
  });
  services.core.volumes.push(
    `${directory}/secrets/zot-client.json:/run/secrets/cuo-zot-client:ro`,
  );
}
fs.writeFileSync(
  composeFile,
  JSON.stringify({
    services,
    volumes: {
      identity: {},
      core: {},
      agent: {},
      ...(withRegistry ? { zot: {} } : {}),
    },
    networks: { default: { internal: true } },
  }),
  { mode: 0o600 },
);
const run = (command, args, input) =>
  execFileSync(command, args, {
    env,
    input,
    encoding: "utf8",
    timeout: 180000,
    stdio: ["pipe", "pipe", "pipe"],
  });
const compose = (...args) => run("docker", ["compose", ...args]);
const helper = (code) =>
  run("docker", [
    "run",
    "--rm",
    "--pull",
    "never",
    "--network",
    withRegistry ? `${project}_default` : "none",
    "--user",
    "0",
    "--entrypoint",
    "node",
    ...Object.entries({
      identity: "/data",
      core: "/core",
      agent: "/agent",
      ...(withRegistry ? { zot: "/registry" } : {}),
    }).flatMap(([name, target]) => [
      "--mount",
      `type=volume,source=${project}_${name},target=${target}`,
    ]),
    ...(withRegistry
      ? [
          "--mount",
          `type=bind,source=${directory}/secrets/zot-client.json,target=/fixture-credentials.json,readonly`,
        ]
      : []),
    "cuo-console:0.2.0",
    "--input-type=module",
    "-e",
    code,
  ]);
const output = process.env.CUO_RESTORE_REPORT || "reports/restore-test.json";
try {
  fs.mkdirSync(path.join(directory, "secrets"), { mode: 0o700 });
  run("docker", [
    "run",
    "--rm",
    "--network",
    "none",
    "--user",
    "0",
    "--mount",
    `type=bind,source=${directory}/secrets,target=/setup`,
    "cuo-core:0.2.0",
    "provision",
    "--directory",
    "/setup",
    ...(withRegistry ? ["--registry"] : []),
  ]);
  if (withRegistry) {
    run("docker", ["volume", "create", `${project}_zot`]);
    run("docker", [
      "run",
      "--rm",
      "--network",
      "none",
      "--user",
      "0",
      "--entrypoint",
      "chown",
      "--mount",
      `type=volume,source=${project}_zot,target=/registry`,
      "cuo-core:0.2.0",
      "10001:10001",
      "/registry",
    ]);
  }
  compose("up", "-d", "--no-build", "--pull", "never", "--wait");
  helper(`
    import fs from 'node:fs';import {DatabaseSync} from 'node:sqlite';import {Auth} from './server/auth.mjs';
    const auth=new Auth('/data');
    auth.db.prepare('INSERT INTO users(id,name,password,role,hosts) VALUES(?,?,?,?,?)').run('restore-owner','restore-owner',await auth.password('restore-test-password-42'),'Owner','["local"]');
    auth.saveProfile({id:'restore-owner'},{displayName:'Restore Owner',avatar:'cube',theme:'dark',updateNotifications:true});
    auth.setSetting('restore-oidc-fixture',{issuer:'https://provider.invalid',clientSecret:'disposable-test-secret'});
    auth.dismiss({id:'restore-owner'},['restore-notification']);auth.audit('restore-owner','restore.fixture');auth.db.close();
    const core=new DatabaseSync('/core/cuo.db');
    core.prepare('INSERT INTO records VALUES(?,?,?)').run('policy','restore-policy',JSON.stringify({id:'restore-policy',scope:'container',target:'nonexistent-fixture',mode:'scan-only'}));
    core.prepare('INSERT INTO records VALUES(?,?,?)').run('job','restore-job',JSON.stringify({id:'restore-job',hostId:'local',state:'cancelled'}));
    core.prepare('INSERT INTO events(host,data) VALUES(?,?)').run('local',JSON.stringify({operation:'restore.fixture',hostId:'local'}));core.close();
    fs.mkdirSync('/agent/compose-locks',{recursive:true});fs.writeFileSync('/agent/compose-locks/fixture.json',JSON.stringify({services:{fixture:{image:'example.invalid/app@sha256:fixture',environment:{FIXTURE:'restored'}}}}));
    fs.writeFileSync('/agent/fixture-job.json',JSON.stringify({frame:{stage:'succeeded'},operation:{jobId:'restore-job'}}));
  `);
  const registryFixture = `
   import fs from 'node:fs';import {createHash} from 'node:crypto';import assert from 'node:assert/strict';
   const credentials=JSON.parse(fs.readFileSync('/fixture-credentials.json'));const base='http://zot:5000';
   const config=Buffer.from(JSON.stringify({architecture:'amd64',os:'linux',rootfs:{type:'layers',diff_ids:[]},config:{Cmd:['/bin/true']}}));
   const configDigest='sha256:'+createHash('sha256').update(config).digest('hex');
   const manifest=Buffer.from(JSON.stringify({schemaVersion:2,mediaType:'application/vnd.oci.image.manifest.v1+json',config:{mediaType:'application/vnd.oci.image.config.v1+json',digest:configDigest,size:config.length},layers:[]}));
   const manifestDigest='sha256:'+createHash('sha256').update(manifest).digest('hex');
  `;
  if (withRegistry)
    helper(
      registryFixture +
        `
   const headers={Authorization:'Basic '+Buffer.from(credentials.pushUsername+':'+credentials.pushPassword).toString('base64')};
   const upload=await fetch(base+'/v2/universal/restore/blobs/uploads/',{method:'POST',headers});assert.equal(upload.status,202);
   const location=new URL(upload.headers.get('location'),base);location.searchParams.set('digest',configDigest);
   const blob=await fetch(location,{method:'PUT',headers:{...headers,'Content-Type':'application/octet-stream'},body:config});assert.equal(blob.status,201);
   const result=await fetch(base+'/v2/universal/restore/manifests/stable',{method:'PUT',headers:{...headers,'Content-Type':'application/vnd.oci.image.manifest.v1+json'},body:manifest});assert.equal(result.status,201);
  `,
    );
  const backup = path.join(directory, "backup.tar.gz");
  run("sh", ["tools/backup.sh", backup]);
  assert.equal(fs.statSync(backup).mode & 0o777, 0o600);
  compose("stop");
  helper(
    `import fs from 'node:fs';import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync('/data/identity.db');db.exec('DELETE FROM users;DELETE FROM profiles;DELETE FROM settings;DELETE FROM notification_dismissals');db.close();const core=new DatabaseSync('/core/cuo.db');core.exec("DELETE FROM records WHERE id IN ('restore-policy','restore-job');DELETE FROM events");core.close();fs.rmSync('/agent/compose-locks',{recursive:true});fs.rmSync('/agent/fixture-job.json');fs.writeFileSync('/agent/after-backup','must disappear');`,
  );
  if (withRegistry)
    helper(
      `import fs from 'node:fs';fs.rmSync('/registry/universal',{recursive:true});`,
    );
  run("sh", ["tools/restore.sh", backup], "RESTORE\n");
  if (withRegistry)
    helper(
      registryFixture +
        `
   const headers={Authorization:'Basic '+Buffer.from(credentials.pullUsername+':'+credentials.pullPassword).toString('base64')};
   const result=await fetch(base+'/v2/universal/restore/manifests/stable',{headers});assert.equal(result.status,200);assert.equal(result.headers.get('docker-content-digest'),manifestDigest);assert.equal(Buffer.from(await result.arrayBuffer()).equals(manifest),true);
   const blob=await fetch(base+'/v2/universal/restore/blobs/'+configDigest,{headers});assert.equal(blob.status,200);assert.equal(Buffer.from(await blob.arrayBuffer()).equals(config),true);
  `,
    );
  const safety = fs
    .readdirSync(directory)
    .filter((name) => name.startsWith("backup.tar.gz.before-restore."));
  assert.equal(safety.length, 1);
  assert.equal(
    fs.statSync(path.join(directory, safety[0])).mode & 0o777,
    0o600,
  );
  helper(`
    import assert from 'node:assert/strict';import fs from 'node:fs';import {DatabaseSync} from 'node:sqlite';import {Auth} from './server/auth.mjs';
    const auth=new Auth('/data');const owner=auth.db.prepare('SELECT * FROM users WHERE id=?').get('restore-owner');assert.equal(owner.role,'Owner');assert.equal(await auth.verify('restore-test-password-42',owner.password),true);assert.equal(auth.profile(owner).theme,'dark');assert.equal(auth.setting('restore-oidc-fixture').clientSecret,'disposable-test-secret');assert.deepEqual(auth.dismissed(owner),['restore-notification']);assert.equal(auth.db.prepare("SELECT count(*) n FROM auth_audit WHERE operation='restore.fixture'").get().n,1);assert.equal(auth.db.prepare('PRAGMA quick_check').get().quick_check,'ok');auth.db.close();
    const core=new DatabaseSync('/core/cuo.db');assert.equal(core.prepare("SELECT count(*) n FROM records WHERE id IN ('restore-policy','restore-job')").get().n,2);assert.equal(core.prepare("SELECT count(*) n FROM events WHERE json_extract(data,'$.operation')='restore.fixture'").get().n,1);assert.equal(core.prepare('PRAGMA quick_check').get().quick_check,'ok');core.close();
    assert.equal(JSON.parse(fs.readFileSync('/agent/compose-locks/fixture.json')).services.fixture.environment.FIXTURE,'restored');assert.equal(JSON.parse(fs.readFileSync('/agent/fixture-job.json')).frame.stage,'succeeded');assert.equal(fs.existsSync('/agent/after-backup'),false);
  `);
  compose(
    "exec",
    "-T",
    "console",
    "node",
    "--input-type=module",
    "-e",
    `const r=await fetch('http://127.0.0.1:8095/auth/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:'http://127.0.0.1:8095'},body:JSON.stringify({name:'restore-owner',password:'restore-test-password-42'})});if(r.status!==200)throw Error('Restored BFF login failed: '+r.status);if(!r.headers.get('set-cookie')?.includes('cuo_session='))throw Error('Restored login did not issue a session');`,
  );
  const report = {
    schema: "cuo.restore-test.v1",
    createdAt: new Date().toISOString(),
    revision: run("git", ["rev-parse", "HEAD"]).trim(),
    dirty: !!run("git", ["status", "--porcelain"]).trim(),
    images: Object.fromEntries(
      ["console", "core", "agent"].map((s) => [
        s,
        run("docker", [
          "image",
          "inspect",
          "--format",
          "{{.Id}}",
          `cuo-${s}:0.2.0`,
        ]).trim(),
      ]),
    ),
    passed: true,
    isolation: {
      disposableVolumes: withRegistry ? 4 : 3,
      dockerSocket: false,
      publishedPorts: false,
      externalNetwork: false,
    },
    checks: [
      "actual backup.sh/restore.sh",
      ...(withRegistry
        ? [
            "optional Zot configuration and real authenticated OCI manifest/blob fetch after restore",
          ]
        : []),
      "backup mode 0600",
      "SQLite identity/Core integrity",
      "password login and Owner role after restart",
      "profile, OIDC setting and notification dismissal",
      "Core policies, jobs and audit history",
      "Agent journals and Compose desired state",
      "post-backup files removed",
      "pre-restore safety snapshot",
    ],
  };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
} finally {
  try {
    compose("down", "-v", "--remove-orphans");
  } finally {
    // Provisioned files belong to service UID 10001, so remove only this
    // disposable test directory through a narrowly mounted root helper.
    run("docker", [
      "run",
      "--rm",
      "--network",
      "none",
      "--user",
      "0",
      "--entrypoint",
      "sh",
      "--mount",
      `type=bind,source=${directory},target=/fixture`,
      "cuo-core:0.2.0",
      "-c",
      "find /fixture -mindepth 1 -delete",
    ]);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
