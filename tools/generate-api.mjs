import fs from "node:fs";
import { fileURLToPath } from "node:url";
process.chdir(fileURLToPath(new URL("..", import.meta.url)));
// The Go domain structs are the schema source; no registry or network needed.
const source = [
    "internal/core/model.go",
    "internal/core/integration_models.go",
    "internal/core/process_model.go",
  ]
    .map((file) => fs.readFileSync(file, "utf8"))
    .join("\n"),
  schemas = {};
function schema(type) {
  if (type.startsWith("*")) return schema(type.slice(1));
  if (type.startsWith("[]"))
    return { type: "array", items: schema(type.slice(2)) };
  if (type === "string") return { type: "string" };
  if (type === "bool") return { type: "boolean" };
  if (/^int/.test(type)) return { type: "integer" };
  return { $ref: "#/components/schemas/" + type };
}
for (const match of source.matchAll(/type (\w+) struct \{([\s\S]*?)\n\}/g)) {
  const properties = {},
    required = [];
  for (const field of match[2].matchAll(
    /\w+\s+(\*?\[\]\w+|\*?\w+)\s+`json:"([^",]+)([^\"]*)"`/g,
  )) {
    properties[field[2]] = schema(field[1]);
    if (!field[3].includes("omitempty")) required.push(field[2]);
  }
  if (Object.keys(properties).length)
    schemas[match[1]] = {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    };
}
schemas.Error = {
  type: "object",
  properties: { code: { type: "string" }, message: { type: "string" } },
  required: ["code", "message"],
};
schemas.JobRequest = {
  type: "object",
  properties: {
    containerId: { type: "string" },
    reason: { type: "string", minLength: 3, maxLength: 500 },
    confirmed: { const: true },
  },
  required: ["containerId", "reason", "confirmed"],
  additionalProperties: false,
};
schemas.Approval = {
  type: "object",
  properties: {
    reason: { type: "string", minLength: 3, maxLength: 500 },
    confirmed: { const: true },
  },
  required: ["reason", "confirmed"],
  additionalProperties: false,
};
schemas.UpdateRunRequest = {
  ...schemas.Approval,
  properties: { ...schemas.Approval.properties, all: { const: true } },
  required: ["all", "reason", "confirmed"],
};
for (const name of ["Policy", "Window"]) {
  const original = schemas[name];
  schemas[name + "Request"] = {
    ...original,
    properties: Object.fromEntries(
      Object.entries(original.properties).filter(
        ([key]) => key !== "id" && key !== "nextStart",
      ),
    ),
    required: original.required.filter(
      (key) => key !== "id" && key !== "nextStart",
    ),
  };
}
schemas.RegistryImportRequest = {
  ...schemas.Approval,
  properties: {
    ...schemas.Approval.properties,
    ...Object.fromEntries(
      [
        "sourceRegistryId",
        "repository",
        "digest",
        "destinationRegistryId",
        "destinationRepository",
      ].map((k) => [k, { type: "string" }]),
    ),
  },
  required: [
    "sourceRegistryId",
    "repository",
    "digest",
    "destinationRegistryId",
    "destinationRepository",
    "reason",
    "confirmed",
  ],
};
schemas.GitHubSetupRequest = {
  type: "object",
  properties: { organization: { type: "string" } },
  additionalProperties: false,
};
const paths = {};
function endpoint(
  path,
  method,
  id,
  responseType,
  bodyType,
  role = "Viewer",
  collection = false,
) {
  const responses = {};
  const status =
    method === "post"
      ? path.includes("log-retention")
        ? 200
        : path.endsWith("scans") || path.endsWith("/sync")
          ? "202"
          : path.endsWith("approve") || path.endsWith("cancel")
            ? "200"
            : path === "/api/v1/update-jobs" || path === "/api/v1/update-runs"
              ? "201"
              : path === "/api/v1/import-jobs"
                ? "202"
                : "200"
      : "200";
  const result = collection
    ? {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: responseType ? schema(responseType) : {},
          },
        },
        required: ["items"],
      }
    : responseType
      ? schema(responseType)
      : { type: "object" };
  if (path === "/api/v1/containers" && collection) {
    for (const name of ["total", "offset", "limit"]) {
      result.properties[name] = { type: "integer" };
      result.required.push(name);
    }
  }
  responses[status] = {
    description: "Success",
    content: { "application/json": { schema: result } },
  };
  for (const code of ["400", "401", "403", "404", "409", "422", "500", "502"])
    responses[code] = {
      description: "Stable error code and safe message",
      content: { "application/json": { schema: schema("Error") } },
    };
  const parameters = [];
  for (const p of path.matchAll(/\{(\w+)\}/g))
    parameters.push({
      name: p[1],
      in: "path",
      required: true,
      schema: { type: "string" },
    });
  if (method !== "get")
    parameters.push(
      {
        name: "Idempotency-Key",
        in: "header",
        required: true,
        schema: { type: "string", minLength: 8, maxLength: 128 },
      },
      {
        name: "X-CSRF-Token",
        in: "header",
        required: true,
        schema: { type: "string" },
      },
    );
  if (path === "/api/v1/containers")
    parameters.push(
      ...["q", "refresh", "offset", "limit"].map((name) => ({
        name,
        in: "query",
        schema: {
          type: ["offset", "limit"].includes(name)
            ? "integer"
            : name === "refresh"
              ? "boolean"
              : "string",
        },
      })),
    );
  if (
    method === "get" &&
    ["/api/v1/process-runs", "/api/v1/exports"].includes(path)
  ) {
    const names = path.endsWith("exports")
      ? ["dataset", "format", "runId", "q", "status", "from", "to"]
      : ["kind", "q", "status", "from", "to", "offset", "limit"];
    parameters.push(
      ...names.map((name) => ({
        name,
        in: "query",
        schema: {
          type: ["offset", "limit"].includes(name) ? "integer" : "string",
        },
        description: ["from", "to"].includes(name)
          ? "UTC date (YYYY-MM-DD) or RFC3339; end date inclusive"
          : undefined,
      })),
    );
  }
  if (path === "/api/v1/process-runs/{id}")
    parameters.push({
      name: "after",
      in: "query",
      schema: { type: "integer", minimum: 0 },
      description: "Event cursor; at most 200 events per page",
    });
  const operation = {
    operationId: id,
    "x-cuo-min-role": role,
    parameters,
    responses,
  };
  if (bodyType)
    operation.requestBody = {
      required: true,
      content: { "application/json": { schema: schema(bodyType) } },
    };
  paths[path] ??= {};
  paths[path][method] = operation;
}
endpoint("/api/v1/hosts", "get", "hosts", "Host", undefined, "Viewer", true);
endpoint(
  "/api/v1/containers",
  "get",
  "containers",
  "Container",
  undefined,
  "Viewer",
  true,
);
endpoint("/api/v1/scans", "post", "scan", undefined, undefined, "Operator");
endpoint(
  "/api/v1/update-candidates",
  "get",
  "candidates",
  "Candidate",
  undefined,
  "Viewer",
  true,
);
endpoint(
  "/api/v1/update-jobs",
  "get",
  "jobs",
  "Job",
  undefined,
  "Viewer",
  true,
);
endpoint(
  "/api/v1/update-jobs",
  "post",
  "createJob",
  "Job",
  "JobRequest",
  "Operator",
);
endpoint("/api/v1/update-jobs/{id}", "get", "job", "Job");
endpoint(
  "/api/v1/update-runs",
  "post",
  "createRun",
  "UpdateRun",
  "UpdateRunRequest",
  "Administrator",
);
endpoint(
  "/api/v1/update-jobs/{id}/approve",
  "post",
  "approveJob",
  "Job",
  "Approval",
  "Administrator",
);
endpoint(
  "/api/v1/update-jobs/{id}/cancel",
  "post",
  "cancelJob",
  "Job",
  "Approval",
  "Operator",
);
endpoint(
  "/api/v1/policies",
  "get",
  "policies",
  "Policy",
  undefined,
  "Viewer",
  true,
);
endpoint("/api/v1/policies/{id}", "get", "policy", "Policy");
endpoint(
  "/api/v1/policies/{id}",
  "put",
  "savePolicy",
  "Policy",
  "PolicyRequest",
  "Administrator",
);
endpoint(
  "/api/v1/maintenance-windows",
  "get",
  "windows",
  "Window",
  undefined,
  "Viewer",
  true,
);
endpoint(
  "/api/v1/maintenance-windows",
  "post",
  "createWindow",
  "Window",
  "WindowRequest",
  "Administrator",
);
endpoint(
  "/api/v1/activity",
  "get",
  "activity",
  "Event",
  undefined,
  "Viewer",
  true,
);
endpoint(
  "/api/v1/registries",
  "get",
  "registries",
  "RegistryConnection",
  undefined,
  "Viewer",
  true,
);
endpoint(
  "/api/v1/registries",
  "post",
  "createRegistry",
  "RegistryConnection",
  "RegistryRequest",
  "Owner",
);
endpoint("/api/v1/registries/{id}", "get", "registry", "RegistryConnection");
endpoint(
  "/api/v1/registries/{id}",
  "put",
  "saveRegistry",
  "RegistryConnection",
  "RegistryRequest",
  "Owner",
);
endpoint(
  "/api/v1/registries/{id}/probe",
  "post",
  "probeRegistry",
  "RegistryConnection",
  undefined,
  "Operator",
);
for (const name of [
  "repositories",
  "tags",
  "artifact",
  "storage",
  "retention-preview",
])
  endpoint(
    `/api/v1/registries/{id}/${name}`,
    "get",
    "registry" + name.replace(/-([a-z])/g, (_, c) => c.toUpperCase()),
    undefined,
  );
