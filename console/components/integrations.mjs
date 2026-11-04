import { t } from "../i18n/index.mjs";
import { Widget, h, icon, button, field, select, register } from "./base.mjs";
import "../vendor/xdrawer.mjs";

const list = (vm, key) => (Array.isArray(vm[key]) ? vm[key] : []);
const can = (vm, capability) =>
  !vm.demo &&
  (vm.user?.role === "Owner" || list(vm, "capabilities").includes(capability));
const checkbox = (label, name, checked = false, extra = {}) =>
  h(
    "label",
    { class: "checkbox" },
    h("input", { type: "checkbox", name, checked, ...extra }),
    label,
  );
const hidden = (name, value) =>
  h("input", { type: "hidden", name, value: value ?? "" });
const secret = (label, name, multiline = false) =>
  multiline
    ? h(
        "label",
        { class: "field" },
        h("span", {}, label),
        h("textarea", {
          name,
          rows: 5,
          maxlength: 16000,
          "data-sensitive": "true",
          autocomplete: "off",
          spellcheck: "false",
        }),
      )
    : field(label, name, "", "password", {
        maxlength: 4096,
        autocomplete: "new-password",
        "data-sensitive": "true",
      });
const note = (text) => h("p", { class: "callout small" }, text);
const empty = (text) => h("p", { class: "integration-empty" }, text);
const heading = (title, description, ...actions) =>
  h(
    "div",
    { class: "panel-heading" },
    h("div", {}, h("h2", {}, title), h("p", { class: "muted" }, description)),
    h("div", { class: "integration-actions" }, actions),
  );
const state = (value) =>
  h(
    "span",
    {
      class: `badge ${["ready", "processed", "succeeded"].includes(value) ? "good" : ["failed", "error", "revoked"].includes(value) ? "warning" : "blue"}`,
    },
    {
      ready: t("Bereit"),
      unchecked: t("Ungeprüft"),
      processed: t("Verarbeitet"),
      pending: t("Wartet"),
      processing: t("In Arbeit"),
      retry: t("Wiederholung geplant"),
      failed: t("Fehlgeschlagen"),
      error: t("Fehler"),
      revoked: t("Widerrufen"),
      installation_required: t("Installation auswählen"),
      partial: t("Teilweise aktualisiert · Eingriff erforderlich"),
      pending_approval: t("Wartet auf Freigabe"),
      succeeded: t("Erfolgreich"),
      ignored: t("Ignoriert"),
      queued: t("Eingeplant"),
    }[value] ||
      value ||
      t("Nicht eingerichtet"),
  );
const confirmation = (message) => [
  field(t("Änderungsgrund"), "reason", "", "text", {
    required: true,
    minlength: 3,
    maxlength: 500,
  }),
  checkbox(message, "confirmed", false, { required: true }),
];
const save = (vm, capability, label = t("Speichern")) =>
  h(
    "button",
    {
      type: "submit",
      class: "btn primary",
      disabled: !can(vm, capability) || !!vm.integrationBusy,
    },
    icon("check"),
    label,
  );
const registryOptions = (vm) =>
  list(vm, "registries").map((r) => [r.id, `${r.name} · ${r.host}`]);
const group = (...children) =>
  h("div", { class: "integration-grid" }, children);
const section = (title, ...children) =>
  h("section", { class: "integration-section" }, h("h3", {}, title), children);
const textRows = (rows) =>
  h(
    "dl",
    { class: "integration-facts" },
    rows.map(([label, value]) => [
      h("dt", {}, label),
      h("dd", {}, String(value || "–")),
    ]),
  );

