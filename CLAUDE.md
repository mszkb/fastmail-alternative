# CLAUDE.md

Leitfaden für Claude Code (und andere Agents) in diesem Repository.

## Projekt in einem Satz

Self-hosted Multi-Account-Mail-Client: bündelt bestehende IMAP-/SMTP-Konten in einer schnellen, gut aussehenden Oberfläche mit getrennten Konten und Kontowechsel (Unified Inbox nur optional) – zuerst als PWA mit Web Push (inkl. iOS), langfristig mit nativer iOS-App.

## Status

Phase 0 (Discovery), ADRs entschieden. Aktuelle Planung: [`ROADMAP.md`](ROADMAP.md). Detaildokumentation: [`docs/`](docs/README.md).

## Wo steht was

| Thema                      | Datei                                   |
| -------------------------- | --------------------------------------- |
| Phasen, Milestones, Epics  | `ROADMAP.md`                            |
| Vision, Zielgruppen, Scope | `docs/product/vision.md`                |
| Offene Produktfragen       | `docs/product/offene-fragen.md`         |
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

- Frontend: Nuxt/Vue PWA, Service Worker, IndexedDB-Cache, offline-first (ADR-0008, ADR-0010); Styling Tailwind + daisyUI (ADR-0014)
- Backend: PHP ≥ 8.2 mit Slim 4 in `apps/server-php`, API (php-fpm) und Worker (`bin/worker.php` mit IMAP IDLE oder `bin/cron.php`) (ADR-0013)
- API-Vertrag: OpenAPI (`docs/api/openapi.yaml`), Basis für spätere native Clients (ADR-0010)
- Datenbank: MySQL 8 / MariaDB 10.6+ (ADR-0013)
- Queue: eigene `job`-Tabelle mit `SKIP LOCKED` (ADR-0003, ADR-0013)
- Mail-Speicher: Server speichert alle Mails, verschlüsselt im Volume `mail-data` (ADR-0001)
- Suche: IMAP `SEARCH` beim Provider (ADR-0006)
- Auth: Single-User, Passwort, serverseitige Sessions (ADR-0004); Mailanbieter per Passwort oder OAuth2 (ADR-0011)
- Worker: IMAP-Sync, SMTP-Versand, Push, Cleanup
- Deployment: Docker Compose mit Caddy (TLS), Konfiguration über `.env` (ADR-0007); alternativ Shared Hosting mit PHP + MySQL und Cron (ADR-0013)

Das frühere Node-Backend (Fastify, PostgreSQL) ist mit #110 entfernt; `apps/server-php/bin/import-postgres.php` bleibt nur für den einmaligen Umzug alter Installationen.

## Autonomer Agent

Issues mit dem Label `ready` arbeitet ein lokaler Runner autonom ab (Ablauf, Labels, Grenzen: [`docs/process/autonomous-agent.md`](docs/process/autonomous-agent.md)).

- Für dieses Repo ist der Zugriff auf GitHub per `gh` erlaubt (Issues lesen/anlegen, Labels, Kommentare, PRs) – Ausnahme zur globalen Regel „kein Zugriff auf Repo-Hosting-APIs“.
- Im Agent-Lauf (Branch `agent/issue-<n>`): nur committen, nie pushen oder Labels ändern. Bei Unklarheit Rückfrage in `QUESTION.md` statt raten; Abschlussbericht in `REPORT.md`. Beide Dateien nie committen.

## Befehle

Voraussetzung: Node ≥ 24.11 und pnpm ≥ 12 (PWA, Tests; `npm i -g pnpm` oder Corepack), PHP ≥ 8.2 mit `pdo_mysql` und Composer (Backend).

| Befehl                                    | Wirkung                                                         |
| ----------------------------------------- | --------------------------------------------------------------- |
| `pnpm install`                            | JS-Abhängigkeiten installieren                                  |
| `pnpm lint` / `pnpm format`               | ESLint / Prettier (nur prüfen: `pnpm format:check`)             |
| `pnpm typecheck`                          | TypeScript-Check über alle Pakete (web via vue-tsc)             |
| `pnpm test`                               | Tests (Vitest) über alle Pakete                                 |
| `pnpm build`                              | PWA bauen (statische Dateien)                                   |
| `pnpm dev:web` / `dev:api` / `dev:worker` | Dev-Server der PWA / PHP-API (`php -S`, Port 3001) / PHP-Worker |
| `composer install` (in `apps/server-php`) | PHP-Abhängigkeiten installieren                                 |
| `composer cs` / `analyse` / `test`        | PHP-CS-Fixer / PHPStan / PHPUnit (Unit-Tests)                   |
| `composer test:integration`               | PHPUnit gegen MySQL/MariaDB (`DATABASE_URL`) und GreenMail      |
| `make check`                              | alles wie in CI, plus PHP-Integrationstests                     |

Struktur: `apps/web` (Nuxt-PWA), `apps/server-php` (Slim-API, Worker, Migrationen, Konsole), `packages/shared` (geteilte Typen/Domänenlogik der PWA), `packages/contract-tests` (OpenAPI-Contract-Tests über HTTP), `e2e` (Playwright) – JS-Scope `@fma/*`, wird als TS-Quelle ohne Build-Schritt konsumiert.

Deployment (ADR-0007, ADR-0013): `docker compose` mit caddy/web/php/worker/mariadb. Erstes Setup: `./scripts/setup-env.sh` (erzeugt `.env` mit `MASTER_KEY`, VAPID, DB-Passwort – `.env` nie committen, Key separat backupen!). Bestehende Installationen mit dem früheren Node-Backend ziehen einmalig mit `./scripts/migrate-to-php.sh` um. Ziel-Host: Raspberry Pi (Debian 13, rootless Docker, arm64) via `ssh raspberrypi` in `~/fastmail-alternative`.
