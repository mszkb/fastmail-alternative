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
- Verschlüsselte Backups mit Restore (inkl. Restore-Test in CI), getesteter Upgrade-Pfad mit `scripts/upgrade.sh`
- Periodische Cleanup-Jobs für verwaiste Nachrichten, Dateien, Uploads und alte Jobs
- Strukturierte Logs, `/api/health` und optionale Prometheus-Metriken
- Betreiber-Doku (Installation, Konfiguration, Backup, Upgrade, Troubleshooting), Issue-Templates und Security-Policy
- Release-Prozess nach SemVer: Tags `vX.Y.Z` erzeugen signierte Multi-Arch-Images (amd64, arm64) für api, worker und web in der GitHub Container Registry; Signaturprüfung mit `cosign verify`; `/api/health` meldet die Release-Version ([Release-Prozess](docs/process/release.md), #62)
- **Betreiber:** Optional `docker-compose.release.yml` (mit `FMA_VERSION`, optional `FMA_IMAGE_PREFIX`) für fertige Images statt lokalem Build; der lokale Build bleibt Standard, keine `.env`-Änderung nötig

### Changed

- **Betreiber:** Der Worker hat jetzt einen Docker-Healthcheck (Heartbeat-Datei, aktualisiert alle 30 s nach erfolgreichem Datenbankzugriff; `unhealthy` ab 120 s ohne Heartbeat). `docker compose up --wait` und `scripts/upgrade.sh` warten damit auch auf den Worker; keine `.env`-Änderung nötig
- Fehlerisolierung pro Konto: Circuit Breaker, Verbindungslimit pro IMAP-Host, Sync-Debounce und Backoff bei Drosselung durch den Anbieter
- Inkrementeller Flag-Abgleich per CONDSTORE (RFC 7162, #28): Server mit CONDSTORE liefern nur noch seit dem letzten Lauf geänderte Flags (`CHANGEDSINCE`), bei unverändertem HIGHESTMODSEQ entfällt der Flag-Abgleich ganz; ohne CONDSTORE bisheriges Verhalten. **Betreiber:** keine Migration nötig (nutzt die bestehende Spalte `folder.highestmodseq`), keine `.env`-Änderung
- Weiterleiten übernimmt eingebettete Bilder (cid:, PNG/JPEG/GIF/WebP) der Originalmail als normale Anhänge, da die Weiterleitung als Text versendet wird; SVG/HTML-Inline-Teile werden nicht übernommen, Größen- und Anzahlgrenzen gelten wie bisher (#53)

### Security

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
