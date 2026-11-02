# CUO

CUO ist ein lokal installierbarer **Container Update Orchestrator** mit eigenständigem Go-Core und einer XTend Maraca / RMT-Konsole nach der mitgelieferten Designreferenz.

**Status: öffentlicher Entwicklungsstand / Single-Host-MVP (0.2.0), noch kein freigegebenes stabiles Release.** Der Quellcode liegt öffentlich auf [konnilabs/cuo](https://github.com/konnilabs/cuo); die Installation baut die Images lokal. Ein grüner PR-Check bestätigt die dort getesteten Funktionen. Die separaten [Release-Kriterien](docs/RELEASE-GATES.md) einschließlich Image-Sicherheit, signierter Veröffentlichung und vollständiger Barrierefreiheitsprüfung sind noch nicht erfüllt. Es werden keine OCI-Images automatisch veröffentlicht.

0.2.0 ergänzt **UniOCI**, einen optionalen **Zot-Dienst**, private Registry-Zugriffe, native **GitHub-App/Webhooks**, vollständige Release-Sets und eine wirksame **Rollenmatrix**. Neue Seiten und Unterrouten sind in Maraca/RMT umgesetzt. [Einrichtung und Betriebsgrenzen](docs/UNIOCI-0.2.0.md), [ADR-002](docs/ADR-002-UniOCI.md), [ADR-003](docs/ADR-003-Secrets-GitHub-Inbox.md). Der [ursprüngliche Plan](docs/IMPLEMENTATION-PLAN-0.2.0.md) bleibt als Zielvertrag erhalten; der lokale Abnahmebericht benennt noch offene externe Release-Gates.

## Installation

Voraussetzungen: Linux mit Docker Engine **29.x**, Docker Compose **v2 oder v5**, Internetzugang beim ersten Build. Verifiziert mit Docker 29.1.3 / API 1.52. Weitere Versionen und Docker Desktop sind noch nicht zertifiziert.

```sh
./tools/install.sh
```

Danach **http://127.0.0.1:8095** öffnen und den ersten Owner mit einem Passwort ab zwölf Zeichen anlegen. Es gibt keine voreingestellten Zugangsdaten. Eine vom Live-System getrennte, schreibgeschützte Design-Demo steht unter **http://127.0.0.1:8095/?demo=1** bereit. Die Demo verwendet illustrative Daten der Vorlage; ihr Kalendertitel ist ebenfalls eine Abbildung der Vorlage.

Das Installationsskript erzeugt zwei zufällige interne Dienstschlüssel in `.env` und einen separaten AES-Installationsschlüssel unter `.secrets/`, jeweils geschützt. Diese Datei gehört nicht in Git. Nur der Console-Port ist an Loopback veröffentlicht. Core und Agent sind ausschließlich über interne Docker-Netze erreichbar.

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

**Speichern und Verbindung prüfen** prüft bei aktivierter Anmeldung die Discovery und speichert das Secret ausschließlich im serverseitigen Identity-Volume. Ein leeres Secret-Feld behält den bisherigen Wert; zum Entfernen gibt es eine eigene Checkbox. Bei aktivierter automatischer Benutzeranlage darf jeder vom Provider zugelassene Benutzer mit der gewählten Rolle auf den lokalen Host zugreifen; Standard ist **Viewer**. Die Zugangsbegrenzung erfolgt im Provider. Bestehende CUO-Rollen bleiben erhalten. Konten werden über Issuer und Subject identifiziert, niemals anhand gleicher E-Mail-Adressen mit lokalen Konten verknüpft. **Abmelden** beendet CUO-Sitzungen, nicht die Sitzung beim Provider.

Standardmäßig bleibt die lokale Anmeldung verfügbar. Der Owner kann unter **Integrationen → OpenID Connect** „Lokale Anmeldung mit Benutzername und Passwort erlauben“ abschalten. Das setzt aktiviertes OIDC und eine erfolgreiche Discovery-Prüfung voraus. Danach verschwinden die lokalen Login-Felder; auch direkte Aufrufe von `/auth/login` werden mit `LOCAL_LOGIN_DISABLED` abgewiesen. Bereits bestehende Sitzungen bleiben gültig. Vor dem Umschalten SSO in einer getrennten Browsersitzung erfolgreich testen. Neue SSO-Konten erhalten höchstens Administratorrechte, lokale Owner-Konten bleiben eigenständig: Für einen gesperrten lokalen Owner oder bei Provider-Ausfall über das Host-Terminal `./tools/recover-login.sh` aufrufen. Dies aktiviert nur die lokale Anmeldung wieder und protokolliert die Wiederherstellung; OIDC-Konfiguration und Passwörter bleiben erhalten. Es gibt keinen öffentlichen Login-Bypass.

Das Benutzermenü öffnet rechts den XTend-Profil-Drawer: Anzeigename, lokales Profil-Icon, Farbschema und Update-Benachrichtigungen lassen sich speichern. Der lokale Loginname bleibt erhalten. Unter **Workspace-Einstellungen → Darstellung** schaltet XToggle zwischen hell und dunkel. **Automatisch** übernimmt die Systemeinstellung und reagiert auch auf spätere Änderungen. Profilpräferenzen gelten pro Benutzer.

Der Dreieckspfeil neben dem CUO-Logo schaltet die Navigation zwischen voller Breite und einer 76 px breiten Icon-Leiste um. Auf dem Desktop merkt sich der Browser die Auswahl. Auf Handys startet die Icon-Leiste; das aufgeklappte Menü liegt über dem Content und schließt bei Navigation, Escape oder einem Klick daneben. RMT hält den Zustand und die Animation-Vorgaben; XTend AnimationEngine blendet die Beschriftungen aus und dreht den Pfeil, während sich die Breite fließend anpasst. Bei aktivierter Systemoption für reduzierte Bewegung erfolgt der Wechsel sofort. Die Icons behalten zugängliche Namen und Hover-Hinweise.

Erfolgsmeldungen und Fehler erscheinen als echte **XToasts** rechts unten. Die RMT-gesteuerte Toast-Ebene nutzt die oberste Browser-Ebene und `z-index: 2147483647`, sodass sie über dem Profil-Drawer liegt. Toasts lassen sich schließen und verschwinden nach fünf Sekunden (Fehler nach neun Sekunden) automatisch.

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

Unter **Jetzt prüfen** startet ein Registry-Scan. Er löst einen Multi-Arch-Index auf die tatsächliche OS-/Architektur-/Variant-Plattform auf und vergleicht den Image-Konfigurationsdigest mit dem laufenden Image. Ausgeführt wird ausschließlich ein bestätigter, unveränderlicher Plattform-Digest. Getestete anonyme Registries sind Docker Hub; GHCR und Quay sind ebenfalls allowlisted. Weitere Registries werden ausdrücklich unter **Registries** verbunden; `CUO_REGISTRIES` wird bei der Migration rückwärtskompatibel übernommen. Private Pull-Credentials werden unter **Registries** eingerichtet und sowohl für Scan als auch Docker-Pull verwendet. Engere Repository-Freigaben haben Vorrang vor allgemeinen Verbindungen.

Ein Scan prüft Image-Inhalte; er führt keine automatische Versionsmigration auf einen anderen Tag aus. Ein gepinnter Digest bleibt bewusst unveränderlich. Scannerfehler erscheinen als Fehlerstatus und werden nicht als „aktuell“ ausgegeben.

Die Policy-Reihenfolge ist global → Host → Gruppe → Container. Ein übergeordneter Ausschluss bleibt wirksam. Automatische Ausführung und Wartungsfenster laufen im Core, auch wenn kein Browser geöffnet ist. Der Core prüft standardmäßig alle sechs Stunden erneut (`CUO_SCAN_INTERVAL=6h`). Unter Richtlinien lässt sich die Parallelität von **1 bis 4** einstellen. Die Grenzen aller passenden globalen, Host- und Gruppenrichtlinien gelten gemeinsam; ohne globale Richtlinie bleibt die Standardgrenze eins. Bereits laufende Updates werden bei einer Reduktion nicht unterbrochen. Der Agent schützt einzelne Container und Journale vor paralleler Ausführung und serialisiert Services desselben Compose-Projekts, damit gemeinsame Image-Pins und Sollzustände erhalten bleiben.

Im Modal **Update-Lauf starten** können Administratoren und Owner **Alle auswählen** wählen. Nach Grund und ausdrücklicher Neustart-Bestätigung erzeugt `POST /api/v1/update-runs` einen dauerhaften Sofortlauf für alle aktuell bekannten ausführbaren Kandidaten. Diese manuelle Freigabe startet auch Richtlinien mit Freigabepflicht außerhalb der Wartungsfenster. Die Grenzen der Parallelität, Host-Berechtigungen, `cuo.managed`, Ausschlüsse und „Nur prüfen“ bleiben wirksam. Veraltete oder fehlerhafte Kandidaten, gestoppte Container und bereits aktive Jobs werden übersprungen. Die Auswahl ist serverseitig, unabhängig von Suche und Tabellen-Seite; ein unveränderter Idempotency-Key wiederholt den Lauf nicht. Einzeljobs behalten ihre bisherigen Freigabe- und Wartungsfenster-Regeln. Eine neue Registry-Prüfung wird dabei nicht automatisch gestartet; vorher bei Bedarf „Jetzt prüfen“ verwenden.

Das **Fragezeichen neben dem Farbschema-Icon** öffnet eine kompakte Kurzanleitung und einen eigenen scrollbaren Bereich für Lizenzhinweise. Die Liste enthält XTend Maraca/RMT/XIcon, den OIDC-Laufzeitbaum, die tatsächlich eingebundenen Go-Module, Schriften und Produkt-Icons samt Lizenztexten. `node tools/generate-notices.mjs` erzeugt diese lokale Liste aus den gepinnten Quellen; CI prüft sie mit `--check`. Die Anwendung lädt dafür keine externen Skripte oder Lizenzdienste.

Für einen manuellen Lauf den Container auswählen, Unterbrechung bestätigen und einen Grund angeben. Eine Richtlinie mit manueller Freigabe erzeugt zunächst einen Job für einen Administrator oder Owner. Viewer lesen nur; Operator dürfen prüfen und Jobs anlegen. Rollen werden im Core geprüft, nicht nur im Browser.

## Compose-Projekte registrieren

CUO aktualisiert Compose-Services durch **Docker Compose**, nicht durch eine verdeckte Neuerstellung außerhalb des Projekts. Nicht registrierte Compose-Projekte werden vor der Veränderung abgewiesen.

Der Agent enthält **Compose v5.6.1-cuo.1**, einen eigenen Build der stabilen Upstream-Version v5.6.1 mit dem gezielt zurückportierten Dependency-Fix für CVE-2026-78669. Dabei werden `x/net` auf v0.60.0 und die zugehörigen `x/crypto`-/`x/text`-Versionen aktualisiert; der Compose-Programmcode bleibt auf v5.6.1. Quellarchiv, Security-Patch und resultierende Moduldateien sind per Commit/SHA-256 festgeschrieben. Der Build wird ausdrücklich als modifiziert gekennzeichnet. Herkunft, Lizenzhinweise und Ablösung durch ein späteres offizielles Release sind in [dependencies/compose](dependencies/compose/README.md) beschrieben. Der auf dem Host installierte Compose-Befehl wird dabei nicht ersetzt.

1. `CUO_PROJECTS_DIR` in `.env` auf das absolute Stammverzeichnis vertrauenswürdiger Compose-Projekte setzen. Es wird im Agent unter `/projects` schreibgeschützt eingebunden.
2. Dem Service zusätzlich `cuo.compose.file` mit dem relativen Pfad der Compose-Datei in diesem Stammverzeichnis geben, etwa `nextcloud/compose.yaml`.
3. Projekt mit seinen normalen Quellen erstellen und CUO-Inventar aktualisieren.

Der Agent lässt Compose die Quellen, `.env`, `env_file` und relativen Pfade auflösen. Er bewahrt Image-Pins anderer bereits verwalteter Services und schreibt den vollständigen gewünschten Zustand nach `/data/compose-locks/<projekt>.json`. Nur der ausgewählte Service wird mit `up -d --no-deps --no-build --pull never` abgeglichen. Bind-Mount-Pfade werden auf das originale Host-Projektverzeichnis zurückgeführt. Ein Service muss genau eine Replica haben.

**Der gespeicherte CUO-Sollzustand ist während der Verwaltung maßgeblich.** Ein späteres externes `docker compose up` nur mit der ursprünglichen, ungepinnten Quelldatei könnte einen Pin überschreiben. Für externe Abgleiche zuerst den CUO-Sollzustand exportieren und verwenden, oder den Service in CUO deaktivieren und die Verwaltung ausdrücklich zurückgeben. Direkte Dateimanipulation auf dem Host führt CUO nicht aus.

Unter **Richtlinien → Container-Richtlinie bearbeiten → Erweiterte Ausführungsfreigaben** kann ein **Owner** bestehende lesende Bind-Mounts von `/proc` und `/sys` einschließlich ihrer Unterverzeichnisse zulassen, beispielsweise `/proc:/host/proc:ro` und `/sys:/host/sys:ro`. Die Freigabe verlangt einen Grund und die ausdrückliche Bestätigung des Warnhinweises: Das Image erhält Einblick in Host-Prozesse und Systeminformationen, und die Freigabe gilt auch für automatische Updates dieses Containers. Vergabe und Widerruf werden mit Akteur protokolliert; bei der Vergabe wird die Begründung festgehalten. Globale, Host- oder Gruppenfreigaben sind nicht zulässig. Administratoren können bestehende Freigaben beim Bearbeiten anderer Richtlinienfelder erhalten, aber nicht ändern.

CUO erhält Quelle, Ziel und den Docker-Readonly-Status beim Update. Dafür gelten weiterhin `cuo.managed=true`, Richtlinien, Laufzustand, Plattform-/Digest-Prüfung und Konfigurationsabgleich. Der Core prüft die aktuelle Freigabe erneut beim Ausführungsbeginn; ein Widerruf gilt damit auch für noch wartende Jobs. Bereits begonnene Updates werden dadurch nicht unterbrochen. Die Regel ist unabhängig vom Container-Namen oder Hersteller. Der erste unterstützte Freigabetyp heißt `permissions.readOnlyHostMonitoring`; weitere schreibende Operationen benötigen jeweils einen eigenen Ausführungspfad, Freigabetyp und passende Prüfungen.

Beschreibbare oder nicht eindeutig als lesend ausgewiesene Host-System-Mounts, Host-Root-/Geräte-/Docker-Daten-Mounts, Docker-Sockets sowie Mounts auf die containerinternen `/proc`-, `/sys`- und `/dev`-Pfade bleiben ausgeschlossen. Host-privilegierte Container, zusätzliche Capabilities, AutoRemove, Host-Netzwerke und gemeinsame Container-Netzwerkräume werden nicht automatisch erneuert. CUO-Systemdienste sind immer ausgeschlossen. Der Host-Agent besitzt durch den Socket trotzdem weitreichende Host-Rechte; seine interne, authentifizierte API ist eine eingeschränkte Ausführungsgrenze und keine vollständige Betriebssystem-Sandbox.

## Jobs, Wiederanlauf und Daten

Jobs durchlaufen Freigabe / Planung → Warteschlange → Vorprüfung → Pull → Neuerstellung → Healthcheck → Ergebnis. Abbruch ist nur vor der Vorprüfung möglich. Während des Pulls wird Konfigurationsdrift erneut geprüft.

Ein Neustart des Core während einer Ausführung setzt den Job auf `intervention_required`. Derselbe Agent-Job wird anhand seines dauerhaften Journals niemals blind zweimal ausgeführt. Ein erfolgreicher Journalabschluss kann wieder gelesen werden. Ein abgebrochener HTTP-Request mit reserviertem Idempotency-Key wird nicht automatisch wiederholt; in einem unklaren Fall Jobs und Audit prüfen.

Für Standalone-Container bleiben Volume-Namen, Laufzeit-Umgebung, Labels, Mounts und Netzwerkzuordnung erhalten. Nach erfolgreicher Erneuerung bleibt der alte Container gestoppt mit deaktivierter RestartPolicy unter `<name>-cuo-<job>` zur manuellen Untersuchung erhalten. CUO entfernt keine alten Volumes oder Container automatisch. Ein fehlgeschlagener Start oder Healthcheck erfordert einen Eingriff. **Es gibt keinen automatischen Datenbank- oder Volume-Rollback.**

Wartungsfenster verwenden IANA-Zeitzonen. Bei einer übersprungenen Sommerzeit-Uhrzeit wird die nächste gültige Minute am selben Tag verwendet; bei einer doppelten Uhrzeit nur die erste. Laufzeiten sind reale Minuten. Fenster über Mitternacht und Ausnahmetage werden unterstützt. Bereits laufende Jobs werden beim Fensterende nicht unterbrochen. Abgelaufene Fenster werden nicht nachgeholt; geplante Jobs warten auf das nächste passende Fenster. Überschneidende Fenster werden beim Anlegen abgewiesen.

## Sicherung und Wiederherstellung

Persistente Volumes: `cuo_identity` (Benutzer/Sitzungen), `cuo_core` (SQLite, Jobs, Audit), `cuo_agent` (Journale und Compose-Sollzustände). Compose-Sollzustände können aufgelöste Umgebungsgeheimnisse enthalten und sind wie Backups zu schützen. SQLite-Migration ist derzeit Schema v1; ein unbekanntes zukünftiges Schema darf nicht mit einer älteren Version betrieben werden. Ereignisse werden noch nicht automatisch gelöscht.

Vor einer Sicherung automatische Update-Richtlinien vorübergehend auf „Nur prüfen“ setzen und aktive bzw. wartende Ausführungen beenden. Das Skript verweigert die Sicherung bei bereits aktiven oder wartenden Jobs. Andere Bediener dürfen währenddessen keine neuen Updates starten.

Für eine konsistente, offline Sicherung und Wiederherstellung die Skripte in `tools/backup.sh` und `tools/restore.sh` verwenden. Sie ermitteln die drei benannten Daten-Volumes der gewählten Compose-Instanz, verwenden die installierte Core-Image-ID ohne Pull und prüfen das Archiv vollständig vor einer Wiederherstellung. Pfadwechsel, Links, doppelte Einträge, unvollständige Archive, unbekannte Datenbank-Schemata, beschädigte SQLite-Dateien und offene Jobs werden abgewiesen. Die Grenze liegt bei 2 GiB Dateiinhalten und 100.000 Archiveinträgen; dafür wird zusätzlich temporärer Speicher im Prüfcontainer benötigt.

Das Backup erhält Rechte 0600 und wird erst nach bestandener Prüfung unter dem Zielnamen abgelegt. Restore benötigt die Bestätigung `RESTORE`, erzeugt zuvor eine geschützte Sicherung des aktuellen Datenstands und startet CUO nur nach erfolgreicher Wiederherstellung. Bei einem Kopierfehler bleibt CUO gestoppt; die Wiederherstellung mehrerer Volumes ist keine atomare Transaktion. Ein Restore benötigt eine bereits angelegte CUO-Instanz mit den aktuellen Images; bei abweichenden Compose-Projekten dieselben `COMPOSE_FILE`-/`COMPOSE_PROJECT_NAME`-Angaben wie beim Betrieb setzen.

`.env`, Reverse-Proxy-Konfiguration und vertrauenswürdige Compose-Quelldateien separat geschützt sichern. Das Archiv ist nicht verschlüsselt und enthält Geheimnisse. Ab 0.2 umfasst Format 2 optional Zot-Blobs und Registry-Konfiguration (maximal 16 GiB / 100.000 Einträge). Den Integrationsschlüssel und die Bootstrap-Zugänge mit `./tools/backup-key.sh /anderer/geschützter/pfad/cuo-secrets.tar.gz` **getrennt** sichern; ohne passenden Schlüssel startet die wiederhergestellte Core-Datenbank nicht. Bestehende Drei-Volume-Archive bleiben lesbar. Ein Backup umfasst keine Nutzdaten anderer Container. Deren Datenbanken und Volumes benötigen einen eigenen Backup-Vertrag. Nach dem Restore Containerbestand und ungeklärte Jobs vor der erneuten Freigabe automatischer Updates prüfen; laufende Workloads werden durch das Zurücksetzen von CUO-Daten nicht zurückgesetzt.

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

Der lokale XTend-MCP-Server wurde zur Prüfung der tatsächlichen APIs genutzt: XTend `0e2e7c9e7ee3cf7316ff8b9073ec033e7c7d0836`. Die Anwendung benötigt den MCP-Server zur Laufzeit nicht. XTend wird als externe Source-Dependency über `console/xtend.lock.json` bezogen: Repository, exakter Commit, Version und SHA-256 des Upstream-Downloads sind festgeschrieben. `npm run setup` und der Docker-Build laden ausschließlich diesen Stand, prüfen den Hash und installieren nur die benötigten Workspaces mit dem Upstream-npm-Lockfile. Ein Framework-Archiv wird nicht im aktuellen Projektstand mitgeführt. `.framework`, Download-Cache und `node_modules` sind generierte, ignorierte Dependency-Verzeichnisse. Die verwendete Maraca-Version ist noch nicht als eigenes npm-Paket verfügbar; nach Veröffentlichung kann die Einbindung auf Registry-Pakete wechseln. Updates erfordern eine bewusste Änderung des Pins und eine Prüfung der DOM-Anpassungen. Der Watchtower-Ausgangspunkt liegt weiterhin in `third_party/`. Loader/Manifest-Zugriff im Browser ist nicht erforderlich; Maraca erzeugt eine statische Komponentenregistry.

```sh
node tools/generate-api.mjs       # OpenAPI und TypeScript-Client
go run golang.org/x/vuln/cmd/govulncheck@v1.9.0 ./...
CUO_DOCKER_E2E=1 go test -v ./internal/agent -run TestDisposableDockerUpdate
node --test tools/test/*.test.mjs
node tools/test-restore.mjs       # eigene Instanz, drei Wegwerf-Volumes, kein Docker-Socket
```

Der optionale Docker-E2E-Test erzeugt ausschließlich eigene Testcontainer und ein eigenes Volume und räumt diese wieder auf. Niemals einen existierenden Produktivcontainer als Testziel verwenden. Browserprüfungen und Screenshots sind unter `console/test/browser.mjs` beschrieben. `console/test/extensions-browser.mjs` startet zusätzlich einen vollständig isolierten BFF mit eigener Identity-Datenbank, Core-Fixture und signierendem OIDC-Testprovider. Dafür Playwright installieren und optional `CUO_PLAYWRIGHT_MODULE` sowie `CUO_CHROMIUM` setzen. Der Test prüft XRouter, Systemfarbschema, Profile, persistente Benachrichtigungen und eine Anmeldung über unterschiedliche Browser-Sites. Er verwendet keine bestehenden CUO-Konten.

## MVP-Umfang und Release-Reife

Das erste Release-Ziel ist **eine CUO-Instanz für einen lokalen Linux-Docker-Host** mit einer Console, einem Core, einem Agent und lokaler SQLite-Datenhaltung. Persistente Volumes und Docker-Neustartregeln ersetzen keine Hochverfügbarkeit. Für Datenbank-Migrationen verwalteter Anwendungen bleiben deren Betreiber verantwortlich.

| Bereich | Aktueller Stand |
|---|---|
| Private Registry-Credentials | Implementiert: verschlüsselte, nur schreibend konfigurierbare Pull-/Push-Identitäten, private CA, Scope und Ablaufkontrolle; Scan und Docker-Pull. |
| Multi-Host-Transport | Noch nicht implementiert; Host-Felder und Berechtigungen sind keine Remote-Agent-Anbindung. Spätere Ausbaustufe. |
| Automatische Daten-Rollbacks | Nicht implementiert. Der aufbewahrte Standalone-Vorgänger ist kein Volume- oder Datenbank-Backup. Spätere, anwendungsspezifische Ausbaustufe. |
| Hochverfügbare Datenhaltung | Nicht implementiert. Single-Writer-SQLite, kein Core-Cluster und kein Failover. Spätere Ausbaustufe. |
| OCI-Publish / Signaturen / Provenance | Noch offen. Das bisherige Entwurfsskript veröffentlicht aus Sicherheitsgründen keine Images mehr. |
| SBOM und Image-CVE-Scan | Nach Compose-Backport 0 HIGH/CRITICAL in allen drei Images und 0 betroffene Symbole im Go-Binärscan. Drei Modulwarnungen bleiben in den Nachweisen sichtbar; die Bewertung gilt für den geprüften Build. Noch keine signierte Release-SBOM. |
| Barrierefreiheit | Bisher Bedienungs-Smokes; vollständiges WCAG-2.2-AA-Audit mit assistiven Technologien noch offen. |
| Restore-Test | Automatischer isolierter Test aller drei CUO-Volumes einschließlich Anmeldung, Einstellungen, Historie und Journale vorhanden; keine Aussage über Workload-Daten oder Wiederherstellung nach Host-Verlust. |

`.github/workflows/ci.yml` prüft Pushes und Pull Requests bereits auf GitHub und führt den isolierten Restore-Test aus. Der separat manuell startbare Workflow **CUO image release preflight (no publication)** erzeugt Image-SBOMs und CVE-Berichte ohne Registry-Schreibrechte. Lokal: Images bauen und mit installiertem Trivy und Syft `node tools/check-images.mjs` starten. Der Befehl exportiert unveränderliche Image-IDs, scannt für jedes Image dieselben Archivbytes und liefert bei einem Scannerfehler oder HIGH-/CRITICAL-Befund einen Fehlerstatus. Ergebnisse liegen standardmäßig im ignorierten `work/image-checks/`; für erneute Läufe ein neues leeres Verzeichnis über `CUO_IMAGE_REPORTS` wählen.

Die [Release-Matrix](docs/RELEASE-GATES.md) beschreibt die noch nötigen Entscheidungen und Abnahmekriterien. Die lokalen Nachweise zum [0.2.0-Grundstand](reports/local-0.2.0.json) und zur [animierten Navigation](reports/sidebar-0.2.0.json) sind nach Zeitpunkt, Image-ID und Quellstand begrenzt; ältere Dateien in `reports/` sind historische Testergebnisse und keine Freigabe des aktuellen Stands.

Architektur: `docs/ADR-001.docx`, `docs/ARCHITECTURE.md`. Sicherheitsmodell und Dependency-Bewertung: `SECURITY.md`. Versionierter API-Vertrag: `docs/openapi.json`.