// Secret-bearing forms stay inside this public custom-element boundary. The
// RMT event carries a one-use handle; neither its payload nor the RMT model
// contains password/key values. The AppService consumes and clears the form.
export class IntegrationWidget extends Widget {
  static get xtendComponentContract() {
    return {
      ...super.xtendComponentContract,
      methods: ["takeSubmission", "finishSubmission", "beginRegistration"],
    };
  }
  constructor() {
    super();
    this.submissions = new Map();
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    for (const item of this.submissions.values()) clearTimeout(item.timer);
    this.submissions.clear();
  }
  submit(form) {
    if (this.vm.demo || this.vm.integrationBusy || !form.reportValidity())
      return;
    const token = crypto.randomUUID(),
      values = Object.fromEntries(new FormData(form));
    for (const item of form.querySelectorAll('input[type="checkbox"]'))
      values[item.name] = item.checked;
    const timer = setTimeout(() => this.submissions.delete(token), 30000);
    this.submissions.set(token, { op: form.dataset.op, values, timer, form });
    this.emit("integrationSubmit", "", "", {
      source: this.localName,
      submission: token,
    });
  }
  takeSubmission(token) {
    const item = this.submissions.get(token);
    if (!item)
      throw Error(t("Formular ist abgelaufen. Bitte erneut absenden."));
    clearTimeout(item.timer);
    this.submissions.delete(token);
    for (const field of item.form.querySelectorAll("[data-sensitive]"))
      field.value = "";
    return { op: item.op, values: item.values };
  }
  finishSubmission() {
    this.update();
  }
  beginRegistration(data) {
    if (data.installationURL) {
      const url = new URL(data.installationURL);
      if (url.origin !== "https://github.com")
        throw Error(t("Ungültiges GitHub-Ziel"));
      location.assign(url.href);
      return;
    }
    const url = new URL(data.registrationURL);
    if (url.origin !== "https://github.com")
      throw Error(t("Ungültiges GitHub-Ziel"));
    const form = document.createElement("form");
    form.method = "POST";
    form.action = url.href;
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = "manifest";
    input.value = JSON.stringify(data.manifest);
    form.append(input);
    this.shadowRoot.append(form);
    form.submit();
    form.remove();
  }
  update() {
    if (this._lastPage && this._lastPage !== this.vm.page) {
      for (const item of this.submissions.values()) clearTimeout(item.timer);
      this.submissions.clear();
    }
    this._lastPage = this.vm.page;
    super.update();
  }
}

export class UniOCIRegistryList extends IntegrationWidget {
  render() {
    const vm = this.vm;
    return [
      heading(
        t("UniOCI Registries"),
        t(
          "Externe OCI-Registries und die integrierte Zot-Registry über einen gemeinsamen Vertrag verwalten.",
        ),
        button(
          t("Registry verbinden"),
          "integrationNewRegistry",
          "",
          "",
          "btn primary",
          "plus",
        ),
      ),
      note(
        t(
          "Die integrierte Registry wird lokal über tools/install.sh --with-registry bereitgestellt. Ein lokaler HTTP-Endpunkt ist ausschließlich für diesen PC und das isolierte Docker-Netz bestimmt; für externe CI ist ein eigener HTTPS-Ingress erforderlich.",
        ),
      ),
      list(vm, "registries").length
        ? h(
            "div",
            { class: "integration-cards" },
            list(vm, "registries").map((r) =>
              h(
                "article",
                { class: "integration-card", key: r.id },
                h(
                  "div",
                  { class: "panel-heading" },
                  h("h3", {}, r.name),
                  state(r.enabled ? r.status : t("Deaktiviert")),
                ),
                h("p", { class: "integration-code" }, r.host),
                h(
                  "p",
                  { class: "muted small" },
                  t("{v0} · Pull-Credentials {v1} · Push-Credentials {v2}", {
                    v0: r.provider.toUpperCase(),
                    v1: r.credentialConfigured ? t("hinterlegt") : t("anonym"),
                    v2: r.pushCredentialConfigured
                      ? t("hinterlegt")
                      : t("nicht hinterlegt"),
                  }),
                ),
                h("p", { class: "small" }, r.lastError || ""),
                h(
                  "div",
                  { class: "integration-actions" },
                  button(
                    t("Öffnen"),
                    "navigate",
                    `registries/${r.id}`,
                    "",
                    "btn",
                    "arrow-right",
                  ),
                  can(vm, "registry.scan") &&
                    button(
                      t("Prüfen"),
                      "integrationProbeRegistry",
                      "",
                      r.id,
                      "btn",
                      "refresh",
                    ),
                ),
              ),
            ),
          )
        : empty(t("Noch keine Registry verbunden.")),
    ];
  }
}
register("x-unioci-registry-list", UniOCIRegistryList);