endpoint(
  "/api/v1/integrations/github",
  "get",
  "githubConnections",
  "GitHubConnection",
  undefined,
  "Owner",
  true,
);
endpoint(
  "/api/v1/integrations/github",
  "post",
  "createGitHub",
  "GitHubConnection",
  "GitHubRequest",
  "Owner",
);
endpoint(
  "/api/v1/integrations/github/{id}",
  "put",
  "saveGitHub",
  "GitHubConnection",
  "GitHubRequest",
  "Owner",
);
for (const name of ["setup", "install", "probe"])
  endpoint(
    `/api/v1/integrations/github/{id}/${name}`,
    "post",
    "github" + name,
    undefined,
    name === "setup" ? "GitHubSetupRequest" : undefined,
    "Owner",
  );
for (const name of ["installations", "repositories", "workflows", "runs"])
  endpoint(
    `/api/v1/integrations/github/{id}/${name}`,
    "get",
    "github" + name,
    undefined,
    undefined,
    "Owner",
  );
endpoint(
  "/api/v1/subscriptions",
  "get",
  "subscriptions",
  "Subscription",
  undefined,
  "Administrator",
  true,
);
endpoint(
  "/api/v1/subscriptions",
  "post",
  "createSubscription",
  "Subscription",
  "Subscription",
  "Administrator",
);
endpoint(
  "/api/v1/subscriptions/{id}",
  "put",
  "saveSubscription",
  "Subscription",
  "Subscription",
  "Administrator",
);
endpoint(
  "/api/v1/subscriptions/{id}/sync",
  "post",
  "syncSubscription",
  undefined,
  undefined,
  "Administrator",
);
endpoint(
  "/api/v1/webhook-deliveries",
  "get",
  "webhookDeliveries",
  "WebhookDelivery",
  undefined,
  "Administrator",
  true,
);
endpoint(
  "/api/v1/webhook-deliveries/{id}/retry",
  "post",
  "retryDelivery",
  "WebhookDelivery",
  undefined,
  "Administrator",
);
endpoint(
  "/api/v1/release-sets",
  "get",
  "releaseSets",
  "ReleaseSet",
  undefined,
  "Administrator",
  true,
);
endpoint(
  "/api/v1/import-jobs",
  "get",
  "importJobs",
  "ImportJob",
  undefined,
  "Viewer",
  true,
);
endpoint(
  "/api/v1/import-jobs",
  "post",
  "createImport",
  "ImportJob",
  "RegistryImportRequest",
  "Owner",
);
endpoint(
  "/api/v1/permission-policy",
  "get",
  "permissionPolicy",
  undefined,
  undefined,
  "Owner",
);
endpoint(
  "/api/v1/permission-policy",
  "put",
  "savePermissionPolicy",
  "PermissionPolicy",
  "PermissionPolicy",
  "Owner",
);
endpoint("/api/v1/permissions/me", "get", "myCapabilities", undefined);
for (const schema of Object.values(schemas))
  for (const [name, property] of Object.entries(schema.properties || {})) {
    if (
      ["password", "pushPassword", "privateKey", "webhookSecret"].includes(name)
    )
      property.writeOnly = true;
  }
