# API-Vertrag (OpenAPI)

[`openapi.yaml`](openapi.yaml) beschreibt das HTTP-API unter `/api/*` (OpenAPI 3.1, ADR-0008/0010): alle Routen, Request-Bodies, Statuscodes, JSON-Formen und das Session-Cookie `fma_session`. Es ist der Vertrag zwischen PWA, Node-Backend (`apps/api`) und PHP-Backend (`apps/server-php`, [ADR-0013](../adr/0013-php-backend.md)).

- **Quelle sind die Teile in [`parts/`](parts/)** (`_base.yaml` mit gemeinsamen Komponenten, je Bereich eine Datei). `openapi.yaml` wird daraus erzeugt – nicht von Hand ändern:
  ```bash
  node packages/contract-tests/scripts/build-openapi.mjs
  ```
- `pnpm test` prüft (ohne Backend), dass `openapi.yaml` aktuell ist, alle `$ref` aufgelöst werden und die Spezifikation **genau** die Routen von `apps/api` enthält.
- Linter: `npx @redocly/cli lint docs/api/openapi.yaml`

## Contract-Tests über HTTP

`packages/contract-tests` ruft ein laufendes Backend über HTTP auf (`API_URL`) und prüft jede JSON-Antwort gegen die Spezifikation. Testdaten entstehen nur über die API (Ersteinrichtung mit dem Setup-Code `SETUP_TOKEN`). Ohne `API_URL` werden die HTTP-Tests übersprungen.

| Variable                 | Standard               | Zweck                                                                       |
| ------------------------ | ---------------------- | --------------------------------------------------------------------------- |
| `API_URL`                | –                      | Basis-URL des Backends, z. B. `http://127.0.0.1:3101`                       |
| `SETUP_TOKEN`            | `e2e-setup-code`       | Setup-Code des Backends (muss dort ebenso gesetzt sein)                     |
| `CONTRACT_EMAIL`         | `contract@example.org` | Benutzer, den die Tests anlegen bzw. mit dem sie sich anmelden              |
| `CONTRACT_PASSWORD`      | `contract-password-1`  | dessen Passwort                                                             |
| `CONTRACT_METRICS_TOKEN` | leer                   | gesetzt = `/api/metrics` mit diesem Token prüfen, leer = muss 404 antworten |

Jeder Test-Client schickt eine eigene `X-Forwarded-For`-Adresse; beide Backends vertrauen ihr nur von einer Loopback-/privaten Adresse. So stören sich Rate-Limit- und Lockout-Tests nicht gegenseitig. Das Backend muss deshalb direkt (ohne fremden Proxy) auf `127.0.0.1` laufen und eine **Wegwerf-Datenbank** nutzen.

```bash
# Node-Backend (PostgreSQL)
API_URL=http://127.0.0.1:3101 pnpm --filter @fma/contract-tests test

# PHP-Backend: bisher nur das Grundgerüst (#97)
cd packages/contract-tests
API_URL=http://127.0.0.1:3102 npx vitest run test/system.test.ts test/csrf.test.ts test/rate-limit.test.ts
```

## Browser-Tests gegen ein anderes Backend

`e2e/stack.mjs` startet statt `apps/api`/`apps/worker` beliebige Befehle (`API_CMD`, `WORKER_CMD`, je per `sh -c` aus dem Repo-Wurzelverzeichnis; die API bekommt `HOST`/`PORT`). Eine Nicht-PostgreSQL-Datenbank braucht `DB_RESET_CMD`. Beispiel PHP:

```bash
DATABASE_URL=mysql://fma:fma@127.0.0.1:3306/fma_e2e \
DB_RESET_CMD='mysql -e "DROP DATABASE IF EXISTS fma_e2e; CREATE DATABASE fma_e2e"' \
API_CMD='php apps/server-php/bin/migrate.php && PHP_CLI_SERVER_WORKERS=4 exec php -S "$HOST:$PORT" -t apps/server-php/public apps/server-php/public/index.php' \
WORKER_CMD='sleep 3; exec php apps/server-php/bin/worker.php' \
GREENMAIL_HOST=127.0.0.1 pnpm --filter @fma/e2e e2e
```

Stand 2026-10-06: alle 12 Playwright-Tests grün gegen PHP-API, PHP-Worker (inkl. IMAP IDLE) und MariaDB 10.11 sowie MySQL 8.0 – die PWA läuft unverändert. `sleep 3` lässt die Migrationen der API vor dem Worker laufen.