export class UniOCIRegistrySettings extends IntegrationWidget {
  render() {
    const vm = this.vm,
      r =
        list(vm, "registries").find((entry) => entry.id === vm.registryId) ||
        {};
    if (!r.id && vm.registryEditor !== "new")
      return [
        empty(t("Registry nicht gefunden oder nicht zugänglich.")),
        button(t("Zur Übersicht"), "navigate", "registries"),
      ];
    return [
      heading(
        r.id ? r.name : t("Registry verbinden"),
        t(
          "Zugangsdaten werden nur schreibend übernommen. Leere Secret-Felder behalten den bisherigen Wert.",
        ),
        r.id &&
          button(
            t("Repositories"),
            "navigate",
            `registries/${r.id}/repositories`,
            "",
            "btn",
            "cube",
          ),
      ),
      h(
        "form",
        { "data-op": "saveRegistry", key: r.id || "new" },
        hidden("id", r.id),
        hidden("revision", r.revision || 0),
        group(
          field(t("Name"), "name", r.name || "", "text", {
            required: true,
            maxlength: 100,
          }),
          select(t("Provider"), "provider", r.provider || "oci", [
            ["oci", t("OCI Registry")],
            ["ghcr", t("GitHub Container Registry")],
            ["zot", t("Zot")],
          ]),
        ),
        group(
          field(t("Kanonischer Registry-Host"), "host", r.host || "", "text", {
            required: true,
            placeholder: "ghcr.io",
          }),
          field(t("API-Endpunkt"), "endpoint", r.endpoint || "", "url", {
            placeholder: "https://ghcr.io",
          }),
        ),
        field(
          t("Repository-Freigaben (eine pro Zeile oder mit Komma getrennt)"),
          "repositories",
          (r.repositories || []).join(", "),
          "text",
          { required: true, placeholder: "organisation/api, organisation/*" },
        ),
        note(
          t(
            "* gibt alle Repositories dieser Verbindung frei. Bevorzuge eng begrenzte Repository- oder Namespace-Freigaben. API-Endpunkt und kanonischer Docker-Host dürfen bei einer ausdrücklich konfigurierten internen Verbindung abweichen.",
          ),
        ),
        section(
          "Pull-Zugang",
          group(
            field(t("Benutzername"), "username", r.username || ""),
            secret(
              r.credentialConfigured
                ? t("Neues Pull-Passwort / Token (bereits hinterlegt)")
                : "Pull-Passwort / Token",
              "password",
            ),
          ),
          checkbox(
            t("Gespeicherte Pull-Credentials entfernen"),
            "removeCredential",
          ),
        ),
        section(
          t("Getrennter Push-Zugang für OCI-Importe"),
          group(
            field(t("Push-Benutzername"), "pushUsername", r.pushUsername || ""),
            secret(
              r.pushCredentialConfigured
                ? t("Neues Push-Passwort / Token (bereits hinterlegt)")
                : "Push-Passwort / Token",
              "pushPassword",
            ),
          ),
          checkbox(
            t("Gespeicherte Push-Credentials entfernen"),
            "removePushCredential",
          ),
        ),
        h(
          "details",
          {},
          h("summary", {}, t("Netzwerk und Zertifikate")),
          field(
            t("Erlaubte Auth-Realm-Hosts"),
            "authHosts",
            (r.authHosts || []).join(", "),
          ),
          field(
            t("Erlaubte Blob-/Download-Hosts"),
            "blobHosts",
            (r.blobHosts || []).join(", "),
          ),
          h(
            "label",
            { class: "field" },
            h("span", {}, t("Eigene CA (PEM, optional)")),
            h("textarea", {
              name: "caPEM",
              value: r.caPEM || "",
              rows: 4,
              maxlength: 32768,
            }),
          ),
          checkbox(
            t("Verbindung darf ausdrücklich private Netze erreichen"),
            "privateNetwork",
            r.privateNetwork,
          ),
          note(
            t(
              "Diese Freigabe erlaubt Netzwerkzugriff auf das angegebene Ziel. TLS wird bei externen Registries weiterhin geprüft; es gibt keinen Schalter zum Abschalten der Zertifikatsprüfung.",
            ),
          ),
        ),
        checkbox(t("Verbindung aktiv"), "enabled", r.enabled ?? true),
        confirmation(
          t(
            "Ich bestätige Ziel, Repository-Freigaben und den Umgang mit Zugangsdaten.",
          ),
        ),
        save(vm, "registry.manage"),
      ),
      r.id &&
        section(
          t(
            "Unterstützte Aktionen (Verfügbarkeit wird bei der Abfrage geprüft)",
          ),
          h("p", {}, (r.capabilities || []).join(" · ")),
          h(
            "div",
            { class: "integration-actions" },
            can(vm, "registry.scan") &&
              button(
                t("Verbindung prüfen"),
                "integrationProbeRegistry",
                "",
                r.id,
                "btn",
                "refresh",
              ),
            r.provider === "zot" &&
              button(
                t("Speicherinformationen"),
                "integrationStorage",
                "",
                r.id,
              ),
            r.provider === "zot" &&
              button(t("Retention-Vorschau"), "integrationRetention", "", r.id),
          ),
          vm.registryStorage &&
            h(
              "pre",
              { class: "integration-json" },
              JSON.stringify(vm.registryStorage, null, 2),
            ),
          vm.retentionPreview &&
            note(
              t(
                "Automatische Löschung: deaktiviert. {v0} geschützte Digests. Externe Registry-Verbraucher müssen gesondert berücksichtigt werden.",
                {
                  v0: Object.keys(vm.retentionPreview.protectedDigests || {})
                    .length,
                },
              ),
            ),
        ),
    ];
  }
}
register("x-unioci-registry-settings", UniOCIRegistrySettings);

