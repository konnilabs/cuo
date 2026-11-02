# ADR-002: UniOCI als universelle OCI-Grenze

Status: umgesetzt für den lokalen 0.2.0-Entwicklungsstand. Datum: 2026-11-02.

CUO kapselt ORAS Go v2.7.0 hinter `internal/unioci`. OCI-Transport, Referenzparser, Authentifizierung, Manifest-/Plattformauflösung, Tags, Katalog und Referrers werden von Core und Agent gemeinsam benutzt. Provider `oci`, `ghcr` und `zot` erhalten keine organisationsspezifische Logik. Ein fehlender Katalog wird durch explizite Repository-Freigaben ersetzt; ein fehlender Nachweis ist kein positiver Verifikationsstatus.

Verbindungen besitzen kanonischen Docker-Host, getrennten API-Origin, Repository-Grenzen und zugelassene Auth-/Blob-Hosts. HTTPS und normale Zertifikatsprüfung sind verbindlich. Eine eigene CA gilt für CUOs Metadatenclient; Docker benötigt zusätzlich sein eigenes CA-Vertrauen. LAN-Ziele benötigen eine ausdrückliche Freigabe. DNS wird bei jeder Verbindung geprüft und auf die geprüfte IP gebunden. Link-local/Metadaten-Ziele bleiben gesperrt. HTTP ist ausschließlich am installationsseitig festgelegten lokalen Zot-Origin möglich.

Pull- und Push-Zugangsdaten sind getrennt. Der Agent erhält ausschließlich den zweckgebundenen, bis zu zwei Minuten gültigen Pull-Umschlag im authentifizierten internen Request. Er gehört nicht zum persistierten Operationsmodell. Docker erhält `X-Registry-Auth`. Nach Zulassung läuft eine Operation mit ihrer Entscheidung weiter; neue oder wartende Arbeit prüft Rechte und Verbindungen erneut.

Importe übernehmen dieselben unveränderlichen Digests und Referenzartefakte. Ein Copy-Worker, zwei parallele Blob-Transfers, zehn Minuten Auftragsfrist und höchstens 2 GiB / 10.000 eindeutige Deskriptoren begrenzen die Arbeit. Kein Rebuild und keine stillschweigende Formatkonvertierung. Zot erhält `http.compat: [docker2s2]`, damit Docker-Manifeste ihren Digest behalten. Automatische Löschung ist deaktiviert; die Retention-Ansicht zeigt geschützte Digests und erhebt keinen Anspruch, externe Verbraucher zu kennen.

Konsequenz: konfigurierte Endpunkte müssen aus CUO und aus der Docker Engine erreichbar sein. Lokales Zot verwendet innen `http://zot:5000`, gegenüber der lokalen Engine `localhost:5055`. Externe CI benötigt einen gesonderten HTTPS-Ingress. Registry-Signaturen und Provenance werden als Referenzartefakte angezeigt; ihre kryptografische Verifikation wird ausdrücklich nicht behauptet. Das bleibt eine offene Release-Grenze, keine durch ein UI-Häkchen vorgetäuschte Funktion.
