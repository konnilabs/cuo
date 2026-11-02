# CUO 0.2.0 einrichten

0.2.0 ist ein lokaler Entwicklungsstand. Ein erfolgreicher Fixture-Test ersetzt keine echte GitHub-App-Installation oder signierte Release-Abnahme. Multi-Host, HA und automatische Workload-Daten-Rollbacks bleiben außerhalb dieser Version.

## Externe Registry oder lokales Zot

Ohne eigene Registry genügt `./tools/install.sh`. Für Zot: `./tools/install.sh --with-registry`. Der Installer provisioniert getrennte Pull-, CUO-Import- und CI-Push-Identitäten und startet Zot ausschließlich auf `127.0.0.1:5055`. Zugangsdaten stehen geschützt in `.secrets/`; `zot-ci.env` ist für den lokalen Betreiber bestimmt und gehört nicht in Git oder Actions-Logs. Für CI den Passwortwert als GitHub-Actions-Secret hinterlegen. Kein anonymer Push; die Pull-Identität darf nicht schreiben. Der Dienst besitzt keinen Docker-Socket und ist von normalen CUO-Updates ausgeschlossen.

Unter **Registries** sind Verbindungen, Repository-Grenzen, Pull-/Push-Credentials, eigener CA-Text und ausdrücklicher LAN-Zugriff konfigurierbar. Leere Passwortfelder behalten den vorhandenen Wert. Host-/Realm-/CA-Wechsel benötigt frische zugehörige Zugangsdaten; eine Deaktivierung blockiert wartende Zugriffe. Die Repository-Ansicht bietet Katalog (falls vorhanden), Tag-Abfrage, Digest-/Plattform-Metadaten und einen Artefakt-Drawer. Referenzartefakte sind **nicht automatisch kryptografisch verifiziert**. Imports benötigen eine eigene Rollenfähigkeit und getrennte Push-Zugangsdaten am Ziel. Kopiert wird per Digest ohne Rebuild, mit Referenzartefakten und anschließendem Digest-Abgleich.

Ein abweichender kanonischer Registry-Host wird **vor** der Erstprovisionierung in `.env` als `CUO_ZOT_HOST` gesetzt. Der interne Origin bleibt `http://zot:5000`. Für entfernte CI einen eigenen Registry-DNS-Namen und TLS-Ingress gemäß `deploy/Caddyfile.registry.example` bereitstellen. Für private CAs müssen **CUO und Docker Engine** der CA vertrauen. Eine im UI konfigurierte CA ändert nicht die Docker-Daemon-Konfiguration. TLS-Prüfung wird nicht abgeschaltet.

Die Zot-Einstellungen zeigen Konnektivität, Speicherinformationen und eine Retention-Vorschau. Automatisches Löschen bleibt aus. Die Importgrenze beträgt 2 GiB und 10.000 eindeutige Deskriptoren pro Copy; Fehler lassen bereits geschriebene, inhaltsadressierte Blobs zurück, aber erzeugen keine unvollständigen Release-Kandidaten. Speicher muss vom Host überwacht und gesichert werden.

## GitHub-App verbinden

Unter **Integrationen → GitHub** legt ein Owner zunächst eine benannte Verbindung an. „GitHub-App anlegen“ öffnet GitHubs Manifest-Registrierung für den eigenen Account oder die angegebene Organisation. Alternativ eine bestehende App-ID, PEM-Datei und ein mindestens 32 Zeichen langes Webhook-Secret eingeben. Private Schlüssel und Secrets verlassen nach dem Speichern den Server nicht mehr.

Die App benötigt nur **Repository metadata: read** und **Actions: read**, Ereignis `workflow_run`. Callback und Webhook-URL stehen in der Verbindung. Die App auf den ausdrücklich ausgewählten Repositories installieren, Installationen laden und die geprüfte Installation auswählen; erst dann aktivieren. GitHub-Verbindung und CUO-OIDC-Anmeldung sind unabhängig. Für private GHCR-Images zusätzlich eine Registry-Verbindung mit einem PAT classic und `read:packages` einrichten. Installationstokens werden nicht als GHCR-Pull-Passwort verwendet.