export class UniOCIRepositoryBrowser extends IntegrationWidget {
  render() {
    const vm = this.vm,
      r = list(vm, "registries").find((entry) => entry.id === vm.registryId);
    if (!r) return [empty(t("Registry nicht gefunden oder nicht zugänglich."))];
    const repos = list(vm, "registryRepositories"),
      tags = list(vm, "registryTags");
    return [
      heading(
        t("Repositories und Artefakte"),
        r.name,
        button(
          t("Repositories laden"),
          "integrationRepositories",
          "",
          r.id,
          "btn",
          "refresh",
        ),
      ),
      vm.integrationQueryError && note(vm.integrationQueryError),
      vm.integrationQueryBusy &&
        h("p", { role: "status" }, t("Registry wird abgefragt …")),
      h(
        "form",
        { "data-op": "browseTags" },
        hidden("registryId", r.id),
        field(t("Repository"), "repository", vm.repository || "", "text", {
          required: true,
          list: "unioci-repositories",
          placeholder: "organisation/api",
        }),
        h(
          "datalist",
          { id: "unioci-repositories" },
          repos.map((repo) => h("option", { value: repo })),
        ),
        h(
          "button",
          { type: "submit", class: "btn" },
          icon("search"),
          t("Tags laden"),
        ),
      ),
      h(
        "form",
        { "data-op": "inspectArtifact" },
        hidden("registryId", r.id),
        field(t("Repository"), "repository", vm.repository || "", "text", {
          required: true,
        }),
        field(
          t("Tag oder Digest"),
          "reference",
          vm.artifactReference || "latest",
          "text",
          { required: true, list: "unioci-tags" },
        ),
        h(
          "datalist",
          { id: "unioci-tags" },
          tags.map((tag) => h("option", { value: tag })),
        ),
        h(
          "button",
          { type: "submit", class: "btn primary" },
          t("Artefakt öffnen"),
        ),
      ),
      tags.length
        ? h(
            "div",
            { class: "integration-tag-list" },
            tags
              .slice(0, 200)
              .map((tag) =>
                button(tag, "integrationArtifact", tag, r.id, "btn small"),
              ),
          )
        : empty(
            t(
              "Noch keine Tags geladen. Ein bekannter Digest kann direkt geprüft werden.",
            ),
          ),
      section(
        "OCI-Import",
        note(
          t(
            "Ein Import schreibt dieselben OCI-Inhalte per Digest in die Ziel-Registry. Referrers werden mit übertragen. Ein Container-Update wird dadurch nicht automatisch freigegeben.",
          ),
        ),
        h(
          "form",
          { "data-op": "importArtifact" },
          hidden("sourceRegistryId", r.id),
          field(
            t("Quell-Repository"),
            "repository",
            vm.repository || "",
            "text",
            {
              required: true,
            },
          ),
          field(
            t("Image-Digest"),
            "digest",
            vm.artifact?.artifact?.digest || "",
            "text",
            { required: true, pattern: "sha256:[a-f0-9]{64}" },
          ),
          select(t("Ziel-Registry"), "destinationRegistryId", "", [
            ["", t("Bitte auswählen")],
            ...registryOptions(vm),
          ]),
          field(t("Ziel-Repository"), "destinationRepository", "", "text", {
            required: true,
          }),
          confirmation(
            t("Ich bestätige den Schreibzugriff auf die Ziel-Registry."),
          ),
          save(vm, "registry.import", t("Import einplanen")),
        ),
      ),
      section(
        t("Letzte Importe"),
        list(vm, "importJobs").length
          ? h(
              "div",
              { class: "integration-cards" },
              list(vm, "importJobs")
                .slice(-20)
                .map((job) =>
                  h(
                    "article",
                    { class: "integration-card", key: job.id },
                    state(job.state),
                    h(
                      "p",
                      { class: "integration-code" },
                      `${job.repository} → ${job.destinationRepository}`,
                    ),
                    h("p", {}, job.error || ""),
                  ),
                ),
            )
          : empty(t("Noch keine Importe.")),
      ),
    ];
  }
}
register("x-unioci-repository-browser", UniOCIRepositoryBrowser);

