# Changelog

Alle nennenswerten Änderungen für Nutzer und Betreiber. Format nach [Keep a Changelog](https://keepachangelog.com/de/1.1.0/); Versionen folgen ab dem ersten Release [Semantic Versioning](https://semver.org/lang/de/) (Release-Images und Tags: Roadmap 7.2). Pflege: [docs/process/changelog.md](docs/process/changelog.md).

Einträge mit **Betreiber:** erfordern beim Upgrade Aufmerksamkeit (Migrationen, neue/geänderte `.env`-Variablen, Breaking Changes).

## [Unreleased]

Noch kein Release. Bisheriger Stand (Details in [ROADMAP.md](ROADMAP.md)):

### Added

- Self-hosted Deployment mit Docker Compose (caddy, web, api, worker, postgres), Healthchecks und `scripts/setup-env.mjs` für `MASTER_KEY`, VAPID-Schlüssel und DB-Passwort; läuft auf Raspberry Pi (arm64, rootless Docker)
- Single-User-Setup, Passwort-Login mit serverseitigen Sessions, Geräteverwaltung und Passwortänderung (beendet alle anderen Sitzungen)
- Mehrere IMAP-/SMTP-Konten mit Verbindungstest, getrennten Postfächern, Kontowechsel, Ungelesen-Zählern und Identitäten/Aliasen
- IMAP-Sync-Worker über eine Job-Tabelle in PostgreSQL, IMAP IDLE für den Posteingang, Ordner-Mapping per SPECIAL-USE, älteres Nachladen pro Ordner und Sync-Limit pro Konto (`sync_since`)
- Mail lesen mit sicherem HTML-Rendering (Sanitizing, Blockieren externer Inhalte), Threading und Basisaktionen (gelesen, markiert, archivieren, löschen, verschieben)
- Verfassen, Antworten, Weiterleiten, SMTP-Versand mit Kopie in „Gesendet“, serverseitige Entwürfe mit Autosave und IMAP-Drafts-Sync, Anhänge anzeigen, herunterladen und versenden
- Suche pro Konto über IMAP `SEARCH` beim Anbieter
- PWA mit Service Worker, Installationshinweisen (iOS, Android, Desktop), Web Push ohne Mailinhalte, App-Badge, Sync bei Start und Fokuswechsel, manueller Sync (Button und Pull-to-Refresh)
- Offline-first: verschlüsselter IndexedDB-Cache und Offline-Warteschlange für Aktionen
- Export der Serverkonfiguration, Speicherverbrauch pro Konto in den Einstellungen
- Verschlüsselte Backups mit Restore (inkl. nächtlichem Restore-Test), getesteter Upgrade-Pfad mit `scripts/upgrade.sh`
- Periodische Cleanup-Jobs für verwaiste Nachrichten, Dateien, Uploads und alte Jobs
- Strukturierte Logs, `/api/health` und optionale Prometheus-Metriken
- Lasttest-Harness `pnpm loadtest` (viele Konten, große Postfächer) mit Markdown-Bericht; Methode, erste Messwerte und Anleitung für den Raspberry Pi in [docs/operations/load-test.md](docs/operations/load-test.md)
- Optionaler gemeinsamer Posteingang aller Konten (Einstellungen → „Gemeinsamer Posteingang (alle Konten)“, standardmäßig aus) mit Konto-Kennzeichen je Nachricht; Antworten immer aus dem Ursprungskonto. **Betreiber:** keine Migration nötig (die Spalte `user.unified_inbox_enabled` existiert seit Migration 0001, Default aus); neue API-Routen `GET/PUT /api/settings` und `GET /api/unified/inbox`
- Betreiber-Doku (Installation, Konfiguration, Backup, Upgrade, Troubleshooting), Issue-Templates und Security-Policy
- Release-Prozess nach SemVer: Tags `vX.Y.Z` erzeugen signierte Multi-Arch-Images (amd64, arm64) für api, worker und web in der GitHub Container Registry; Signaturprüfung mit `cosign verify`; `/api/health` meldet die Release-Version ([Release-Prozess](docs/process/release.md), #62)
- **Betreiber:** Optional `docker-compose.release.yml` (mit `FMA_VERSION`, optional `FMA_IMAGE_PREFIX`) für fertige Images statt lokalem Build; der lokale Build bleibt Standard, keine `.env`-Änderung nötig

- Browser-Tests mit Playwright (`e2e/`, #74): Ersteinrichtung, Login, Konto anlegen, Lesen mit Inline-Bild und Anhang, Entwurf mit Anhang, Weiterleiten, `sync_since`, Speicheranzeige, gemeinsamer Posteingang, Aktualisieren, Pull-to-Refresh, Swipe-Back und Passwortwechsel im Handy-Viewport mit Touch; `e2e/stack.mjs` startet api, worker und web lokal aus dem Build. `Makefile` mit Kurzbefehlen für Betrieb und Tests; läuft in CI als eigener Job „Browser tests (Playwright)“ gegen PostgreSQL und GreenMail (Report und Traces bei Fehlschlag als Artifact)
- Doku: [Mailanbieter und Kompatibilitätsmatrix](docs/product/mail-providers.md) (#18), [UX-Flows](docs/product/ux-flows.md) (#19), [offene Produktfragen](docs/product/offene-fragen.md) und Entwurf [ADR-0012 Anonyme Nutzungsstatistik (Opt-in)](docs/adr/0012-usage-telemetry.md) (#78, Status Proposed)
- **Betreiber:** `POSTGRES_HOST_PORT` (optional, Standard `5432`) verschiebt den Wartungsport von PostgreSQL auf `127.0.0.1`, falls auf dem Host schon eine PostgreSQL-Instanz läuft

### Changed

- **Betreiber:** Der Worker hat jetzt einen Docker-Healthcheck (Heartbeat-Datei, aktualisiert alle 30 s nach erfolgreichem Datenbankzugriff; `unhealthy` ab 120 s ohne Heartbeat). `docker compose up --wait` und `scripts/upgrade.sh` warten damit auch auf den Worker; keine `.env`-Änderung nötig
- **Betreiber:** `scripts/upgrade.sh` bricht vor dem Backup ab, wenn untracked Dateien mit Dateien des Ziels kollidieren (vorher scheiterte erst `git checkout`), und bei Release-Images (`COMPOSE_FILE` mit `docker-compose.release.yml`) mit Hinweis auf den händischen Ablauf. Nach dem Upgrade entfernt es nur noch unbenannte Images des eigenen Compose-Projekts statt aller ungenutzten Images des Docker-Hosts
- **Betreiber:** Release-Images lassen sich dauerhaft per `COMPOSE_FILE=docker-compose.yml:docker-compose.release.yml` und `FMA_VERSION` in der `.env` einschalten (auskommentiert in `.env.example`); eine eigene `docker-compose.override.yml` muss dann in `COMPOSE_FILE` angehängt werden. Upgrade-Doku ergänzt: erstes Upgrade von Versionen ohne `scripts/upgrade.sh` (Skript nach `.upgrade-bootstrap/`), ältere Versionen ohne Worker-Healthcheck, detached HEAD nach Rollback, `UPGRADE_TARGET` im händischen Ablauf
- Fehlerisolierung pro Konto: Circuit Breaker, Verbindungslimit pro IMAP-Host, Sync-Debounce und Backoff bei Drosselung durch den Anbieter
- Inkrementeller Flag-Abgleich per CONDSTORE (RFC 7162, #28): Server mit CONDSTORE liefern nur noch seit dem letzten Lauf geänderte Flags (`CHANGEDSINCE`), bei unverändertem HIGHESTMODSEQ entfällt der Flag-Abgleich ganz; ohne CONDSTORE bisheriges Verhalten. **Betreiber:** keine Migration nötig (nutzt die bestehende Spalte `folder.highestmodseq`), keine `.env`-Änderung
- Weiterleiten übernimmt eingebettete Bilder (cid:, PNG/JPEG/GIF/WebP) der Originalmail als normale Anhänge, da die Weiterleitung als Text versendet wird; SVG/HTML-Inline-Teile werden nicht übernommen, Größen- und Anzahlgrenzen gelten wie bisher (#53)

### Fixed

- `backup.js` (`create`, `verify`, `restore`) meldet einen fehlenden oder ungültigen `MASTER_KEY` jetzt vorab und verständlich (`MASTER_KEY is invalid: expected 32 bytes, base64-encoded …`, ohne Key-Inhalt) statt nur `backup failed: Error`
- Die Anhangsliste im Verfassen-Dialog hatte keinen Innenabstand und klebte am linken Rand
- Ein neu verbundenes Konto zeigte keine Ordner („Noch keine Ordner synchronisiert“), bis die Seite neu geladen wurde, wenn es während des ersten Abgleichs geöffnet wurde; außerdem bemerkt die App das Ende des ersten Abgleichs eines neu hinzugefügten oder importierten Kontos jetzt binnen Sekunden statt erst beim nächsten 60-s-Kontenabgleich
- Beim Verfassen erschien „Entwurf gespeichert“ nie, und Schließen speicherte einen unveränderten Entwurf erneut
- **Betreiber:** Restore-Anleitung startete den Worker sofort und verschickte dabei ungesendete Postausgangs-Einträge aus dem Backup ohne Prüfung; jetzt erst ohne Worker starten und den Postausgang prüfen ([Backup & Restore](docs/operations/backup-restore.md#restore-auf-einer-frischen-instanz)). Installations-, Konfigurations- und Upgrade-Doku nach einem Testlauf korrigiert ([Testbericht](docs/operations/test-report-2026-10-05.md))

### Security

- ASVS-Review (#56), letzte Punkte: Mail-Verbindungen nur noch auf Standard-Ports (IMAP 143/993, SMTP 25/465/587/2525), damit ein Konto nicht als Port-Scanner dient; neuer Fehlercode `BLOCKED_PORT`. **Betreiber:** Konten auf anderen Ports schlagen nun fehl – Port umstellen oder in `.env` per `MAIL_EXTRA_PORTS=1143,10465` freigeben (neu, optional, an api und worker durchgereicht)
- **Betreiber:** Neue optionale Variable `COOKIE_SECURE` (`1`/`0`) für das `Secure`-Flag des Session-Cookies, z. B. `1` hinter einem eigenen TLS-Proxy vor caddy mit `DOMAIN=:80`
- `pnpm audit --prod --audit-level=high` läuft in CI und blockiert bei neuen Lücken; ungepatchte Advisories der Nuxt-Werkzeuge, die nie in ein Runtime-Image gelangen, sind begründet ausgenommen (`pnpm-workspace.yaml`): `node-forge` (GHSA-86w9-cpqp-85rv), `braces` (GHSA-vfj7-8cjw-p6xm) und `simple-git` über `@nuxt/devtools` (GHSA-x6jw-m9v5-85vh, GHSA-v5rq-49vh-5v5c, GHSA-858h-whjf-mvg5, GHSA-g4wm-2vf7-vfgr)
- Envelope-Encryption (AES-256-GCM, Schlüssel pro Konto) für Zugangsdaten und alle lesbaren Mailinhalte at rest; Master-Key nur aus der Umgebung
- Logs, Fehlermeldungen und Push-Payloads ohne Mailinhalte, Adressen, Zugangsdaten oder Fehlertexte der Anbieter
- Rate Limits, CSRF-Origin-Prüfung, Session-Härtung, Security-Header/CSP, Login-Lockout
- SSRF-Schutz bei Kontoverbindungen, Härtung der Uploads gegen Speicher-DoS, Anhänge in Sandbox ausgeliefert
- ASVS-Review (#56): STARTTLS ist auf IMAP-/SMTP-Ports ohne implizites TLS jetzt Pflicht – ohne STARTTLS wird vor der Anmeldung abgebrochen (neuer Fehlercode `TLS_REQUIRED`), kein Passwort mehr im Klartext bei Downgrade-Angriffen. **Betreiber:** Konten bei Anbietern ohne STARTTLS auf Port 143/587 schlagen nun fehl; auf 993/465 umstellen
- SSRF-Schutz normalisiert IPv6-Literale vollständig (IPv4-mapped/-compatible, NAT64, 6to4 in jeder Schreibweise) und verbindet mit der geprüften Adresse statt erneut aufzulösen (DNS-Rebinding)
- AES-GCM-Entschlüsselung erzwingt 16-Byte-Tags; Metrics-Token wird in konstanter Zeit verglichen; Verbindungstest loggt nur Fehlercodes und gibt keine Servertexte mehr zurück
- Ersteinrichtung verlangt einen Setup-Code; parallele Setup-Anfragen können keinen zweiten Benutzer mehr anlegen. **Betreiber:** Bei einer neuen Instanz steht der Code im Log (`docker compose logs api | grep "FIRST-RUN SETUP CODE"`), alternativ `SETUP_TOKEN` in `.env` vorgeben (optional). Bestehende Instanzen mit Benutzer sind nicht betroffen
- Zentraler Error-Handler: Fehlerantworten enthalten keine internen Meldungen mehr, ungültige IDs/Feldtypen ergeben 400/404 statt 500; fehlgeschlagene Logins und Passwortwechsel werden als Security-Event geloggt (ohne E-Mail, Passwort, IP)
- `MAIL_ALLOW_PRIVATE_HOSTS` erlaubt nur noch private/LAN-Mail-Hosts; STARTTLS-Pflicht und Zertifikatsprüfung bleiben dabei aktiv. Klartext ohne TLS gibt es nur noch mit dem neuen Entwicklungs-/Testschalter `MAIL_INSECURE_TRANSPORT=1` (niemals produktiv). **Betreiber:** Für einen eigenen Mailserver im LAN `MAIL_ALLOW_PRIVATE_HOSTS=1` in `.env` setzen (wird jetzt an api und worker durchgereicht); der Server braucht STARTTLS oder implizites TLS mit gültigem Zertifikat (#56, N7)
- Dependabot für npm, GitHub Actions und Docker; CI-Token nur mit Leserechten. Vollständiger Audit-Bericht: [docs/security/asvs-l2.md](docs/security/asvs-l2.md)
- Web Push verbindet mit der geprüften Adresse des Push-Dienstes statt erneut aufzulösen (DNS-Rebinding, ASVS N1)