paths["/api/v1/events"] = {
  get: {
    operationId: "events",
    "x-cuo-min-role": "Viewer",
    parameters: [
      { name: "Last-Event-ID", in: "header", schema: { type: "integer" } },
      { name: "after", in: "query", schema: { type: "integer" } },
    ],
    responses: {
      200: {
        description:
          "Authorized resumable stream with event: activity, numeric id, JSON Event data. Reconnect after session verification.",
        content: { "text/event-stream": { schema: { type: "string" } } },
      },
    },
  },
};
endpoint(
  "/api/v1/process-runs",
  "get",
  "processes",
  "ProcessPage",
  undefined,
  "Viewer",
  false,
);
endpoint("/api/v1/process-runs/{id}", "get", "processDetail", "ProcessDetail");
endpoint("/api/v1/log-retention", "get", "logStorage", "LogStorage");
endpoint(
  "/api/v1/log-retention",
  "put",
  "saveLogRetention",
  "LogRetention",
  "LogMaintenanceRequest",
  "Owner",
);
for (const action of ["rotate", "reset", "compact"])
  endpoint(
    "/api/v1/log-retention/" + action,
    "post",
    "logs" + action,
    "LogMaintenanceResult",
    "LogMaintenanceRequest",
    "Owner",
  );
endpoint("/api/v1/exports", "get", "exportData", "DataExport");
for (const [path, methods] of Object.entries(paths))
  for (const [method, op] of Object.entries(methods)) {
    let cap = "inventory.read";
    if (path.includes("log-retention") && method !== "get") cap = "logs.manage";
    else if (path.includes("permissions/me")) cap = "authenticated";
    else if (path.includes("permission-policy")) cap = "roles.manage";
    else if (path.includes("registries"))
      cap =
        method === "get"
          ? "registry.read"
          : path.endsWith("/probe")
            ? "registry.scan"
            : "registry.manage";
    else if (path.includes("import-jobs"))
      cap = method === "get" ? "registry.read" : "registry.import";
    else if (path.includes("integrations/github"))
      cap =
        method === "get" && !path.endsWith("/installations")
          ? "webhook.read"
          : "github.manage";
    else if (path.includes("webhook-deliveries"))
      cap = method === "get" ? "webhook.read" : "webhook.retry";
    else if (path.includes("release-sets")) cap = "webhook.read";
    else if (path.includes("subscriptions"))
      cap = method === "get" ? "webhook.read" : "subscriptions.manage";
    else if (method !== "get")
      cap =
        path.includes("policies") || path.includes("maintenance-windows")
          ? "policies.manage"
          : path.endsWith("scans")
            ? "updates.scan"
            : path.includes("update-runs") || path.endsWith("approve")
              ? "updates.approve"
              : "updates.request";
    op["x-cuo-capability"] = cap;
    op.description =
      "The versioned role capability policy and host ACL are authoritative. x-cuo-min-role documents initial defaults only.";
  }
