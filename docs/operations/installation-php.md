# Installation mit dem PHP-Backend (Vorschau)

> **Vorschau:** Das PHP-Backend ([ADR-0013](../adr/0013-php-backend.md), `apps/server-php`) ist **noch nicht produktiv nutzbar** (Stand: [`ROADMAP.md`](../../ROADMAP.md), Epic #94). Diese Anleitung beschreibt die Installationswege, wie sie mit #109 entstehen. Für den Alltag weiterhin die [Docker-Installation mit dem Node-Backend](installation.md) verwenden.

Zwei Wege:

| Weg                                    | Für                                                  | Hintergrundjobs                                                   |
| -------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------- |
| [A: Webspace](#a-webspace-ftp--cron)   | Shared Hosting mit PHP und MySQL/MariaDB, ohne Shell | Cron (jede Minute) oder Web-Cron; neue Mails mit Cron-Verzögerung |
| [B: Docker Compose](#b-docker-compose) | eigener Server (Raspberry Pi, VPS)                   | Dauer-Worker mit IMAP IDLE                                        |

## A: Webspace (FTP + Cron)

### Voraussetzungen

| Was       | Anforderung                                                                                                                                                                |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PHP       | ≥ 8.2 mit `openssl`, `pdo_mysql`, `mbstring`, `json`, `hash`, `iconv` und Argon2id (`password_hash`); optional `intl`, `sodium`                                            |
| Datenbank | MySQL ≥ 8.0.1 oder MariaDB ≥ 10.6 (wegen `SKIP LOCKED`), eine leere Datenbank mit eigenem Benutzer                                                                         |
| Webserver | Apache 2.4 mit `mod_rewrite` und `mod_headers`, `.htaccess` erlaubt (`AllowOverride All`)                                                                                  |
| Domain    | eigene (Sub-)Domain mit **HTTPS** (Service Worker, App-Installation und Push brauchen HTTPS). Installation nur im Wurzelverzeichnis der Domain, nicht in einem Unterordner |
| Netzwerk  | ausgehende Verbindungen zu IMAP 993 und SMTP 465/587 (manche Hoster sperren sie – der Installer prüft das)                                                                 |
| Cron      | Cronjob mit PHP-CLI (jede Minute) oder ein Web-Cron-Dienst, der eine URL aufruft                                                                                           |

### Aufbau des Pakets

Das Paket `fma-<version>-php.zip` (gebaut mit `scripts/build-php-release.sh`, siehe [unten](#paket-selbst-bauen)) enthält zwei Ordner:

```text
fma-<version>/
  public_html/        → Inhalt in den Webroot der Domain
    index.html, _nuxt/, sw.js, …   PWA (statischer Build)
    .htaccess          SPA-Fallback, /api/* → api/index.php, Sicherheitsheader
    api/index.php      Einstieg für /api/*
    install.php        Web-Installer (aus, sobald ein Benutzer existiert)
    cron.php           Web-Cron (aus ohne CRON_TOKEN)
    app-path.php       Pfad zu fma-app (Standard: ../fma-app)
  fma-app/            → NEBEN den Webroot, nie hinein
    src/ bin/ migrations/ vendor/ public/
    config.example.php
    config.php         legt der Betreiber an (Installer schlägt sie vor)
    data/              verschlüsselte Mails (MAIL_DATA_DIR)
```

Im Webroot liegen nur dünne Einstiegsdateien, die `fma-app/public/*.php` laden. `config.php` (mit dem `MASTER_KEY`), `vendor/`, `src/` und `data/` liegen **außerhalb** des Webroots und sind per HTTP nicht erreichbar. Zusätzlich sperrt eine `.htaccess` in `fma-app/` und `fma-app/data/` alles, falls der Ordner doch einmal im Webroot landet.

Erlaubt der Hoster keinen Ordner neben dem Webroot, `fma-app` an einen anderen Ort außerhalb des Webroots legen und den Pfad in `public_html/app-path.php` anpassen.

### Schritte

1. **Datenbank anlegen** im Kundenmenü des Hosters (Name, Benutzer, Passwort notieren).
2. **Hochladen** per FTP/SFTP: Inhalt von `public_html/` in den Webroot der Domain, `fma-app/` daneben. Beispiel: Webroot `/home/kunde/public_html` → App unter `/home/kunde/fma-app`.
3. **Installer öffnen:** `https://<domain>/install.php`. Er zeigt den Systemcheck (wie `php bin/check.php`): PHP-Version, Extensions, `MASTER_KEY`, Datenbank, Schreibrechte für `data/`, Lage der `config.php` und – über den Link „Also probe outbound IMAP/SMTP ports“ – die ausgehenden Mail-Ports.
4. **`config.php` anlegen:** Solange kein `MASTER_KEY` konfiguriert ist, zeigt der Installer eine Vorlage mit frisch erzeugtem `MASTER_KEY` und VAPID-Schlüsseln (für Push). Die Werte werden nur angezeigt, nirgends gespeichert – bei jedem Neuladen entstehen neue.
   - Vorlage lokal als `config.php` speichern, `DATABASE_URL` eintragen (`mysql://benutzer:passwort@host:3306/datenbank`, Sonderzeichen im Passwort URL-kodieren) und nach `fma-app/config.php` hochladen, Rechte `0600` (bzw. `0640`, falls PHP unter einem anderen Benutzer läuft).
   - **Den `MASTER_KEY` sofort getrennt sichern** (Passwortmanager). Ohne ihn sind alle Mails und Zugangsdaten unlesbar.
   - Ein bereits konfigurierter `MASTER_KEY`, das Datenbankpasswort oder ein `SETUP_TOKEN` werden **nie** angezeigt, nur ob sie gesetzt sind.
5. **Installer neu laden** – alle Pflichtprüfungen müssen „OK“ zeigen.
6. **„Apply migrations“** klicken: legt das Datenbankschema an (wie `php bin/migrate.php`; mehrfach ausführbar).
7. **Setup-Code holen:** Den `MASTER_KEY` aus der `config.php` eingeben und „Show setup code“ klicken. Der Installer erzeugt einen neuen Setup-Code (wie `php bin/setup-code.php`) und zeigt ihn einmal an. Die Eingabe des `MASTER_KEY` beweist, dass hier der Betreiber sitzt – sonst könnte jeder, der die frische Instanz findet, sie übernehmen. Ist `SETUP_TOKEN` konfiguriert, gilt stattdessen dieser Wert.
8. **App öffnen** (`https://<domain>/`), Ersteinrichtung wählen, Setup-Code, E-Mail-Adresse und Passwort eingeben. Ab jetzt antwortet `install.php` mit **404**.
9. **Cronjob einrichten** (Hintergrundjobs: Sync, Versand, Push, Aufräumen):
   - mit PHP-CLI (bevorzugt): `* * * * * php /home/kunde/fma-app/bin/cron.php`
   - nur Web-Cron möglich: in `config.php` `'CRON_TOKEN' => '<langer Zufallswert>'` setzen und `https://<domain>/cron.php` jede Minute mit Header `Authorization: Bearer <CRON_TOKEN>` (oder `?token=<CRON_TOKEN>`) aufrufen lassen.

   `CRON_TIME_BUDGET_SECONDS` (Standard 50) unter dem Laufzeitlimit des Hosters halten. Ohne Dauer-Worker kommen neue Mails mit Cron-Verzögerung; beim Öffnen der App wird sofort synchronisiert.

10. Erstes Mailkonto verbinden und App installieren wie in der [Docker-Anleitung](installation.md#7-erstes-mailkonto-verbinden).

### Sicherheitsheader

Die `.htaccess` im Webroot setzt für die PWA dieselben Header wie `apps/web/nginx.conf` (CSP mit Hashes der Inline-Skripte aus `apps/web/scripts/build-csp.mjs`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, …) und HSTS bei HTTPS. `/api/*`, `install.php` und `cron.php` setzen ihre eigenen, strengeren Header. Ohne `mod_headers` fehlen die PWA-Header – beim Hoster nachfragen.

### Update

Neues Paket hochladen und `public_html/` sowie `fma-app/` (außer `config.php` und `data/`) ersetzen, danach Migrationen anwenden: per Cron/SSH `php fma-app/bin/migrate.php`. Nach der Ersteinrichtung ist der Installer gesperrt; ohne Shell einen einmaligen Cronjob `php …/fma-app/bin/migrate.php` anlegen. Vorher Backup ([Backup & Restore](backup-restore.md)).

### Paket selbst bauen

```sh
pnpm install
pnpm --filter @fma/web build                 # PWA + security-headers.conf
scripts/build-php-release.sh                 # → dist/fma-<version>-php.zip
```

Optionen: `--version X.Y.Z`, `--out <ordner>`, `--local-vendor` (nutzt das vorhandene `apps/server-php/vendor` statt Composer-Downloads, entfernt die Dev-Pakete; für Offline-Tests). Benötigt `composer` und `zip`.

## B: Docker Compose

`docker-compose.php.yml` ist eine **Vorschau** neben der bisherigen `docker-compose.yml` (die unverändert bleibt). Dienste:

| Dienst    | Image                        | Aufgabe                                                                            |
| --------- | ---------------------------- | ---------------------------------------------------------------------------------- |
| `caddy`   | `caddy:2-alpine`             | TLS, `/api/*` per FastCGI an `php:9000` (`Caddyfile.php`), Rest an `web`           |
| `web`     | `apps/web/Dockerfile`        | PWA (nginx, Sicherheitsheader)                                                     |
| `php`     | `apps/server-php/Dockerfile` | php-fpm für `/api/*`, wendet beim Start die Migrationen an                         |
| `worker`  | dasselbe Image               | `php bin/worker.php`: Job-Schleife und IMAP IDLE statt Cron, Heartbeat-Healthcheck |
| `mariadb` | `mariadb:11`                 | Datenbank (Volume `mariadb-data`)                                                  |

Mails liegen verschlüsselt im Volume `mail-data` (`/data/mail`).

```sh
node scripts/setup-env.mjs          # erzeugt .env inkl. MARIADB_PASSWORD
# bestehende .env: MARIADB_PASSWORD=<Zufallswert> ergänzen
docker compose -f docker-compose.php.yml up -d --build
docker compose -f docker-compose.php.yml exec php php bin/check.php
docker compose -f docker-compose.php.yml exec php php bin/setup-code.php
```

Konfiguration über `.env`: `DOMAIN`, `MASTER_KEY`, `VAPID_*`, `MARIADB_PASSWORD` (optional `MARIADB_USER`, `MARIADB_DATABASE`, Standard `mail`), sonst wie in [Konfiguration](configuration.md). Der Web-Installer ist in dieser Variante nicht erreichbar (Caddy leitet nur `/api/*` an PHP); Check und Setup-Code laufen per `exec`.

Bestehende Daten aus PostgreSQL übernimmt `bin/import-postgres.php` (#108); eine fertige Umstellungsanleitung folgt mit #110.