export class UniOCIArtifactDetail extends IntegrationWidget {
  connectedCallback() {
    super.connectedCallback();
    this.shadowRoot.addEventListener(
      "drawer-closed",
      () => {
        if (this.vm.artifactOpen) this.emit("integrationCloseArtifact");
      },
      { signal: this.controller.signal },
    );
  }
  render() {
    const result = this.vm.artifact || {},
      artifact = result.artifact || {};
    return [
      h(
        "x-drawer",
        {
          placement: "right",
          modal: true,
          label: t("OCI-Artefakt"),
          open: !!this.vm.artifactOpen,
          "data-theme": this.vm.theme,
        },
        h("strong", { slot: "header" }, t("OCI-Artefakt")),
        h(
          "div",
          { class: "integration-drawer" },
          textRows([
            [t("Repository"), artifact.reference],
            [t("Digest"), artifact.digest],
            [t("Konfiguration"), artifact.configDigest],
            [t("Medientyp"), artifact.mediaType],
            [
              t("Manifestgröße"),
              artifact.size ? t("{v0} Bytes", { v0: artifact.size }) : "–",
            ],
            [t("Plattformen"), (artifact.platforms || []).join(", ")],
          ]),
          note(
            t(
              "Der Inhalt wurde anhand seines Digests abgeglichen. Eine kryptografische Herkunfts- oder Signaturverifikation ist damit nicht belegt.",
            ),
          ),
          h("h3", {}, t("Referenzartefakte")),
          result.referrersAvailable === false
            ? empty(
                t(
                  "Der Provider liefert aktuell keine zugängliche Referrers-Liste.",
                ),
              )
            : h(
                "ul",
                {},
                (artifact.referrers || []).map((ref) =>
                  h(
                    "li",
                    { class: "integration-code" },
                    `${ref.artifactType || ref.mediaType}: ${ref.digest}`,
                  ),
                ),
              ),
        ),
      ),
    ];
  }
}
register("x-unioci-artifact-detail", UniOCIArtifactDetail);

export class CUOGitHubConnection extends IntegrationWidget {
  render() {
    const vm = this.vm,
      selected =
        list(vm, "githubConnections").find((c) => c.id === vm.githubEditorId) ||
        {},
      installations = list(vm, "githubInstallations");
    return [
      heading(
        t("GitHub verbinden"),
        t(
          "Eigene GitHub-App, ausgewählte Repositories und erfolgreiche Publish-Workflows.",
        ),
        button(
          t("Neue Verbindung"),
          "integrationNewGithub",
          "",
          "",
          "btn primary",
          "plus",
        ),
      ),
      note(
        t(
          "Die GitHub-App dient dem API-Zugriff und den Webhooks. Für private GHCR-Pulls wird zusätzlich eine Registry-Verbindung mit PAT classic und read:packages benötigt. CUOs Benutzeranmeldung bleibt davon unabhängig.",
        ),
      ),
      h(
        "div",
        { class: "integration-cards" },
        list(vm, "githubConnections").map((c) =>
          h(
            "article",
            { class: "integration-card", key: c.id },
            h(
              "div",
              { class: "panel-heading" },
              h("h3", {}, c.name),
              state(c.status),
            ),
            textRows([
              [t("App"), c.appId],
              [t("Account"), c.account],
              [t("Installation"), c.installationId],
            ]),
            h("p", { class: "small" }, c.lastError || ""),
            h(
              "div",
              { class: "integration-actions" },
              button(t("Bearbeiten"), "integrationEditGithub", "", c.id),
              button(
                t("Zustellungen"),
                "navigate",
                `integrations/github/${c.id}/deliveries`,
              ),
              c.configured &&
                button(t("Prüfen"), "integrationProbeGithub", "", c.id),
            ),
            !c.configured &&
              h(
                "form",
                { "data-op": "startGithub" },
                hidden("id", c.id),
                field(
                  t("Organisation (leer für persönlichen Account)"),
                  "organization",
                  "",
                ),
                h(
                  "button",
                  {
                    type: "submit",
                    class: "btn primary",
                    disabled: !can(vm, "github.manage"),
                  },
                  t("GitHub-App anlegen"),
                ),
              ),
            c.configured &&
              button(
                t("Auf GitHub installieren"),
                "integrationInstallGithub",
                "",
                c.id,
                "btn primary",
              ),
            h(
              "p",
              { class: "integration-code small" },
              `Webhook: ${c.webhookURL}`,
            ),
            h(
              "p",
              { class: "integration-code small" },
              `Callback: ${c.callbackURL}`,
            ),
            !c.webhookReachable &&
              note(
                t(
                  "Diese Instanz ist nur lokal erreichbar. Webhooks benötigen einen öffentlichen HTTPS-Eingang; der ausgehende Polling-Abgleich funktioniert auch ohne ihn.",
                ),
              ),
          ),
        ),
      ),
      h(
        "form",
        { "data-op": "saveGithub", key: selected.id || "new" },
        h(
          "h3",
          {},
          selected.id ? t("Verbindung bearbeiten") : t("Verbindung anlegen"),
        ),
        hidden("id", selected.id),
        hidden("revision", selected.revision || 0),
        field(t("Name"), "name", selected.name || "", "text", {
          required: true,
          maxlength: 100,
        }),
        h(
          "details",
          { open: !!selected.configured },
          h("summary", {}, t("Vorhandene App / manuelle Einrichtung")),
          field(t("App-ID"), "appId", selected.appId || "", "text", {
            inputmode: "numeric",
          }),
          secret(
            t("Privater RSA-App-Schlüssel (PEM; leer behält den bisherigen)"),
            "privateKey",
            true,
          ),
          secret(
            t(
              "Webhook-Secret (mindestens 32 Zeichen; bei Schlüsselwechsel ebenfalls angeben)",
            ),
            "webhookSecret",
          ),
        ),
        group(
          field(
            t("Installation-ID"),
            "installationId",
            selected.installationId || "",
            "text",
            { list: "github-installations" },
          ),
          h(
            "datalist",
            { id: "github-installations" },
            installations.map((item) =>
              h(
                "option",
                { value: String(item.id) },
                item.account?.login || "",
              ),
            ),
          ),
        ),
        selected.configured &&
          button(
            t("Installationen laden"),
            "integrationInstallations",
            "",
            selected.id,
          ),
        checkbox(t("Verbindung aktiv"), "enabled", !!selected.enabled),
        confirmation(
          t(
            "Ich bestätige App, Installation und die angezeigten Zugriffsrechte.",
          ),
        ),
        save(vm, "github.manage"),
      ),
    ];
  }
}
register("x-cuo-github-connection", CUOGitHubConnection);

