# API-Vertrag (OpenAPI)

[`openapi.yaml`](openapi.yaml) beschreibt das HTTP-API unter `/api/*` (OpenAPI 3.1, ADR-0008/0010): alle Routen, Request-Bodies, Statuscodes, JSON-Formen und das Session-Cookie `fma_session`. Es ist der Vertrag zwischen der PWA (und späteren nativen Clients) und dem Backend `apps/server-php` ([ADR-0013](../adr/0013-php-backend.md)). Ein zweites Backend gibt es nicht mehr: das frühere Node-Backend (`apps/api`, `apps/worker`) wurde mit #110 entfernt.

- **Quelle sind die Teile in [`parts/`](parts/)** (`_base.yaml` mit gemeinsamen Komponenten, je Bereich eine Datei). `openapi.yaml` wird daraus erzeugt – nicht von Hand ändern:
  ```bash
  node packages/contract-tests/scripts/build-openapi.mjs
  ```
- `pnpm test` prüft (ohne PHP und ohne Datenbank), dass `openapi.yaml` aktuell ist, alle `$ref` aufgelöst werden und die Spezifikation **genau** die Slim-Routen aus `apps/server-php/src` enthält (`packages/contract-tests/test/routes.test.ts`). Eine neue Route braucht also immer auch ihren Eintrag in `parts/`.
- Linter: `npx @redocly/cli lint docs/api/openapi.yaml`

## Contract-Tests über HTTP

`packages/contract-tests` ruft ein laufendes Backend über HTTP auf (`API_URL`) und prüft jede JSON-Antwort gegen die Spezifikation. Testdaten entstehen nur über die API (Ersteinrichtung mit dem Setup-Code `SETUP_TOKEN`). Ohne `API_URL` werden die HTTP-Tests übersprungen.

| Variable                 | Standard               | Zweck                                                                       |
| ------------------------ | ---------------------- | --------------------------------------------------------------------------- |
| `API_URL`                | –                      | Basis-URL des Backends, z. B. `http://127.0.0.1:3102`                       |
| `SETUP_TOKEN`            | `e2e-setup-code`       | Setup-Code des Backends (muss dort ebenso gesetzt sein)                     |
| `CONTRACT_EMAIL`         | `contract@example.org` | Benutzer, den die Tests anlegen bzw. mit dem sie sich anmelden              |
| `CONTRACT_PASSWORD`      | `contract-password-1`  | dessen Passwort                                                             |
| `CONTRACT_METRICS_TOKEN` | leer                   | gesetzt = `/api/metrics` mit diesem Token prüfen, leer = muss 404 antworten |

Jeder Test-Client schickt eine eigene `X-Forwarded-For`-Adresse; das Backend vertraut ihr nur von einer Loopback-/privaten Adresse. So stören sich Rate-Limit- und Lockout-Tests nicht gegenseitig. Das Backend muss deshalb direkt (ohne fremden Proxy) auf `127.0.0.1` laufen und eine **Wegwerf-Datenbank** (MySQL 8 / MariaDB 10.6+) nutzen.

```bash
# Backend mit leerer Wegwerf-Datenbank starten (composer install in apps/server-php vorausgesetzt)
export DATABASE_URL=mysql://fma:fma@127.0.0.1:3306/fma_contract
export MASTER_KEY=$(openssl rand -base64 32) SETUP_TOKEN=e2e-setup-code MAIL_DATA_DIR=$(mktemp -d)
php apps/server-php/bin/migrate.php
PHP_CLI_SERVER_WORKERS=4 php -S 127.0.0.1:3102 -t apps/server-php/public apps/server-php/public/index.php &

# Contract-Tests
API_URL=http://127.0.0.1:3102 pnpm --filter @fma/contract-tests test
```

## Browser-Tests (Playwright)

`pnpm --filter @fma/e2e e2e` startet über `e2e/stack.mjs` den kompletten Stack: es leert die Datenbank aus `DATABASE_URL` (bzw. `E2E_DATABASE_URL`; **alle Tabellen werden gelöscht**), startet das PHP-Backend (`bin/migrate.php`, dann `php -S` für die API und `bin/worker.php` als Dauer-Worker inkl. IMAP IDLE) und liefert die gebaute PWA mit `/api`-Proxy aus. Voraussetzungen: `pnpm build`, `composer install` in `apps/server-php` und ein erreichbares GreenMail.

```bash
DATABASE_URL=mysql://fma:fma@127.0.0.1:3306/fma_e2e \
GREENMAIL_HOST=127.0.0.1 pnpm --filter @fma/e2e e2e
```

Optional überschreiben `API_CMD` und `WORKER_CMD` die Startbefehle (je per `sh -c` aus dem Repo-Wurzelverzeichnis; die API bekommt `HOST`/`PORT`, `WORKER_CMD=''` startet keinen Worker) und `DB_RESET_CMD` das Leeren der Datenbank. Mit `E2E_BASE_URL` laufen die Tests gegen einen bereits laufenden Stack.
