import type { VM, Intent } from "./contracts.ts";
import type {
  RegistryConnection,
  RegistryRequest,
  GitHubConnection,
  GitHubRequest,
  Subscription,
  PermissionPolicy,
} from "./generated-api.ts";
import type { IntegrationElement } from "../components/integrations.d.ts";

type API = (
  path: string,
  method?: string,
  body?: unknown,
  key?: string,
  signal?: AbortSignal,
) => Promise<any>;
type Context = { api: API; refresh: (vm: VM) => Promise<VM> };
type Values = Record<string, string | boolean>;
const resources = new Map<string, AbortController>();
export const integrationPages: Record<string, string> = {
  registries: "UniOCI Registries",
  registry: "Registry-Einstellungen",
  repositories: "Repositories",
  github: "GitHub",
  deliveries: "GitHub Inbox",
  subscriptions: "Release-Subscriptions",
  permissions: "Rollenberechtigungen",
};
export const integrationRoutes = [
  { path: "/registries", page: "registries" },
  { path: "/registries/:id/repositories", page: "repositories" },
  { path: "/registries/:id", page: "registry" },
  { path: "/integrations/github", page: "github" },
  { path: "/integrations/github/:id/deliveries", page: "deliveries" },
  { path: "/subscriptions", page: "subscriptions" },
  { path: "/users/permissions", page: "permissions" },
];
export function routeDetails(path: string) {
  path = path.split("?")[0] || "/dashboard";
  let page = path.slice(1) || "dashboard",
    registryId = "",
    githubId = "";
  if (/^\/registries\/(?:new|[a-f0-9]{32})\/repositories$/.test(path)) {
    page = "repositories";
    registryId = path.split("/")[2];
  } else if (/^\/registries\/(?:new|[a-f0-9]{32})$/.test(path)) {
    page = "registry";
    registryId = path.split("/")[2];
  } else if (path === "/integrations/github") page = "github";
  else if (/^\/integrations\/github\/[a-f0-9]{32}\/deliveries$/.test(path)) {
    page = "deliveries";
    githubId = path.split("/")[3];
  } else if (path === "/users/permissions") page = "permissions";
  return {
    page,
    routePath: path,
    registryId,
    githubId,
    registryEditor: registryId === "new" ? "new" : "",
  };
}
export function cancelIntegrationQueries() {
  for (const controller of resources.values()) controller.abort();
  resources.clear();
}
export function integrationInitial() {
  return {
    capabilities: [] as string[],
    registries: [] as RegistryConnection[],
    githubConnections: [] as GitHubConnection[],
    subscriptions: [] as Subscription[],
    webhookDeliveries: [],
    releaseSets: [],
    importJobs: [],
    registryRepositories: [],
    registryTags: [],
    githubInstallations: [],
    githubCatalog: {},
    permissionMatrix: null,
    registryId: "",
    githubId: "",
    routePath: "/dashboard",
    registryEditor: "",
    githubEditorId: "",
    subscriptionEditorId: "",
    subscriptionTargetCount: 1,
    repository: "",
    artifactReference: "latest",
    artifact: null,
    artifactOpen: false,
    integrationBusy: false,
    integrationQueryBusy: false,
    integrationQueryError: "",
    integrationRequest: "",
    integrationOperation: "",
    registryStorage: null,
    retentionPreview: null,
  };
}
export async function loadIntegrations(vm: VM, api: API): Promise<VM> {
  const response = await api("/api/v1/permissions/me");
  vm.capabilities = Array.isArray(response.capabilities)
    ? response.capabilities
    : [];
  if (!Object.hasOwn(integrationPages, vm.page)) return vm;
  const allowed = (cap: string) =>
    vm.user.role === "Owner" || (vm.capabilities as string[]).includes(cap);
  const queries: [string, string][] = [];
  if (allowed("registry.read"))
    queries.push(
      ["registries", "/api/v1/registries"],
      ["importJobs", "/api/v1/import-jobs"],
    );
  if (allowed("webhook.read") || allowed("github.manage"))
    queries.push(["githubConnections", "/api/v1/integrations/github"]);
  if (allowed("webhook.read"))
    queries.push(
      ["subscriptions", "/api/v1/subscriptions"],
      ["webhookDeliveries", "/api/v1/webhook-deliveries"],
      ["releaseSets", "/api/v1/release-sets"],
    );
  await Promise.all(
    queries.map(async ([key, path]) => {
      const result = await api(path);
      vm[key] = result.items || [];
    }),
  );
  if (vm.page === "permissions" && allowed("roles.manage"))
    vm.permissionMatrix = await api("/api/v1/permission-policy");
  return vm;
}
const str = (v: Values, k: string) => String(v[k] ?? "").trim();
const bool = (v: Values, k: string) => v[k] === true || v[k] === "on";
const parts = (value: string) =>
  value
    .split(/[,\n]/)
    .map((v) => v.trim())
    .filter(Boolean);
