# Release-Reife des Single-Host-MVP

Stand: **2026-11-01**. Vereinbart ist zunächst eine lokal installierbare CUO-Instanz auf einem Linux-Docker-Host, keine verteilte Plattform. Das Repository ist bereits öffentlich. Öffentlicher Quellcode, grüne PR-Prüfungen und ein stabiles, signiertes OCI-Release sind getrennte Zustände. Aktuell ist CUO eine **Entwicklungsvorschau**, die stabile Artefaktfreigabe bleibt offen.

Die lokalen Nachweise stehen in [`reports/release-readiness.json`](../reports/release-readiness.json) und [`reports/restore-test.json`](../reports/restore-test.json). Sie nennen Zeit, Quellstand und Image-IDs; ein Nachweis aus einem veränderten Arbeitsverzeichnis ist kein signierter Nachweis eines sauberen Release-Tags. Ältere Berichte sind historische Ergebnisse, insbesondere kein aktueller OIDC-, Registry- oder CVE-Status.

## Produktumfang und spätere Ausbaustufen

| Offener Bereich | Entscheidung für das erste MVP | Voraussetzung einer späteren Umsetzung |
|---|---|---|
| Private Registry-Credentials | Nicht implementiert; Unterstützung öffentlicher/anonym zugänglicher Images ist der dokumentierte Umfang. Kein versteckter Credential-Schalter. | Agent-seitiger Secret-Vertrag pro Registry/Host, Widerruf/Rotation, Rechteprüfung, sichere Übergabe sowohl beim Scan als auch beim Digest-Pull. Tests mit privater Registry, abgelaufenen Credentials und sicherem Fehler-/Audit-Verhalten. Keine Secrets im Browser, Core-Audit oder Compose-Sollzustand. |
| Multi-Host-Transport | Außerhalb des ersten MVP. Der Core besitzt einen Agent-Endpunkt; Host-Felder sind kein Remote-Transport. Mehrere unabhängige lokale CUO-Installationen sind kein Cluster. | Separater ADR für Registrierung, mTLS/Identitäten, Host-Autorisierung, Rotation, Timeouts, Verbindungsabbrüche und Idempotenz. Kein ungesichertes Remote-Docker-TCP. |
| Automatische Daten-Rollbacks | Außerhalb des ersten MVP. Ein alter Container mit denselben Volumes stellt keine früheren Daten wieder her. | Anwendungsspezifischer Backup-/Snapshot-Vertrag, konsistente Datenbank-Sicherung, Migrations-/Restore-Verfahren, geprüfte Abbruchpunkte und ausdrückliche Freigabe. Kein generischer automatischer Volume-Rollback. |
| Hochverfügbare Datenhaltung | Außerhalb des ersten MVP. Ein Core, ein Agent und eine Identity-Instanz mit lokalen Volumes; kein Failover. SQLite nicht von mehreren Core-Replikaten gemeinsam beschreiben. | Eigener ADR für Datenbank/Transaktionen, Leader-/Worker-Koordination, Fencing des Agents, Sessions/Secrets, Event-Zustellung und getesteten Failover. |

Diese Grenzen sind keine Blocker für einen ehrlich so benannten Single-Host-MVP. Sie müssen in README, UI und Release-Text sichtbar bleiben. Sie dürfen erst nach eigener Implementierung und Abnahme als unterstützt gelten.

## Nachweise und Freigabekriterien

