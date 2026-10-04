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

### Changed

- Fehlerisolierung pro Konto: Circuit Breaker, Verbindungslimit pro IMAP-Host, Sync-Debounce und Backoff bei Drosselung durch den Anbieter

### Security

- Envelope-Encryption (AES-256-GCM, Schlüssel pro Konto) für Zugangsdaten und alle lesbaren Mailinhalte at rest; Master-Key nur aus der Umgebung
- Logs, Fehlermeldungen und Push-Payloads ohne Mailinhalte, Adressen, Zugangsdaten oder Fehlertexte der Anbieter
- Rate Limits, CSRF-Origin-Prüfung, Session-Härtung, Security-Header/CSP, Login-Lockout
- SSRF-Schutz bei Kontoverbindungen, Härtung der Uploads gegen Speicher-DoS, Anhänge in Sandbox ausgeliefert
