# PHP-Backend (`apps/server-php`)

Neues Backend nach [ADR-0013](../../docs/adr/0013-php-backend.md): PHP ≥ 8.2, Slim 4, MySQL 8 / MariaDB 10.6+. Es entsteht parallel zu `apps/api` und `apps/worker` und spricht dasselbe HTTP-API unter `/api/*`, damit die PWA unverändert bleibt (Epic #94). **Noch nicht produktiv nutzbar** – portiert sind Grundgerüst, Verschlüsselung, Schema, Auth, Konten/Identitäten, Lese-API inkl. Suche, Mail-Sync (`folder_sync`, `message_sync`, `message_action`), Web Push, Aufräumen/Export, Job-Queue mit Cron, Backup/Restore und der PostgreSQL-Import. Es fehlen u. a. Senden/Entwürfe (#105), IMAP IDLE im Dauer-Worker und die Umstellung (#110); Stand je Issue: [`ROADMAP.md`](../../ROADMAP.md).

## Aufbau

| Pfad                 | Inhalt                                                                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `public/`            | Einziger Ordner im Webroot: `index.php` (Front-Controller) und `.htaccess` (Apache)                                                    |
| `src/`               | Code, Namespace `Fma\` (PSR-4)                                                                                                         |
| `src/Crypto/`        | Envelope-Encryption und Backup-Stream, byte-kompatibel zu `packages/crypto`                                                            |
| `src/Security/`      | Client-IP hinter Proxy, Rate-Limits und Login-Lockout (in der Datenbank)                                                               |
| `src/Http/`          | Middleware (Sicherheitsheader, CSRF, Rate-Limit, Request-Log), Fehlerbehandlung                                                        |
| `migrations/`        | SQL-Migrationen für MySQL/MariaDB (Abbildung der PostgreSQL-Typen: `docs/architecture/data-model.md`), `bin/migrate.php` wendet sie an |
| `config.example.php` | Vorlage für `config.php` (Hoster ohne Umgebungsvariablen), liegt **außerhalb** von `public/`                                           |

## Konfiguration

Variablen wie in [`docs/operations/configuration.md`](../../docs/operations/configuration.md). Quelle in dieser Reihenfolge:

1. Umgebungsvariablen (auch Apache `SetEnv`),
2. `config.php` neben `public/` (oder Pfad in `FMA_CONFIG`) – Vorlage `config.example.php`, Rechte `0600`, nie committen.

Datenbank: `DATABASE_URL=mysql://user:passwort@host:3306/datenbank` oder `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`.

## Ersteinrichtung

Solange kein Benutzer existiert, verlangt `POST /api/auth/setup` einen Setup-Code: `SETUP_TOKEN` aus der Konfiguration oder – ohne diesen – ein zufälliger Code, der beim ersten Aufruf der App einmal ins PHP-Fehlerlog geschrieben wird. Wer das Log nicht lesen kann, erzeugt einen neuen Code mit `php bin/setup-code.php`. Gespeichert wird nur sein SHA-256.

## Einrichtungs-Check

`php bin/check.php` prüft PHP-Version, Extensions (Pflicht: openssl, pdo_mysql, mbstring, json, hash, iconv; Argon2id), `MASTER_KEY` (gesetzt und gültig, Wert wird nie ausgegeben), Datenbankversion (MySQL ≥ 8.0.1 / MariaDB ≥ 10.6 wegen `SKIP LOCKED`), Schreibrechte für `MAIL_DATA_DIR` und – als Warnung – ausgehende Verbindungen zu IMAP 993 / SMTP 465/587. Exit-Code 0, wenn alle Pflichtprüfungen bestehen. Die Browser-Variante für Webspace ohne Shell folgt mit dem Installer (#109).

## Docker (Vorschau)

`Dockerfile` baut ein PHP-FPM-Image (Kontext `apps/server-php`), das beim Start migriert; derselbe Container startet mit `php bin/worker.php` den Dauer-Worker. Die Compose-Einbindung (caddy → php-fpm per FastCGI, MariaDB) folgt mit #109/#110.

## Hintergrundjobs (Cron)

Ein Runner arbeitet die `job`-Tabelle ab (ADR-0013); es läuft immer nur einer (`GET_LOCK`), Jobs laufen nacheinander. Nur Job-Typen mit portiertem Handler werden abgeholt, alle anderen bleiben in der Warteschlange.

| Weg                | Aufruf                                                                                                          |
| ------------------ | --------------------------------------------------------------------------------------------------------------- |
| Cron (Standard)    | `* * * * * php /pfad/zu/apps/server-php/bin/cron.php` (jede Minute)                                             |
| Web-Cron (nur URL) | `https://…/cron.php` mit `Authorization: Bearer <CRON_TOKEN>` oder `?token=<CRON_TOKEN>`; ohne `CRON_TOKEN` 404 |
| Dauer-Worker (VPS) | `php bin/worker.php` – Schleife statt Cron, Heartbeat-Datei `WORKER_HEARTBEAT_FILE`                             |

| Variable                   | Standard | Zweck                                                                                        |
| -------------------------- | -------- | -------------------------------------------------------------------------------------------- |
| `CRON_TIME_BUDGET_SECONDS` | `50`     | Laufzeit je Cron-Aufruf; neue Jobs starten nur mit ≥ 5 s Rest. Unter dem Hoster-Limit halten |
| `CRON_TOKEN`               | leer     | Geheimnis für den Web-Cron (`public/cron.php`); leer = Web-Cron aus                          |

## Entwicklung

```bash
cd apps/server-php
composer install
php bin/migrate.php                                   # braucht DATABASE_URL
php -S 127.0.0.1:3001 -t public public/index.php      # Dev-Server
```

| Befehl                            | Wirkung                                                           |
| --------------------------------- | ----------------------------------------------------------------- |
| `composer test`                   | Unit-Tests (ohne Datenbank, läuft in der GitHub-CI)               |
| `composer test:integration`       | Tests gegen MySQL/MariaDB; `DATABASE_URL` auf eine **Wegwerf**-DB |
| `composer analyse`                | PHPStan (Level 8)                                                 |
| `composer cs` / `composer cs:fix` | PHP-CS-Fixer (PER-CS 2.0) prüfen / anwenden                       |

Unter Apache zeigt der DocumentRoot auf `public/` (`AllowOverride All` für die `.htaccess`). Die `.htaccess` im Paketordner sperrt alles, falls der ganze Ordner versehentlich im Webroot liegt.

## Verschlüsselung: Testvektoren Node ↔ PHP

`tests/fixtures/crypto-vectors-node.json` (von Node erzeugt) entschlüsselt der PHP-Test, `crypto-vectors-php.json` (von PHP erzeugt) der Node-Test `packages/crypto/test/php-compat.test.ts`. Neu erzeugen, wenn sich das Format ändert:

```bash
FMA_WRITE_VECTORS=1 pnpm --filter @fma/crypto exec vitest run test/php-compat.test.ts
php apps/server-php/tests/fixtures/generate-php-vectors.php
```

Die Vektoren nutzen feste Wegwerf-Schlüssel und enthalten keine echten Daten.