export class CUOWebhookInbox extends IntegrationWidget {
  render() {
    const vm = this.vm,
      rows = list(vm, "webhookDeliveries")
        .filter((d) => !vm.githubId || d.connectionId === vm.githubId)
        .slice()
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return [
      heading(
        t("GitHub Notification Inbox"),
        t("Dauerhafte Zustellungen und ihr Verarbeitungsstatus."),
        button(t("GitHub-Verbindungen"), "navigate", "integrations/github"),
      ),
      note(
        t(
          "Wiederaufnahme verarbeitet das bereits signierte Ereignis unter den aktuellen Freigaben und Richtlinien. Die ursprüngliche Zustellungs-ID verhindert doppelte Seiteneffekte.",
        ),
      ),
      rows.length
        ? h(
            "div",
            { class: "table-scroll" },
            h(
              "table",
              {},
              h(
                "thead",
                {},
                h(
                  "tr",
                  {},
                  [
                    t("Ereignis"),
                    t("Status"),
                    t("Versuche"),
                    t("Eingang"),
                    t("Ergebnis"),
                    t("Aktion"),
                  ].map((label) => h("th", {}, label)),
                ),
              ),
              h(
                "tbody",
                {},
                rows
                  .slice(0, 100)
                  .map((d) =>
                    h(
                      "tr",
                      { key: d.id },
                      h(
                        "td",
                        {},
                        d.event,
                        h("small", { class: "muted" }, d.action),
                      ),
                      h("td", {}, state(d.state)),
                      h("td", {}, d.attempts),
                      h(
                        "td",
                        {},
                        new Date(d.createdAt).toLocaleString("de-DE"),
                      ),
                      h(
                        "td",
                        { class: "integration-wrap" },
                        d.error || d.deliveryId,
                      ),
                      h(
                        "td",
                        {},
                        can(vm, "webhook.retry") &&
                          ["failed", "retry"].includes(d.state) &&
                          button(
                            t("Wiederaufnehmen"),
                            "integrationRetryDelivery",
                            "",
                            d.id,
                          ),
                      ),
                    ),
                  ),
              ),
            ),
          )
        : empty(
            t(
              "Noch keine Zustellungen. Lokal kann der periodische API-Abgleich ohne öffentlichen Webhook-Eingang genutzt werden.",
            ),
          ),

      section(
        "Release-Sets",
        list(vm, "releaseSets").length
          ? h(
              "div",
              { class: "integration-cards" },
              list(vm, "releaseSets")
                .slice(-20)
                .map((set) =>
                  h(
                    "article",
                    { class: "integration-card", key: set.id },
                    h("h3", {}, set.manifest.version),
                    state(set.state),
                    h(
                      "p",
                      {},
                      t("{v0} Images · {v1}", {
                        v0: set.manifest.images.length,
                        v1: set.manifest.channel,
                      }),
                    ),
                    h(
                      "p",
                      { class: "integration-code small" },
                      set.manifest.source.revision,
                    ),
                    h("p", {}, set.error || ""),
                  ),
                ),
            )
          : empty(t("Noch kein vollständiges Release-Set angenommen.")),
      ),
    ];
  }
}
register("x-cuo-webhook-inbox", CUOWebhookInbox);