function sourceElement(source: string): IntegrationElement {
  if (!/^x-(?:unioci|cuo)-[a-z-]+$/.test(source))
    throw Error("Ungültige Komponentenquelle");
  const element = document.querySelector(source) as IntegrationElement | null;
  if (!element?.takeSubmission) throw Error("Formular nicht verfügbar");
  return element;
}
function send(kind: string, data: Record<string, unknown>) {
  void window.XTendMaraca.dispatchCommand("cuo.intent", { kind, data }).catch(
    () => {},
  );
}
function query(
  vm: VM,
  api: API,
  path: string,
  context: string,
  extra: Record<string, unknown> = {},
): VM {
  cancelIntegrationQueries();
  const token = crypto.randomUUID(),
    controller = new AbortController();
  resources.set(token, controller);
  const route = String(vm.routePath || "");
  void api(path, "GET", undefined, undefined, controller.signal)
    .then((result) => {
      if (!controller.signal.aborted)
        send("integrationQueryResult", {
          token,
          route,
          context,
          result,
          ...extra,
        });
    })
    .catch((error) => {
      if (!controller.signal.aborted)
        send("integrationQueryResult", {
          token,
          route,
          context,
          error: error.message,
        });
    })
    .finally(() => resources.delete(token));
  return {
    ...vm,
    integrationRequest: token,
    integrationQueryBusy: true,
    integrationQueryError: "",
  };
}
function mutation(
  vm: VM,
  api: API,
  path: string,
  method: string,
  payload: unknown,
  element?: IntegrationElement,
  op = "save",
): VM {
  const operation = crypto.randomUUID(),
    page = vm.page;
  void api(path, method, payload, operation)
    .then((result) => {
      send("integrationMutationResult", {
        operation,
        message:
          op === "save" ? "Änderung gespeichert." : "Aktion wurde angenommen.",
        id: result.id || "",
        op,
        ...(op === "setup" || op === "install" ? { handoff: result } : {}),
      });
    })
    .catch((error) =>
      send("integrationMutationResult", { operation, error: error.message }),
    )
    .finally(() => {
      element?.finishSubmission();
      if (payload && typeof payload === "object")
        for (const name of [
          "password",
          "pushPassword",
          "privateKey",
          "webhookSecret",
        ])
          delete (payload as Record<string, unknown>)[name];
    });
  return { ...vm, integrationBusy: true, integrationOperation: operation };
}
function navigate(vm: VM, path: string): VM {
  cancelIntegrationQueries();
  const router = document.getElementById("cuo-router") as HTMLElement & {
    navigate(path: string): boolean;
  };
  if (!router?.navigate("/" + path)) throw Error("Navigation nicht bereit");
  return {
    ...vm,
    ...routeDetails("/" + path),
    integrationQueryBusy: false,
    integrationRequest: "",
  };
}