| Prüfung | Stand / Nachweis | Noch für eine stabile Artefaktfreigabe erforderlich |
|---|---|---|
| RMT, Verträge und HTML-Sinks | Strikter Maraca-Build, Source-Gate, Runtime-Härtung und typisierte Services in der regulären CI. | Gleiche Prüfungen auf dem finalen Release-Commit; keine unkontrollierten HTML-Sinks oder stillen Framework-Anpassungen. |
| Core / Agent | Go-Race-Tests, Vet, DST-/Policy-/Idempotenz-/Recovery-Tests; Wegwerf-Docker-E2E für Standalone, Compose und dauerhafte Sofortläufe. | CI des finalen Commits grün. Unterstützte Matrix bleibt auf die tatsächlich geprüften Einzelhost-/Einzelreplica-Pfade begrenzt. |
| Anmeldung / UI | Signierter OIDC-Testprovider, Rollen/CSRF/Origin, OIDC-only, Profile, Router, Benachrichtigungen und mobile Bedienungs-Smokes. | Finalen Build prüfen; kundenspezifischer Providerzugang ist eine Installationsprüfung, kein allgemeines Konformitätszertifikat. |
| Source-SCA | `govulncheck` und getrennte npm-Audits für verwendete XTend-Build-Workspaces und OIDC-Runtime. | Frische Daten und dokumentierte Befunde des Release-Commits. Diese Prüfungen decken OS-Pakete und mitgelieferte CLI-Binaries nicht vollständig ab. |
| Image-CVE-Scan | **Implementiert, Gate noch nicht bestanden:** Trivy 0.76.1 prüft OS- und Sprachpakete derselben exportierten Imagebytes. Nach Härtung: Core 0 HIGH/CRITICAL, Console 0, Agent noch 1 HIGH. | Verbleibenden Compose-Befund beheben oder seine Nichtanwendbarkeit separat belastbar nachweisen. Keine pauschale Ausnahme für „unfixed“. Frischen Scan aller finalen Images erfolgreich abschließen. |
| SBOM | **Lokal vorhanden:** Syft 1.55.0 erzeugt CycloneDX-Inventare einschließlich OS-Paketen für alle drei Images, mit Archiv-/Report-Hashes im Manifest. | Vollständigkeit insbesondere für XTend-Source-Bundle, adaptierten Watchtower-Code, Go-Binaries und Build-Materialien prüfen; SBOMs als signierte, digestgebundene Release-Artefakte beilegen. Eine Lizenzliste ersetzt keine Image-SBOM. |
| Provenance | **Offen:** Quellpins und lokale Build-Berichte existieren; kein veröffentlichter, vertrauenswürdig verifizierter Build-Nachweis. | Einmaliger Build aus geschütztem Release-Commit; BuildKit-/in-toto-Provenance mit Materialien, Builder-Identität, Plattform und Digests. Nachweise nach Transport aus der Ziel-Registry verifizieren. |
| OCI-Publish / Signatur | **Gesperrt:** `tools/release.sh` beendet sich mit Fehlerstatus und veröffentlicht nichts. | Ziel-Registry, Namensschema, Version/Tags, Plattformen und Signieridentität festlegen. Unveränderte gescannte OCI-Artefakte samt Attestierungen übertragen; alle drei Kandidaten vor Promotion prüfen; Cosign-Verifikation mit festgelegtem Issuer und Subject sowie dokumentierten Consumer-Befehlen. Teilveröffentlichung/Retry behandeln. |
| Restore-Test | **Lokal bestanden / CI ergänzt:** tatsächliche Backup-/Restore-Skripte gegen drei eigene Volumes; SQLite, Owner-Anmeldung, Profil/OIDC-Einstellung, Benachrichtigungen, Richtlinien, Jobs, Audit, Agent-Journale und Sollzustände werden geprüft. Keine Host-Socket-Mounts oder offenen Ports im Test. | Finalen Commit in CI prüfen. Installationshandbuch für einen Ersatzhost mit separat gesicherter `.env`, Quellen und Proxy-Konfiguration erproben, bevor Host-Disaster-Recovery versprochen wird. Verwaltete Workload-Daten bleiben außerhalb dieses Archivs. |
| A11y-Audit | **Offen:** vorhandene Tastatur-/Mobil-Smokes sind keine WCAG-2.2-AA-Abnahme. | Die unten beschriebene manuelle und automatisierte Prüfung durchführen, Fehler beheben und verbleibende Einschränkungen mit Scope veröffentlichen. |
| Vertraulicher Sicherheitskontakt | **Offen:** GitHub Private Vulnerability Reporting ist derzeit deaktiviert. Secret Scanning und Push Protection sind bereits aktiv. | Maintainer aktiviert einen vertraulichen Meldeweg, prüft ihn und aktualisiert `SECURITY.md`. Keine Zugangsdaten oder unveröffentlichten Exploit-Details in öffentlichen Issues. |

