# CUO

CUO ist ein lokal installierbarer **Container Update Orchestrator** mit eigenständigem Go-Core und einer XTend Maraca / RMT-Konsole nach der mitgelieferten Designreferenz. Version **0.1.0** ist ein lokales MVP für einen Docker-Host. Quellcode: [konnilabs/cuo](https://github.com/konnilabs/cuo). Es werden keine Images automatisch veröffentlicht.

## Installation

Voraussetzungen: Linux mit Docker Engine **29.x**, Docker Compose **v2 oder v5**, Internetzugang beim ersten Build. Verifiziert mit Docker 29.1.3 / API 1.52. Weitere Versionen und Docker Desktop sind noch nicht zertifiziert.

```sh
./tools/install.sh
```

Danach **http://127.0.0.1:8095** öffnen und den ersten Owner mit einem Passwort ab zwölf Zeichen anlegen. Es gibt keine voreingestellten Zugangsdaten. Eine vom Live-System getrennte, schreibgeschützte Design-Demo steht unter **http://127.0.0.1:8095/?demo=1** bereit. Die Demo verwendet illustrative Daten der Vorlage; ihr Kalendertitel ist ebenfalls eine Abbildung der Vorlage.

Das Installationsskript erzeugt zwei zufällige interne Dienstschlüssel in `.env` mit Dateirechten 0600. Diese Datei gehört nicht in Git. Nur der Console-Port ist an Loopback veröffentlicht. Core und Agent sind ausschließlich über interne Docker-Netze erreichbar.

```sh
docker compose ps
docker compose logs --tail=100
docker compose stop
docker compose up -d
```

Bei abweichendem Port `CUO_PORT` **und** `CUO_ORIGIN` in `.env` anpassen. Für Zugriff von anderen Rechnern einen TLS-Reverse-Proxy verwenden und `CUO_ORIGIN=https://cuo.example.org` setzen. Der BFF verweigert einen unverschlüsselten Origin außerhalb von Loopback. Der Proxy muss den Origin erhalten und SSE ohne Pufferung weiterleiten. Eine optionale Caddy-Vorlage liegt in `deploy/Caddyfile.example`.

## Anmeldung und persönliche Einstellungen

Unter **Integrationen → OpenID Connect** kann der Owner einen OIDC-Provider konfigurieren. Im Provider einen Web-Client für **Authorization Code Flow mit PKCE (S256)** anlegen und die in CUO angezeigte **Redirect-URI** exakt übernehmen, lokal normalerweise `http://127.0.0.1:8095/auth/oidc/callback`. Bei einem Reverse-Proxy zählt der öffentliche `CUO_ORIGIN`.

Issuer, optionale abweichende Discovery-URL, Client-ID, Client-Secret, Scopes und Client-Authentifizierung sind konfigurierbar. Den Provider-Client für signierte RS256-ID-Tokens mit JWKS konfigurieren. Eine abweichende Discovery-URL wird als exakte Dokument-URL verwendet und muss keinen `.well-known`-Pfad enthalten. Unterstützt sind `client_secret_post`, `client_secret_basic` und öffentliche PKCE-Clients. Die Issuer-URL muss exakt dem Discovery-Dokument entsprechen, einschließlich eines eventuellen Pfades oder abschließenden Schrägstrichs. Provider-Endpunkte benötigen HTTPS mit vertrauenswürdiger Zertifikatskette. Keine Zertifikatsprüfung wird abgeschaltet.

**Speichern und Verbindung prüfen** prüft bei aktivierter Anmeldung die Discovery und speichert das Secret ausschließlich im serverseitigen Identity-Volume. Ein leeres Secret-Feld behält den bisherigen Wert; zum Entfernen gibt es eine eigene Checkbox. Bei aktivierter automatischer Benutzeranlage darf jeder vom Provider zugelassene Benutzer mit der gewählten Rolle auf den lokalen Host zugreifen; Standard ist **Viewer**. Die Zugangsbegrenzung erfolgt im Provider. Bestehende CUO-Rollen bleiben erhalten. Konten werden über Issuer und Subject identifiziert, niemals anhand gleicher E-Mail-Adressen mit lokalen Konten verknüpft. Die lokale Anmeldung bleibt als unabhängiger Zugang verfügbar. **Abmelden** beendet CUO-Sitzungen, nicht die Sitzung beim Provider.

Das Benutzermenü öffnet rechts den XTend-Profil-Drawer: Anzeigename, lokales Profil-Icon, Farbschema und Update-Benachrichtigungen lassen sich speichern. Der lokale Loginname bleibt erhalten. Unter **Workspace-Einstellungen → Darstellung** schaltet XToggle zwischen hell und dunkel. **Automatisch** übernimmt die Systemeinstellung und reagiert auch auf spätere Änderungen. Profilpräferenzen gelten pro Benutzer.

Erfolgsmeldungen und Fehler erscheinen als echte **XToasts** rechts oben. Die RMT-gesteuerte Toast-Ebene nutzt die oberste Browser-Ebene und `z-index: 2147483647`, sodass sie über dem Profil-Drawer liegt. Toasts lassen sich schließen und verschwinden nach fünf Sekunden (Fehler nach neun Sekunden) automatisch.

Die Glocke öffnet das Notification Center mit verfügbaren Updates, Freigaben und Ergebnissen der Update-Läufe. Meldungen lassen sich einzeln oder gemeinsam ausblenden. Das wird pro Benutzer gespeichert; ein neuer Image-Digest oder ein neuer Job-Status erzeugt eine neue Meldung. Die Löschung einer Meldung verändert keinen Container und keinen Audit-Eintrag. SPA-Ansichten haben mit XRouter eigene Hash-URLs, beispielsweise `/#/containers`; Zurück/Vorwärts und Neuladen bleiben nutzbar. Die Design-Demo speichert persönliche Darstellungspräferenzen ausschließlich lokal im Browser. Die Logs-Ansicht füllt die Kartenhöhe mit dem Terminal und zeigt bis zu 200 Einträge mit internem Scrollbereich; das Dashboard behält die kompakte Vorschau.

## Container verwalten

CUO entdeckt vorhandene Container. Die globale Standardrichtlinie lautet **Nur prüfen**. Zur Ausführung sind zwei ausdrückliche Freigaben notwendig:

1. Der Container trägt das Label `cuo.managed=true`.
2. Eine passende Richtlinie erlaubt `automatic` oder `approval-required`.

```yaml
services:
  app:
    image: nginx:stable
    labels:
      cuo.managed: "true"
```

Unter **Jetzt prüfen** startet ein Registry-Scan. Er löst einen Multi-Arch-Index auf die tatsächliche OS-/Architektur-/Variant-Plattform auf und vergleicht den Image-Konfigurationsdigest mit dem laufenden Image. Ausgeführt wird ausschließlich ein bestätigter, unveränderlicher Plattform-Digest. Getestete anonyme Registries sind Docker Hub; GHCR und Quay sind ebenfalls allowlisted. Weitere HTTPS-Registry-Hosts müssen in `CUO_REGISTRIES` ausdrücklich erlaubt werden. Private Registry-Zugangsdaten sind in diesem MVP noch nicht implementiert.

Ein Scan prüft Image-Inhalte; er führt keine automatische Versionsmigration auf einen anderen Tag aus. Ein gepinnter Digest bleibt bewusst unveränderlich. Scannerfehler erscheinen als Fehlerstatus und werden nicht als „aktuell“ ausgegeben.

Die Policy-Reihenfolge ist global → Host → Gruppe → Container. Ein übergeordneter Ausschluss bleibt wirksam. Automatische Ausführung und Wartungsfenster laufen im Core, auch wenn kein Browser geöffnet ist. Der Core prüft standardmäßig alle sechs Stunden erneut (`CUO_SCAN_INTERVAL=6h`). Die lokale Ausführung ist absichtlich seriell; der UI-Editor setzt Parallelität auf eins.

Für einen manuellen Lauf den Container auswählen, Unterbrechung bestätigen und einen Grund angeben. Eine Richtlinie mit manueller Freigabe erzeugt zunächst einen Job für einen Administrator oder Owner. Viewer lesen nur; Operator dürfen prüfen und Jobs anlegen. Rollen werden im Core geprüft, nicht nur im Browser.

## Compose-Projekte registrieren

CUO aktualisiert Compose-Services durch **Docker Compose**, nicht durch eine verdeckte Neuerstellung außerhalb des Projekts. Nicht registrierte Compose-Projekte werden vor der Veränderung abgewiesen.

1. `CUO_PROJECTS_DIR` in `.env` auf das absolute Stammverzeichnis vertrauenswürdiger Compose-Projekte setzen. Es wird im Agent unter `/projects` schreibgeschützt eingebunden.
2. Dem Service zusätzlich `cuo.compose.file` mit dem relativen Pfad der Compose-Datei in diesem Stammverzeichnis geben, etwa `nextcloud/compose.yaml`.
3. Projekt mit seinen normalen Quellen erstellen und CUO-Inventar aktualisieren.

Der Agent lässt Compose die Quellen, `.env`, `env_file` und relativen Pfade auflösen. Er bewahrt Image-Pins anderer bereits verwalteter Services und schreibt den vollständigen gewünschten Zustand nach `/data/compose-locks/<projekt>.json`. Nur der ausgewählte Service wird mit `up -d --no-deps --no-build --pull never` abgeglichen. Bind-Mount-Pfade werden auf das originale Host-Projektverzeichnis zurückgeführt. Ein Service muss genau eine Replica haben.

**Der gespeicherte CUO-Sollzustand ist während der Verwaltung maßgeblich.** Ein späteres externes `docker compose up` nur mit der ursprünglichen, ungepinnten Quelldatei könnte einen Pin überschreiben. Für externe Abgleiche zuerst den CUO-Sollzustand exportieren und verwenden, oder den Service in CUO deaktivieren und die Verwaltung ausdrücklich zurückgeben. Direkte Dateimanipulation auf dem Host führt CUO nicht aus.

Host-privilegierte Container, AutoRemove, Host-Netzwerke, Docker-Socket-Mounts und gemeinsame Container-Netzwerkräume werden nicht automatisch erneuert. CUO-Systemdienste sind immer ausgeschlossen. Der Host-Agent besitzt durch den Socket trotzdem weitreichende Host-Rechte; seine interne, authentifizierte API ist eine eingeschränkte Ausführungsgrenze und keine vollständige Betriebssystem-Sandbox.

## Jobs, Wiederanlauf und Daten

Jobs durchlaufen Freigabe / Planung → Warteschlange → Vorprüfung → Pull → Neuerstellung → Healthcheck → Ergebnis. Abbruch ist nur vor der Vorprüfung möglich. Während des Pulls wird Konfigurationsdrift erneut geprüft.

Ein Neustart des Core während einer Ausführung setzt den Job auf `intervention_required`. Derselbe Agent-Job wird anhand seines dauerhaften Journals niemals blind zweimal ausgeführt. Ein erfolgreicher Journalabschluss kann wieder gelesen werden. Ein abgebrochener HTTP-Request mit reserviertem Idempotency-Key wird nicht automatisch wiederholt; in einem unklaren Fall Jobs und Audit prüfen.

Für Standalone-Container bleiben Volume-Namen, Laufzeit-Umgebung, Labels, Mounts und Netzwerkzuordnung erhalten. Nach erfolgreicher Erneuerung bleibt der alte Container gestoppt mit deaktivierter RestartPolicy unter `<name>-cuo-<job>` zur manuellen Untersuchung erhalten. CUO entfernt keine alten Volumes oder Container automatisch. Ein fehlgeschlagener Start oder Healthcheck erfordert einen Eingriff. **Es gibt keinen automatischen Datenbank- oder Volume-Rollback.**

Wartungsfenster verwenden IANA-Zeitzonen. Bei einer übersprungenen Sommerzeit-Uhrzeit wird die nächste gültige Minute am selben Tag verwendet; bei einer doppelten Uhrzeit nur die erste. Laufzeiten sind reale Minuten. Fenster über Mitternacht und Ausnahmetage werden unterstützt. Bereits laufende Jobs werden beim Fensterende nicht unterbrochen. Abgelaufene Fenster werden nicht nachgeholt; geplante Jobs warten auf das nächste passende Fenster. Überschneidende Fenster werden beim Anlegen abgewiesen.

## Sicherung und Wiederherstellung

Persistente Volumes: `cuo_identity` (Benutzer/Sitzungen), `cuo_core` (SQLite, Jobs, Audit), `cuo_agent` (Journale und Compose-Sollzustände). Compose-Sollzustände können aufgelöste Umgebungsgeheimnisse enthalten und sind wie Backups zu schützen. SQLite-Migration ist derzeit Schema v1; ein unbekanntes zukünftiges Schema darf nicht mit einer älteren Version betrieben werden. Ereignisse werden noch nicht automatisch gelöscht.

Vor einer Sicherung automatische Update-Richtlinien vorübergehend auf „Nur prüfen“ setzen und aktive bzw. wartende Ausführungen beenden. Das Skript verweigert die Sicherung bei bereits aktiven oder wartenden Jobs. Andere Bediener dürfen währenddessen keine neuen Updates starten.

Für eine konsistente, offline Sicherung und Wiederherstellung die Skripte in `tools/backup.sh` und `tools/restore.sh` verwenden. `.env` separat mit Dateirechten 0600 sichern. Ein Backup umfasst keine Nutzdaten anderer Container. Deren Datenbanken und Volumes benötigen einen eigenen Backup-Vertrag.

```sh
./tools/backup.sh /sicherer/pfad/cuo-backup.tar.gz
# Stoppt nur CUO für die Sicherung und startet es danach wieder.
./tools/restore.sh /sicherer/pfad/cuo-backup.tar.gz
```

Owner-Zugang wiederherstellen: `./tools/recover-admin.sh`. Das erfordert Zugriff auf den lokalen Docker-Host, fragt das neue Passwort verdeckt ab und widerruft vorhandene Sitzungen.

## Entwicklung und Prüfung

Go **1.27.3** (Toolchain wird automatisch gewählt), Node **24.18+**, npm **11.17.0** für den XTend-Build. Alternativ ausschließlich Docker verwenden.

```sh
go test -race ./...
go vet ./...
cd console
npm run setup
npm run build
npm test
npm audit --prefix runtime --audit-level=high
```

`console/tools/author-rmt.mjs` schreibt die prüfbare kanonische RMT-Datei `console/src/app.rmt`. Änderungen an der Shell dort im Authoring-Modell vornehmen und neu generieren. Im Browser besitzt ausschließlich RMT die Shell, Navigation, Dialogsichtbarkeit und den View-State. Maraca AppServices koordinieren Intents und typisierte BFF-Aufrufe; Server Services rufen die versionierte Core-API auf. Custom-XTend-Komponenten erhalten deklarative Daten und senden `xtend-command`-Events. Native Formulardrafts und Fokus bleiben innerhalb der jeweiligen Komponente. Passwörter werden weder in den View-State noch in Browser-Speicher geschrieben.

Der lokale XTend-MCP-Server wurde zur Prüfung der tatsächlichen APIs genutzt: XTend `49166cbe96d91049634fbe03eb48c04edb6e70cd`. Die Anwendung benötigt den MCP-Server zur Laufzeit nicht. XTend wird als externe Source-Dependency über `console/xtend.lock.json` bezogen: Repository, exakter Commit, Version und SHA-256 des Upstream-Downloads sind festgeschrieben. `npm run setup` und der Docker-Build laden ausschließlich diesen Stand, prüfen den Hash und installieren nur die benötigten Workspaces mit dem Upstream-npm-Lockfile. Ein Framework-Archiv wird nicht im aktuellen Projektstand mitgeführt. `.framework`, Download-Cache und `node_modules` sind generierte, ignorierte Dependency-Verzeichnisse. Die verwendete Maraca-Version ist noch nicht als eigenes npm-Paket verfügbar; nach Veröffentlichung kann die Einbindung auf Registry-Pakete wechseln. Updates erfordern eine bewusste Änderung des Pins und eine Prüfung der DOM-Anpassungen. Der Watchtower-Ausgangspunkt liegt weiterhin in `third_party/`. Loader/Manifest-Zugriff im Browser ist nicht erforderlich; Maraca erzeugt eine statische Komponentenregistry.

```sh
node tools/generate-api.mjs       # OpenAPI und TypeScript-Client
go run golang.org/x/vuln/cmd/govulncheck@v1.9.0 ./...
CUO_DOCKER_E2E=1 go test -v ./internal/agent -run TestDisposableDockerUpdate
```

Der optionale Docker-E2E-Test erzeugt ausschließlich eigene Testcontainer und ein eigenes Volume und räumt diese wieder auf. Niemals einen existierenden Produktivcontainer als Testziel verwenden. Browserprüfungen und Screenshots sind unter `console/test/browser.mjs` beschrieben. `console/test/extensions-browser.mjs` startet zusätzlich einen vollständig isolierten BFF mit eigener Identity-Datenbank, Core-Fixture und signierendem OIDC-Testprovider. Dafür Playwright installieren und optional `CUO_PLAYWRIGHT_MODULE` sowie `CUO_CHROMIUM` setzen. Der Test prüft XRouter, Systemfarbschema, Profile, persistente Benachrichtigungen und eine Anmeldung über unterschiedliche Browser-Sites. Er verwendet keine bestehenden CUO-Konten.

## Grenzen vor einer öffentlichen Veröffentlichung

Das lokale MVP ist noch kein als öffentliches Release freigegebenes Produkt. Private Registry-Credentials, Multi-Host-Transport, automatische Daten-Rollbacks und hochverfügbare Datenhaltung sind nicht aktiviert. OIDC ist optional konfigurierbar; ohne Einrichtung wird ausschließlich die lokale Anmeldung angeboten.

Vor Distribution sind die in `docs/RELEASE-GATES.md` benannten Prüfungen einschließlich signierter OCI-Veröffentlichung, SBOM, Provenance, Image-CVE-Scan, Restore-Test und breiter Barrierefreiheitsprüfung zu erfüllen. Der mitgelieferte CI-Workflow ist auf einen späteren GitHub-Remote vorbereitet. Es wurden keine Images in eine Registry gepusht.

Architektur: `docs/ADR-001.docx`, `docs/ARCHITECTURE.md`. Sicherheitsmodell und Dependency-Bewertung: `SECURITY.md`. Versionierter API-Vertrag: `docs/openapi.json`.