export async function integrationIntent(
  vm: VM,
  input: Intent,
  context: Context,
): Promise<VM | null> {
  const { kind, id = "", value = "", data = {} } = input,
    api = context.api;
  if (!kind.startsWith("integration")) return null;
  if (kind === "integrationCloseArtifact")
    return { ...vm, artifactOpen: false };
  if (kind === "integrationQueryResult") {
    if (data.token !== vm.integrationRequest || data.route !== vm.routePath)
      return vm;
    vm = {
      ...vm,
      integrationQueryBusy: false,
      integrationQueryError: String(data.error || ""),
    };
    if (data.error) return vm;
    const result = data.result as any;
    switch (data.context) {
      case "repositories":
        vm.registryRepositories = result.items || [];
        break;
      case "tags":
        vm.repository = data.repository;
        vm.registryTags = result.items || [];
        break;
      case "artifact":
        vm.artifact = result;
        vm.artifactOpen = true;
        vm.repository = data.repository;
        vm.artifactReference = data.reference;
        break;
      case "installations":
        vm.githubInstallations = result.items || [];
        break;
      case "githubRepositories":
        vm.githubCatalog = {
          connectionId: data.connectionId,
          repositories: result.items || [],
          workflows: [],
        };
        break;
      case "githubWorkflows":
        vm.githubCatalog = {
          ...(vm.githubCatalog as object),
          repository: data.repository,
          repositoryId: data.repositoryId,
          workflows: result.items || [],
        };
        break;
      case "storage":
        vm.registryStorage = result;
        break;
      case "retention":
        vm.retentionPreview = result;
        break;
    }
    return vm;
  }
  if (kind === "integrationMutationResult") {
    if (data.operation !== vm.integrationOperation) return vm;
    if (data.handoff && !data.error) {
      (
        document.querySelector(
          "x-cuo-github-connection",
        ) as IntegrationElement | null
      )?.beginRegistration(data.handoff);
    }
    vm = {
      ...vm,
      integrationBusy: false,
      notice: String(data.error || data.message || ""),
      error: !!data.error,
    };
    if (!data.error) {
      vm = await context.refresh(vm);
      if (data.op === "saveRegistry" && data.id && vm.page === "registry")
        vm = navigate(vm, "registries/" + data.id);
    }
    return vm;
  }
  if (vm.demo)
    return {
      ...vm,
      notice:
        "Diese Ansicht ist eine Vorschau. Änderungen und Verbindungen benötigen die Live-Instanz.",
      error: false,
    };
  if (kind === "integrationNewRegistry") return navigate(vm, "registries/new");
  if (kind === "integrationNewGithub")
    return { ...vm, githubEditorId: "", githubInstallations: [] };
  if (kind === "integrationEditGithub")
    return { ...vm, githubEditorId: id, githubInstallations: [] };
  if (kind === "integrationNewSubscription")
    return {
      ...vm,
      subscriptionEditorId: "",
      subscriptionTargetCount: 1,
      githubCatalog: {},
    };
  if (kind === "integrationEditSubscription")
    return { ...vm, subscriptionEditorId: id, githubCatalog: {} };
  if (kind === "integrationAddTarget")
    return {
      ...vm,
      subscriptionTargetCount: Math.min(
        20,
        Number(vm.subscriptionTargetCount || 1) + 1,
      ),
    };
  if (kind === "integrationProbeRegistry")
    return mutation(
      vm,
      api,
      `/api/v1/registries/${id}/probe`,
      "POST",
      {},
      undefined,
      "probe",
    );
  if (kind === "integrationProbeGithub")
    return mutation(
      vm,
      api,
      `/api/v1/integrations/github/${id}/probe`,
      "POST",
      {},
      undefined,
      "probe",
    );
  if (kind === "integrationRetryDelivery")
    return mutation(
      vm,
      api,
      `/api/v1/webhook-deliveries/${id}/retry`,
      "POST",
      {},
      undefined,
      "retry",
    );
  if (kind === "integrationSyncSubscription")
    return mutation(
      vm,
      api,
      `/api/v1/subscriptions/${id}/sync`,
      "POST",
      {},
      undefined,
      "sync",
    );
  if (kind === "integrationInstallGithub")
    return mutation(
      vm,
      api,
      `/api/v1/integrations/github/${id}/install`,
      "POST",
      {},
      undefined,
      "install",
    );
  if (kind === "integrationRepositories")
    return query(
      vm,
      api,
      `/api/v1/registries/${id}/repositories`,
      "repositories",
    );
  if (kind === "integrationInstallations")
    return query(
      vm,
      api,
      `/api/v1/integrations/github/${id}/installations`,
      "installations",
    );
  if (kind === "integrationStorage")
    return query(vm, api, `/api/v1/registries/${id}/storage`, "storage");
  if (kind === "integrationRetention")
    return query(
      vm,
      api,
      `/api/v1/registries/${id}/retention-preview`,
      "retention",
    );
  if (kind === "integrationArtifact")
    return query(
      vm,
      api,
      `/api/v1/registries/${id}/artifact?repository=${encodeURIComponent(String(vm.repository || ""))}&reference=${encodeURIComponent(value)}`,
      "artifact",
      { repository: vm.repository, reference: value },
    );
  if (kind !== "integrationSubmit")
    throw Error("Unbekannte Integrationsaktion");
  const element = sourceElement(String(data.source)),
    submission = element.takeSubmission(String(data.submission)),
    v = submission.values as Values,
    op = submission.op;
  const target = str(v, "id"),
    revision = Number(v.revision || 0),
    reason = str(v, "reason"),
    confirmed = bool(v, "confirmed");
  switch (op) {
    case "saveRegistry": {
      const payload: RegistryRequest = {
        name: str(v, "name"),
        provider: str(v, "provider"),
        host: str(v, "host"),
        endpoint: str(v, "endpoint"),
        repositories: parts(str(v, "repositories")),
        authHosts: parts(str(v, "authHosts")),
        blobHosts: parts(str(v, "blobHosts")),
        caPEM: str(v, "caPEM"),
        privateNetwork: bool(v, "privateNetwork"),
        username: str(v, "username"),
        password: String(v.password || ""),
        removeCredential: bool(v, "removeCredential"),
        pushUsername: str(v, "pushUsername"),
        pushPassword: String(v.pushPassword || ""),
        removePushCredential: bool(v, "removePushCredential"),
        enabled: bool(v, "enabled"),
        revision,
        reason,
        confirmed,
      };
      return mutation(
        vm,
        api,
        "/api/v1/registries" + (target ? "/" + target : ""),
        target ? "PUT" : "POST",
        payload,
        element,
        "saveRegistry",
      );
    }
    case "saveGithub": {
      const payload: GitHubRequest = {
        name: str(v, "name"),
        appId: str(v, "appId"),
        privateKey: String(v.privateKey || ""),
        webhookSecret: String(v.webhookSecret || ""),
        installationId: str(v, "installationId"),
        enabled: bool(v, "enabled"),
        revision,
        reason,
        confirmed,
      };
      return mutation(
        vm,
        api,
        "/api/v1/integrations/github" + (target ? "/" + target : ""),
        target ? "PUT" : "POST",
        payload,
        element,
      );
    }
    case "startGithub":
      return mutation(
        vm,
        api,
        `/api/v1/integrations/github/${target}/setup`,
        "POST",
        { organization: str(v, "organization") },
        element,
        "setup",
      );
    case "browseTags":
      return query(
        vm,
        api,
        `/api/v1/registries/${str(v, "registryId")}/tags?repository=${encodeURIComponent(str(v, "repository"))}`,
        "tags",
        { repository: str(v, "repository") },
      );
    case "inspectArtifact":
      return query(
        vm,
        api,
        `/api/v1/registries/${str(v, "registryId")}/artifact?repository=${encodeURIComponent(str(v, "repository"))}&reference=${encodeURIComponent(str(v, "reference"))}`,
        "artifact",
        { repository: str(v, "repository"), reference: str(v, "reference") },
      );
    case "importArtifact":
      return mutation(
        vm,
        api,
        "/api/v1/import-jobs",
        "POST",
        {
          sourceRegistryId: str(v, "sourceRegistryId"),
          repository: str(v, "repository"),
          digest: str(v, "digest"),
          destinationRegistryId: str(v, "destinationRegistryId"),
          destinationRepository: str(v, "destinationRepository"),
          reason,
          confirmed,
        },
        element,
        "import",
      );
    case "loadGithubRepos":
      return query(
        vm,
        api,
        `/api/v1/integrations/github/${str(v, "connectionId")}/repositories`,
        "githubRepositories",
        { connectionId: str(v, "connectionId") },
      );
    case "loadGithubWorkflows": {
      const catalog = vm.githubCatalog as any,
        repository = str(v, "repository"),
        entry = (catalog.repositories || []).find(
          (r: any) => r.full_name === repository,
        );
      if (!entry)
        throw Error("Repository zuerst aus der freigegebenen Liste auswählen");
      return query(
        vm,
        api,
        `/api/v1/integrations/github/${str(v, "connectionId")}/workflows?repository=${encodeURIComponent(repository)}`,
        "githubWorkflows",
        { repository, repositoryId: String(entry.id) },
      );
    }
    case "saveSubscription": {
      const targets = [];
      for (
        let index = 0;
        index < 20 && v[`component${index}`] !== undefined;
        index++
      )
        targets.push({
          component: str(v, `component${index}`),
          containerId: str(v, `container${index}`),
          reference: str(v, `reference${index}`),
        });
      const old = (vm.subscriptions as Subscription[]).find(
        (s) => s.id === target,
      );
      const payload: Subscription = {
        id: target,
        name: str(v, "name"),
        connectionId: str(v, "connectionId"),
        repositoryId: str(v, "repositoryId"),
        repository: str(v, "repository"),
        workflowId: str(v, "workflowId"),
        branch: str(v, "branch"),
        channel: str(v, "channel"),
        registryId: str(v, "registryId"),
        importRegistryId: str(v, "importRegistryId"),
        importPrefix: str(v, "importPrefix"),
        targets,
        mode: str(v, "mode"),
        enabled: bool(v, "enabled"),
        actor: "",
        actorRole: "",
        revision,
        lastSequence: old?.lastSequence || 0,
        lastSync: old?.lastSync || "",
        lastError: "",
        createdAt: old?.createdAt || "",
        reason,
        confirmed,
      };
      return mutation(
        vm,
        api,
        "/api/v1/subscriptions" + (target ? "/" + target : ""),
        target ? "PUT" : "POST",
        payload,
        element,
      );
    }
    case "savePermissions": {
      const matrix = vm.permissionMatrix as any,
        roles = ["Viewer", "Operator", "Administrator", "Owner"].map(
          (role) => ({
            role,
            capabilities: matrix.capabilities
              .filter(
                (c: any) => role === "Owner" || bool(v, `${role}:${c.id}`),
              )
              .map((c: any) => String(c.id)),
          }),
        );
      const payload: PermissionPolicy = { revision, roles, reason };
      if (!confirmed) throw Error("Änderung der Berechtigungen bestätigen");
      return mutation(
        vm,
        api,
        "/api/v1/permission-policy",
        "PUT",
        payload,
        element,
      );
    }
    default:
      throw Error("Unbekanntes Integrationsformular");
  }
}
