# PHP-Backend (`apps/server-php`)

Neues Backend nach [ADR-0013](../../docs/adr/0013-php-backend.md): PHP ≥ 8.2, Slim 4, MySQL 8 / MariaDB 10.6+. Es entsteht parallel zu `apps/api` und `apps/worker` und spricht dasselbe HTTP-API unter `/api/*`, damit die PWA unverändert bleibt (Epic #94). **Noch nicht produktiv nutzbar** – bisher: Grundgerüst (#97), Verschlüsselung (#99), Datenbankschema (#98) und `/api/auth/*` (#100).

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