Bei rein lokalem CUO kann GitHub den Webhook nicht erreichen. Der Core gleicht aktivierte Subscriptions trotzdem alle 15 Minuten per API ab. Ein öffentlicher HTTPS-Origin erlaubt signierte Webhooks. Ein Webhook liefert nur den Anstoß; GitHub-API und Registry werden vor Annahme unabhängig geprüft. Die Inbox zeigt Fehler, Wiederholungen und die berechtigte Wiederaufnahme. Ein identischer Delivery-Key mit anderem Inhalt liefert einen Konflikt.

## Publish-Workflow und Subscriptions

Die Vorlage `examples/github/unioci-publish.yml` in das eigene Repository übernehmen, Dockerfiles/Komponenten anpassen und Actions-Rechte prüfen. Sie verwendet GHCR, veröffentlicht je Komponente einen unveränderlichen Digest und lädt erst nach erfolgreichen Scans das Actions-Artefakt **unioci-release** mit genau **unioci-release.json** hoch. Vertrag: `docs/unioci-release.schema.json`. Andere CI-/Registry-Kombinationen können denselben Vertrag liefern; die Zuordnung enthält keine XTend-Sonderregeln.

Unter **Subscriptions** Verbindung, freigegebenes Repository und aktiven Publish-Workflow auswählen. Branch-Muster, Kanal und **alle** erwarteten Komponenten sowie ihre verwalteten Container zuordnen. Startmodus ist Vorschau. Optional ausdrücklich nach Zot importieren. Freigabe/Automatik sind getrennte Entscheidungen und benötigen weiterhin `cuo.managed=true`, ausführbare Richtlinien, passende Wartungsfenster und Parallelitätsgrenzen.

Erst vollständige Sets werden angenommen. PR-/Fork-Läufe, fehlgeschlagene Workflows, unerwartete Images, falsche Revisionen oder ältere Releases ersetzen den gewünschten Stand nicht. Rollouts laufen in der angegebenen Reihenfolge und halten nach einem Fehler an. Bereits aktualisierte Container oder Anwendungsdaten werden nicht automatisch zurückgesetzt. Ein Publish-Lauf allein umgeht keine Freigaben. Containerdetails enthalten eigene Ansichten für Image-Quelle und Ausführungsrechte.

## Berechtigungen und Wiederherstellung

**Benutzer → Rollenberechtigungen** zeigt die tatsächlich serverseitig durchgesetzten Fähigkeiten. Owner-Verwaltung ist fest geschützt. Aktionen, Host-Zugriff, Container-Label und zusätzliche Ausführungsfreigaben gelten gemeinsam. Revision und Änderungsgrund verhindern stilles Überschreiben konkurrierender Änderungen. Ein Rechteentzug blockiert noch nicht begonnene Arbeit; bereits zugelassene Operationen laufen zu Ende.

Vor Upgrade alle Update-Jobs abschließen/abbrechen und `tools/backup.sh` verwenden. Format 2 umfasst CUO-Daten sowie optional Zot-Blobs und Konfiguration, offline und ohne fremde Workload-Volumes. `tools/backup-key.sh` sichert Installationsschlüssel und Bootstrap-Zugänge **getrennt**. Beide Archive enthalten Geheimnisse und sind unverschlüsselt; getrennte geschützte Aufbewahrung ist nötig. Maximal 16 GiB / 100.000 Einträge pro Datenarchiv.

Auf einem Ersatzhost dieselbe Quelle, `.env`, Profile, CA-/Ingress-Einstellungen und separate Secret-Dateien wiederherstellen; UID 10001 und Dateirechte 0600 für Core-Secrets erhalten. Zielvolumes und bei Registry-Backups das Zot-Profil vor Restore anlegen. Danach `tools/restore.sh` ausführen. Ein fehlender/falscher Schlüssel verhindert den Core-Start. Alte Drei-Volume-Backups bleiben gültig. Für einen Downgrade die vor 0.2 gesicherten Daten plus passende 0.1-Images verwenden; niemals ein altes Binary gegen Schema 2 starten.

## Mobile Eingabefelder

Auf kleinen Viewports und Touch-Geräten verwenden native Textfelder, Textbereiche und Auswahllisten mindestens 16 px, auch innerhalb der Custom-Komponenten. Das vermindert den automatischen Fokus-Zoom und die damit verbundenen Ansichtsverschiebungen unter iOS. Die Vergrößerung durch den Benutzer und das notwendige Scrollen bei geöffneter Tastatur werden nicht gesperrt.