const spec = {
  openapi: "3.1.0",
  info: {
    title: "CUO API",
    version: "0.3.1",
    description:
      "Same-origin BFF API. Browser authenticates with HttpOnly session cookie and CSRF. Core is internal and requires a service bearer token plus server-supplied principal headers. Only host local is supported.",
  },
  servers: [{ url: "/" }],
  security: [{ session: [] }],
  paths,
  components: {
    securitySchemes: {
      session: { type: "apiKey", in: "cookie", name: "cuo_session" },
    },
    schemas,
  },
};
fs.writeFileSync("docs/openapi.json", JSON.stringify(spec, null, 2) + "\n");
function ts(s) {
  if (s.$ref) return s.$ref.split("/").pop();
  if (s.const !== undefined) return JSON.stringify(s.const);
  if (s.type === "array") return `Array<${ts(s.items)}>`;
  if (s.type === "integer" || s.type === "number") return "number";
  if (s.type === "boolean") return "boolean";
  if (s.type === "string") return "string";
  if (s.type === "object") {
    return (
      "{" +
      Object.entries(s.properties || {})
        .map(
          ([k, v]) =>
            JSON.stringify(k) +
            (s.required?.includes(k) ? "" : "?") +
            ":" +
            ts(v),
        )
        .join(";") +
      "}"
    );
  }
  return "unknown";
}
let output =
  "// Generated by tools/generate-api.mjs from Go structs and the OpenAPI contract.\n";
for (const [name, s] of Object.entries(schemas))
  output += `export type ${name}=${ts(s)};\n`;
output +=
  "export interface CUOTransport{request<T>(method:string,path:string,body?:unknown,key?:string):Promise<T>}\nexport function createCUOClient(transport:CUOTransport){return {\n";
for (const [path, methods] of Object.entries(paths))
  for (const [method, op] of Object.entries(methods)) {
    if (op.operationId === "events") continue;
    const hasID = path.includes("{id}"),
      body = op.requestBody?.content["application/json"].schema;
    const success = Object.values(op.responses)[0]?.content?.[
      "application/json"
    ]?.schema;
    const args = [
      ...(hasID ? ["id:string"] : []),
      ...(body ? ["body:" + ts(body)] : []),
      ...(method !== "get" ? ["key:string"] : []),
    ];
    output += `${op.operationId}:(${args.join(",")})=>transport.request<${ts(success || {})}>('${method.toUpperCase()}',\`${path.replace("{id}", "${encodeURIComponent(id)}")}\`,${body ? "body" : "undefined"},${method !== "get" ? "key" : "undefined"}),\n`;
  }
output += "}}\n";
fs.writeFileSync("console/src/generated-api.ts", output);
console.log("Generated OpenAPI and typed CUO client.");