export class CUOReleaseSubscriptions extends IntegrationWidget {
  render() {
    const vm = this.vm,
      current =
        list(vm, "subscriptions").find(
          (entry) => entry.id === vm.subscriptionEditorId,
        ) || {},
      catalog = vm.githubCatalog || {},
      connectionId = current.connectionId || catalog.connectionId || "",
      targets =
        current.targets ||
        Array.from({ length: vm.subscriptionTargetCount || 1 }, () => ({})),
      registries = registryOptions(vm);
    return [
      heading(
        t("Release-Subscriptions"),
        t("Repository und Publish-Workflow mit deinen Containern verbinden."),
        button(
          t("Neue Subscription"),
          "integrationNewSubscription",
          "",
          "",
          "btn primary",
          "plus",
        ),
      ),
      h(
        "div",
        { class: "integration-cards" },
        list(vm, "subscriptions").map((sub) =>
          h(
            "article",
            { class: "integration-card", key: sub.id },
            h("h3", {}, sub.name),
            h("p", {}, `${sub.repository} · ${sub.channel} · ${sub.mode}`),
            h(
              "p",
              { class: "small" },
              sub.lastError || (sub.enabled ? t("Aktiv") : t("Deaktiviert")),
            ),
            h(
              "div",
              { class: "integration-actions" },
              button(
                t("Bearbeiten"),
                "integrationEditSubscription",
                "",
                sub.id,
              ),
              can(vm, "subscriptions.manage") &&
                button(
                  t("Jetzt abgleichen"),
                  "integrationSyncSubscription",
                  "",
                  sub.id,
                  "btn",
                  "refresh",
                ),
            ),
          ),
        ),
      ),
      section(
        t("GitHub-Quelle auswählen"),
        h(
          "form",
          { "data-op": "loadGithubRepos" },
          select(t("GitHub-Verbindung"), "connectionId", connectionId, [
            ["", t("Bitte auswählen")],
            ...list(vm, "githubConnections").map((c) => [c.id, c.name]),
          ]),
          h(
            "button",
            { type: "submit", class: "btn" },
            t("Repositories laden"),
          ),
        ),
        h(
          "form",
          { "data-op": "loadGithubWorkflows" },
          hidden("connectionId", catalog.connectionId || connectionId),
          select(t("Repository"), "repository", catalog.repository || "", [
            ["", t("Bitte auswählen")],
            ...(catalog.repositories || []).map((r) => [
              r.full_name,
              r.full_name,
            ]),
          ]),
          h("button", { type: "submit", class: "btn" }, t("Workflows laden")),
        ),
      ),
      vm.integrationQueryBusy &&
        h("p", { role: "status" }, t("GitHub wird abgefragt …")),
      vm.integrationQueryError && note(vm.integrationQueryError),
      h(
        "form",
        { "data-op": "saveSubscription", key: current.id || "new" },
        hidden("id", current.id),
        hidden("revision", current.revision || 0),
        hidden(
          "connectionId",
          current.connectionId || catalog.connectionId || "",
        ),
        hidden(
          "repositoryId",
          current.repositoryId || catalog.repositoryId || "",
        ),
        hidden("repository", current.repository || catalog.repository || ""),
        field(t("Name"), "name", current.name || "", "text", {
          required: true,
          maxlength: 100,
        }),
        h(
          "p",
          { class: "muted" },
          t("Quelle: {v0}", {
            v0:
              current.repository ||
              catalog.repository ||
              t("Bitte zuerst ein Repository auswählen"),
          }),
        ),
        select(t("Publish-Workflow"), "workflowId", current.workflowId || "", [
          ["", t("Bitte auswählen")],
          ...(catalog.workflows || []).map((w) => [
            String(w.id),
            `${w.name} · ${w.path}`,
          ]),
          ...(current.workflowId &&
          !(catalog.workflows || []).some(
            (w) => String(w.id) === current.workflowId,
          )
            ? [[current.workflowId, current.workflowId]]
            : []),
        ]),
        group(
          field(
            t("Erlaubter Branch / Tag-Muster"),
            "branch",
            current.branch || "main",
            "text",
            { required: true },
          ),
          field(
            t("Release-Kanal"),
            "channel",
            current.channel || "stable",
            "text",
            { required: true },
          ),
        ),
        select(t("Quell-Registry"), "registryId", current.registryId || "", [
          ["", t("Bitte auswählen")],
          ...registries,
        ]),
        targets.map((target, index) =>
          h(
            "fieldset",
            { class: "integration-section", key: index },
            h("legend", {}, t("Komponente {v0}", { v0: index + 1 })),
            field(
              t("Komponentenname im Release-Set"),
              `component${index}`,
              target.component || "",
              "text",
              { required: true },
            ),
            select(
              t("Ziel-Container"),
              `container${index}`,
              target.containerId || "",
              [
                ["", t("Bitte auswählen")],
                ...list(vm, "containers")
                  .filter((c) => c.managed)
                  .map((c) => [c.id, c.name]),
              ],
            ),
            field(
              t("Erwartetes Image-Repository"),
              `reference${index}`,
              target.reference || "",
              "text",
              { required: true, placeholder: "ghcr.io/organisation/api" },
            ),
          ),
        ),
        targets.length < 20 &&
          !current.id &&
          button(
            t("Komponente hinzufügen"),
            "integrationAddTarget",
            "",
            "",
            "btn",
            "plus",
          ),
        group(
          select(
            t("Optional vorab nach Zot importieren"),
            "importRegistryId",
            current.importRegistryId || "",
            [
              ["", t("Direkt aus Quell-Registry beziehen")],
              ...list(vm, "registries")
                .filter(
                  (r) => r.provider === "zot" && r.pushCredentialConfigured,
                )
                .map((r) => [r.id, r.name]),
            ],
          ),
          field(
            t("Zot-Import-Namespace"),
            "importPrefix",
            current.importPrefix || "releases",
          ),
        ),
        select(t("Verarbeitung"), "mode", current.mode || "preview", [
          ["preview", t("Vorschau: nur Kandidaten")],
          ["approval", t("Update-Freigabe anfordern")],
          ["automatic", t("Automatisch gemäß Container-Richtlinien")],
        ]),
        checkbox(t("Subscription aktiv"), "enabled", !!current.enabled),
        note(
          t(
            "Neue Subscriptions starten ab ihrer Einrichtung. Frühere Releases werden nicht automatisch ausgerollt. Vollständige Image-Sets werden geprüft; mehrere Container werden nacheinander aktualisiert. Bei einem Fehler hält die Folge an. Anwendungsdaten werden nicht automatisch zurückgesetzt.",
          ),
        ),
        confirmation(
          t(
            "Ich bestätige Quellen, Container-Zuordnung und den gewählten Automationsmodus.",
          ),
        ),
        save(vm, "subscriptions.manage"),
      ),
    ];
  }
}
register("x-cuo-release-subscriptions", CUOReleaseSubscriptions);

