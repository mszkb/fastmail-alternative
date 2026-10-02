# CLAUDE.md

Leitfaden für Claude Code (und andere Agents) in diesem Repository.

## Projekt in einem Satz

Self-hosted Multi-Account-Mail-Client: bündelt bestehende IMAP-/SMTP-Konten in einer schnellen, gut aussehenden Oberfläche mit getrennten Konten und Kontowechsel (Unified Inbox nur optional) – zuerst als PWA mit Web Push (inkl. iOS), langfristig mit nativer iOS-App.

## Status

Phase 0 (Discovery), ADRs entschieden. Es gibt noch keinen Anwendungscode. Aktuelle Planung: [`ROADMAP.md`](ROADMAP.md). Detaildokumentation: [`docs/`](docs/README.md).

## Wo steht was

| Thema                      | Datei                                   |
| -------------------------- | --------------------------------------- |
| Phasen, Milestones, Epics  | `ROADMAP.md`                            |
| Vision, Zielgruppen, Scope | `docs/product/vision.md`                |
| Architektur                | `docs/architecture/overview.md`         |
| Datenmodell (ER)           | `docs/architecture/data-model.md`       |
| Daten- & Sicherheitsmodell | `docs/architecture/security.md`         |
| Push-Strategie             | `docs/architecture/push.md`             |
| Architekturentscheidungen  | `docs/adr/`                             |
| Definition of Done         | `docs/process/definition-of-done.md`    |
| Externe Abhängigkeiten     | `docs/process/external-dependencies.md` |

## Nicht verhandelbare Prinzipien

Diese Regeln gelten für jeden Code- und Doku-Beitrag:

1. **Self-hosted first.** Alles Grundlegende muss mit `docker compose up` auf einem eigenen Server laufen. Kein Feature darf eine Managed Cloud oder das Hosted Push Relay voraussetzen.
2. **Keine künstliche Paywall** für PWA, Export, Grundfunktionen oder eigene Instanz.
3. **Push ist nur ein Hinweis.** Push ist nie die Quelle der Wahrheit. Die App synchronisiert beim Start und bei Fokuswechsel.
4. **Keine Mailinhalte in Push-Payloads.** Nur Ereignistyp, Installations-ID, Badge-Zahl. Keine Betreffzeilen, Absender oder Bodies.
5. **Secrets und Inhalte nie im Klartext.** IMAP-/SMTP-Passwörter, OAuth-Tokens und alle lesbaren Mailinhalte (Betreff, Adressen, Snippet, Body, Dateinamen) verschlüsselt at rest (siehe `docs/architecture/data-model.md`). Der Master-Key kommt ausschließlich aus Secret-Management/Umgebung – niemals ins Repo, in die DB oder in Logs.
6. **Keine sensiblen Daten in Logs**, Fehlermeldungen, Push-Payloads oder Support-Exports (Zugangsdaten, Mailinhalte, Betreffzeilen).
7. **Fehlerisolierung pro Konto.** Ein Konto mit ungültigen Zugangsdaten oder ausgefallenem Provider darf andere Konten nicht blockieren.
8. **Konten bleiben getrennt.** Standard ist der Kontowechsel; eine Unified Inbox ist optional und standardmäßig aus.
9. **So einfach wie möglich.** Erst die einfachste funktionierende Lösung (z. B. eine Job-Tabelle statt Queue-Service, IMAP `SEARCH` statt eigenem Suchindex).

## Konventionen

- **Sprache:** Dokumentation auf Deutsch; Code, Bezeichner, Commit-Messages und Code-Kommentare auf Englisch.
- **Architekturentscheidungen** werden als ADR in `docs/adr/` festgehalten (Vorlage: `docs/adr/0000-template.md`). Eine Entscheidung, die eine ADR betrifft, nicht stillschweigend im Code ändern – erst die ADR aktualisieren oder ersetzen.
- **Roadmap pflegen:** Wird ein Epic begonnen/abgeschlossen, den Status in `ROADMAP.md` aktualisieren.
- **Scope:** Was in `docs/product/vision.md` unter „Bewusst nicht im MVP" steht, nicht ohne Rücksprache einbauen.
- **Definition of Done** (`docs/process/definition-of-done.md`) gilt für jeden PR.

## Tech-Stack (entschieden, siehe ADRs)

- Frontend: Nuxt/Vue PWA, Service Worker, IndexedDB-Cache, offline-first (ADR-0008, ADR-0010)
- Backend: Fastify (Node/TypeScript) für API und Worker (ADR-0008)
- API-Vertrag: OpenAPI, Basis für spätere native Clients (ADR-0010)
- Datenbank: PostgreSQL (ADR-0002)
- Queue: eigene `job`-Tabelle in PostgreSQL mit `SKIP LOCKED` (ADR-0003)
- Mail-Speicher: Server speichert alle Mails, verschlüsselt im Docker-Volume `mail-data` (ADR-0001)
- Suche: IMAP `SEARCH` beim Provider (ADR-0006)
- Auth: Single-User, Passwort, serverseitige Sessions (ADR-0004); Mailanbieter per Passwort oder OAuth2 (ADR-0011)
- Worker: IMAP-Sync, SMTP-Versand, Push, Cleanup
- Deployment: Docker Compose mit Caddy (TLS), Konfiguration über `.env` (ADR-0007)

## Befehle

Voraussetzung: Node ≥ 24.11 und pnpm ≥ 12 (`npm i -g pnpm` oder Corepack).

| Befehl                                    | Wirkung                                             |
| ----------------------------------------- | --------------------------------------------------- |
| `pnpm install`                            | Abhängigkeiten installieren                         |
| `pnpm lint` / `pnpm format`               | ESLint / Prettier (nur prüfen: `pnpm format:check`) |
| `pnpm typecheck`                          | TypeScript-Check über alle Pakete (web via vue-tsc) |
| `pnpm test`                               | Tests (Vitest) über alle Pakete                     |
| `pnpm build`                              | Alle Apps bauen (web, api, worker)                  |
| `pnpm dev:web` / `dev:api` / `dev:worker` | Dev-Server der jeweiligen App                       |

Struktur: `apps/web` (Nuxt-PWA), `apps/api` (Fastify, Port 3001), `apps/worker` (Jobs), `packages/shared` (geteilte Typen/Domänenlogik), `packages/crypto` (Envelope-Encryption), `packages/db` (pg-Pool + Migration-Runner) – Scope `@fma/*`, wird als TS-Quelle ohne Build-Schritt konsumiert.

Deployment (ADR-0007): `docker compose` mit caddy/web/api/worker/postgres. Erstes Setup: `node scripts/setup-env.mjs` (erzeugt `.env` mit `MASTER_KEY`, VAPID, DB-Passwort – `.env` nie committen, Key separat backupen!). Ziel-Host: Raspberry Pi (Debian 13, rootless Docker, arm64) via `ssh raspberrypi` in `~/fastmail-alternative`.
