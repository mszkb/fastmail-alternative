# CLAUDE.md

Leitfaden für Claude Code (und andere Agents) in diesem Repository.

## Projekt in einem Satz

Self-hosted Multi-Account-Mail-Client: bündelt bestehende IMAP-/SMTP-Konten in einer schnellen, gut aussehenden Unified Inbox – zuerst als PWA mit Web Push (inkl. iOS), langfristig mit nativer iOS-App.

## Status

Phase 0 (Discovery). Es gibt noch keinen Anwendungscode. Aktuelle Planung: [`ROADMAP.md`](ROADMAP.md). Detaildokumentation: [`docs/`](docs/README.md).

## Wo steht was

| Thema | Datei |
| --- | --- |
| Phasen, Milestones, Epics | `ROADMAP.md` |
| Vision, Zielgruppen, Scope | `docs/product/vision.md` |
| Architektur | `docs/architecture/overview.md` |
| Datenmodell (ER) | `docs/architecture/data-model.md` |
| Daten- & Sicherheitsmodell | `docs/architecture/security.md` |
| Push-Strategie | `docs/architecture/push.md` |
| Architekturentscheidungen | `docs/adr/` |
| Definition of Done | `docs/process/definition-of-done.md` |
| Externe Abhängigkeiten | `docs/process/external-dependencies.md` |

## Nicht verhandelbare Prinzipien

Diese Regeln gelten für jeden Code- und Doku-Beitrag:

1. **Self-hosted first.** Alles Grundlegende muss mit `docker compose up` auf einem eigenen Server laufen. Kein Feature darf eine Managed Cloud oder das Hosted Push Relay voraussetzen.
2. **Keine künstliche Paywall** für PWA, Export, Grundfunktionen oder eigene Instanz.
3. **Push ist nur ein Hinweis.** Push ist nie die Quelle der Wahrheit. Die App synchronisiert beim Start und bei Fokuswechsel.
4. **Keine Mailinhalte in Push-Payloads.** Nur Ereignistyp, Installations-ID, Badge-Zahl. Keine Betreffzeilen, Absender oder Bodies.
5. **Secrets nie im Klartext.** IMAP-/SMTP-Passwörter und OAuth-Tokens verschlüsselt at rest. Der Master-Key kommt ausschließlich aus Secret-Management/Umgebung – niemals ins Repo, in die DB oder in Logs.
6. **Keine sensiblen Daten in Logs**, Fehlermeldungen, Push-Payloads oder Support-Exports (Zugangsdaten, Mailinhalte, Betreffzeilen).
7. **Fehlerisolierung pro Konto.** Ein Konto mit ungültigen Zugangsdaten oder ausgefallenem Provider darf andere Konten nicht blockieren.

## Konventionen

- **Sprache:** Dokumentation auf Deutsch; Code, Bezeichner, Commit-Messages und Code-Kommentare auf Englisch.
- **Architekturentscheidungen** werden als ADR in `docs/adr/` festgehalten (Vorlage: `docs/adr/0000-template.md`). Eine Entscheidung, die eine ADR betrifft, nicht stillschweigend im Code ändern – erst die ADR aktualisieren oder ersetzen.
- **Roadmap pflegen:** Wird ein Epic begonnen/abgeschlossen, den Status in `ROADMAP.md` aktualisieren.
- **Scope:** Was in `docs/product/vision.md` unter „Bewusst nicht im MVP" steht, nicht ohne Rücksprache einbauen.
- **Definition of Done** (`docs/process/definition-of-done.md`) gilt für jeden PR.

## Geplanter Tech-Stack (vorläufig, siehe ADRs)

- Frontend: Nuxt/Vue PWA, Service Worker, IndexedDB-Cache
- Backend: Fastify (Node/TypeScript) **oder** .NET – offen, ADR-0008
- Datenbank: PostgreSQL
- Queue: Redis/Valkey oder PostgreSQL-basiert – offen, ADR-0003
- Object Storage: S3-kompatibel (optional)
- Worker: IMAP-Sync, SMTP-Versand, Indexierung, Cleanup als getrennte Prozesse
- Deployment: Docker Compose

Solange die ADRs auf „Proposed" stehen, keine Annahmen über Frameworks hart in Code gießen.

## Befehle

Noch keine. Sobald Phase 1 (Foundation) steht, hier Build-, Test-, Lint- und Dev-Befehle eintragen.