export class CUOPermissionMatrix extends IntegrationWidget {
  render() {
    const vm = this.vm,
      data = vm.permissionMatrix;
    if (!can(vm, "roles.manage"))
      return [empty(t("Nur ein Owner darf Rollenberechtigungen verwalten."))];
    if (!data?.policy) return [empty(t("Berechtigungsmatrix wird geladen …"))];
    const roles = ["Viewer", "Operator", "Administrator", "Owner"];
    const header = h(
      "thead",
      {},
      h(
        "tr",
        {},
        h("th", { scope: "col" }, t("Aktion")),
        roles.map((role) => h("th", { scope: "col" }, role)),
      ),
    );
    const rows = (data.capabilities || []).map((cap) => {
      const cells = roles.map((role) =>
        h(
          "td",
          {},
          h("input", {
            type: "checkbox",
            name: `${role}:${cap.id}`,
            "aria-label": `${role}: ${t(cap.label)}`,
            checked:
              role === "Owner" ||
              !!data.policy.roles
                .find((entry) => entry.role === role)
                ?.capabilities.includes(cap.id),
            disabled: role === "Owner" || cap.ownerOnly || !!vm.integrationBusy,
          }),
        ),
      );
      return h(
        "tr",
        { key: cap.id },
        h(
          "th",
          { scope: "row" },
          t(cap.label),
          t(cap.description || "") &&
            h("small", { class: "muted" }, t(cap.description || "")),
        ),
        cells,
      );
    });
    const table = h(
      "div",
      { class: "table-scroll" },
      h(
        "table",
        { class: "permission-matrix" },
        h("caption", { class: "sr-only" }, t("Fähigkeiten nach Benutzerrolle")),
        header,
        h("tbody", {}, rows),
      ),
    );
    return [
      heading(
        t("Rollenberechtigungen"),
        t(
          "Aktionsrechte und zusätzliche Ausführungsfreigaben getrennt verwalten.",
        ),
      ),
      note(
        t(
          "Die Matrix wird im Backend durchgesetzt. Host-/Container-Grenzen und Ausführungsprüfungen gelten zusätzlich. Die Owner-Verwaltung bleibt geschützt; eine Checkbox erteilt keinen allgemeinen Shell- oder Docker-Zugriff.",
        ),
      ),
      h(
        "form",
        { "data-op": "savePermissions", key: data.policy.revision },
        hidden("revision", data.policy.revision),
        table,
        confirmation(
          t("Ich bestätige die Änderungen der wirksamen Rollenrechte."),
        ),
        save(vm, "roles.manage", t("Berechtigungen speichern")),
      ),
    ];
  }
}
register("x-cuo-permission-matrix", CUOPermissionMatrix);