Der noch offene HIGH-Befund ist **CVE-2026-78669 / GO-2026-6611** in `golang.org/x/net v0.58.0` des eingebetteten Docker-Compose-Plugins v5.6.1, behoben ab v0.60.0. [Go-Advisory](https://pkg.go.dev/vuln/GO-2026-6611), [gepinnte Compose-Version](https://github.com/docker/compose/blob/v5.6.1/go.mod). CUOs eigenes Go-Binary nutzt diesen Modulstand nicht. Daraus folgt keine automatische Entwarnung für das mitgelieferte Plugin; das Image-Gate bleibt rot.

## Reproduzierbare Prüfwege

Die reguläre [CI](../.github/workflows/ci.yml) läuft auf GitHub bereits für Pushes und Pull Requests. Der zuletzt überprüfte Main-Commit `d0398767fdeff381d2fa4495ea0807cc29b628b9` war [grün](https://github.com/konnilabs/cuo/actions/runs/41321773403); das belegt nicht die noch lokalen Änderungen dieses Entwicklungsstands. CI veröffentlicht keine Images.

```sh
# Bestehende Images des lokalen Builds prüfen, nicht gegen eine Registry pushen:
docker compose build
node tools/check-images.mjs

# Aktuelle Images müssen zuvor gebaut sein; keine vorhandenen CUO-Daten als Ziel:
node tools/test-restore.mjs
```

`check-images.mjs` benötigt Docker, Node 24, Trivy und Syft. Standardausgabe: ignoriertes `work/image-checks/`; `CUO_IMAGE_REPORTS` wählt ein anderes neues, leeres Verzeichnis. Es löst zuerst alle drei lokalen Tags auf unveränderliche IDs auf und erzeugt pro Image **ein** Docker-Archiv, das beide Scanner verwenden. Das Manifest enthält IDs, SHA-256, Datenbank-/Toolstand, Befunde und den Gesamtstatus. Archive werden standardmäßig anschließend gelöscht; mit `CUO_KEEP_IMAGE_ARCHIVES=1` bleiben sie lokal erhalten. Scannerfehler, fehlende Identitäts-/OS-Nachweise oder HIGH/CRITICAL ergeben einen Fehlerstatus; Ergebnisse der anderen Images werden dennoch erfasst. Dies ist keine OCI-Provenance und kein Registry-Manifest-Digest.

Der neue manuelle Workflow [release-preflight.yml](../.github/workflows/release-preflight.yml) installiert hashgeprüfte Scanner, baut lokal, prüft alle drei Images und stellt Berichte als Actions-Artefakte bereit. Er besitzt nur Leserechte und meldet die derzeit offene CVE als fehlgeschlagene Prüfung. Ein Lauf muss vom Maintainer separat gestartet werden; seine Existenz bedeutet noch keinen erfolgreichen GitHub-Lauf.

Das frühere `release.sh` scannte einen lokalen Build, baute beim Push aber erneut. Damit war der veröffentlichte Digest nicht durch den vorherigen Scan abgedeckt; es konnte zudem schon ein Service veröffentlicht sein, bevor spätere Services geprüft waren. Der unsichere Entwurf ist deaktiviert. Die spätere Pipeline muss dieselben geprüften OCI-Blobs unverändert übertragen und anschließend Signaturen/Attestierungen am Registry-Digest prüfen. Der klassische lokale Docker-Image-Store erhält BuildKit-Attestierungen nicht; eine passende OCI-Ausgabe/Registry und ein geeigneter Builder sind nötig. [Docker: Attestierungen und Speicherung](https://docs.docker.com/build/metadata/attestations/), [Sigstore: Verifikation](https://docs.sigstore.dev/cosign/verifying/verify/).

## Umfang des noch offenen A11y-Audits

Der Audit soll Anmeldung/Erstanlage/OIDC-only, alle SPA-Routen, Containerfilter und Sortierung, Kalender/Richtlinien, Update-Auswahl/-Freigabe, Profil-Drawer, Benachrichtigungen, Hilfe und Toasts abdecken. Sowohl anonyme als auch die vier autorisierten Rollen prüfen, jeweils hell/dunkel, Desktop und schmale Ansicht. Testdaten verwenden; keine Produktivupdates für die Bedienungsprüfung auslösen.

- Automatisierte WCAG-2.2-A/AA-Prüfungen auch in offenen Shadow Roots sowie gezielte Kontrastprüfung aller Zustände.
- Vollständige Tastaturbedienung, sichtbarer Fokus, logische Fokusfolge, Modal-Fokusbindung und Rückkehr zum Auslöser; kein Fokus hinter Drawer/Dialog und kein Verlust beim Routerwechsel.
- Screenreader-Prüfung der Landmarken, Namen/Rollen/Zustände, Tabellen-/Sortierinformationen, Kalenderbedienung und Fehlermeldungen; Live-Ankündigungen von Toasts und Jobänderungen ohne Überflutung.
- Zoom/Reflow bis 400 %, 320 CSS-Pixel Breite, Textvergrößerung, Zielgrößen, reduzierte Bewegung und bedienbare scrollbare Lizenz-/Log-Bereiche.
- Pro Fund betroffene Route/Komponente, WCAG-Kriterium, Reproduktionsschritte, Schweregrad und Nachprüfung festhalten; getestete Browser-/Screenreader-Versionen und Datum nennen.

Ein automatisierter Scan allein beweist keine WCAG-Konformität; dafür sind auch manuelle Bewertungen erforderlich. [W3C: Conformance](https://www.w3.org/WAI/WCAG22/Understanding/conformance).
