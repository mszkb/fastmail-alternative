# Konfiguration

Die gesamte Konfiguration steht in der Datei `.env` im Projektverzeichnis ([ADR-0007](../adr/0007-deployment.md)). `docker compose` liest sie beim Start und reicht die Werte an die Dienste weiter. Erzeugt wird sie mit `./scripts/setup-env.sh` (siehe [Installation](installation.md#3-konfiguration-erzeugen-env)); alle Variablen mit Kommentar stehen in `.env.example`.

- Nach einer Änderung: `docker compose up -d` – Compose erstellt die betroffenen Container neu.
- Nur Variablen aus den Tabellen unten wirken. Die `docker-compose.yml` reicht ausschließlich diese an die Container weiter; andere Einträge in der `.env` werden ignoriert.
- **Pflicht** heißt: ohne Wert startet `docker compose` nicht (Fehlermeldung `set … in .env`) bzw. die Funktion ist aus.
- Die `.env` enthält Secrets (`MASTER_KEY`, `VAPID_PRIVATE_KEY`, `MARIADB_PASSWORD`, `METRICS_TOKEN`, ggf. `SETUP_TOKEN` und `OAUTH_*_CLIENT_SECRET`): Rechte `0600`, nie committen, nie in Support-Anfragen kopieren.
- Auf Webspace ohne Docker stehen dieselben Namen in `config.php` statt in der `.env` ([Installation auf Shared Hosting](installation-php.md)); was nur dort gilt, steht [unten](#nur-webspace-configphp).

Dienst `php` ist php-fpm (`/api/*`), `worker` der Dauer-Worker mit demselben Image; beide lesen dieselben Variablen.

## Kern

| Variable        | Standard | Pflicht | Dienst      | Zweck                                                                                                                                                                                                                       |
| --------------- | -------- | ------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DOMAIN`        | `:80`    | nein    | caddy, php  | Site-Adresse für Caddy. Domainname (z. B. `mail.example.org`) = automatisches Let's-Encrypt-TLS und `Secure`-Session-Cookie; `:80` = HTTP ohne TLS (nur Test im LAN).                                                       |
| `COOKIE_SECURE` | leer     | nein    | php         | Überschreibt das `Secure`-Flag des Session-Cookies: `1` = immer setzen, z. B. hinter einem eigenen TLS-Proxy, der auf caddy mit `DOMAIN=:80` weiterleitet; `0` = nie. Leer = automatisch (`Secure` außer bei `DOMAIN=:80`). |
| `LOG_LEVEL`     | `info`   | nein    | php, worker | `debug`, `info`, `warn` oder `error`. Logs enthalten auch auf `debug` keine Mailinhalte oder Zugangsdaten.                                                                                                                  |

## Sicherheit und Verschlüsselung

| Variable                   | Standard | Pflicht | Dienst      | Zweck                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------- | -------- | ------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MASTER_KEY`               | –        | **ja**  | php, worker | Master-Key der Envelope-Encryption (32 Byte, base64). Verschlüsselt alle Data Keys und damit Zugangsdaten und Mailinhalte; auch Backups. **Verlust = alle Daten unlesbar.** Getrennt sichern.                                                                                                                                                                                                    |
| `MASTER_KEY_ID`            | `v1`     | nein    | php, worker | Version des Master-Keys. Nur zusammen mit einer [Key-Rotation](../process/key-rotation.md) ändern.                                                                                                                                                                                                                                                                                               |
| `METRICS_TOKEN`            | leer     | nein    | php         | Leer = `/api/metrics` deaktiviert (404). Gesetzt = Prometheus-Metriken mit Header `Authorization: Bearer <METRICS_TOKEN>`.                                                                                                                                                                                                                                                                       |
| `SETUP_TOKEN`              | leer     | nein    | php         | Setup-Code für die [Ersteinrichtung](installation.md#6-benutzer-anlegen-ersteinrichtung). Leer = das Backend erzeugt beim ersten Aufruf der Einrichtung einen zufälligen Code und schreibt ihn einmalig ins Log (`docker compose logs php`); einen neuen gibt `docker compose exec php php bin/setup-code.php` aus. Gesetzt = dieser Wert (wird nie geloggt). Nach der Einrichtung ohne Wirkung. |
| `MAIL_ALLOW_PRIVATE_HOSTS` | leer     | nein    | php, worker | `1` = private/interne Mail-Hosts erlauben (eigener Mailserver im LAN/Heimnetz). Schaltet den SSRF-Schutz für Mail-Hosts ab – nur setzen, wenn nötig. STARTTLS-Pflicht und Zertifikatsprüfung bleiben aktiv (gültiges Zertifikat für den Hostnamen nötig).                                                                                                                                        |
| `MAIL_EXTRA_PORTS`         | leer     | nein    | php, worker | Zusätzlich erlaubte Mail-Ports, kommagetrennt (z. B. `1143,10465`). Standard sind nur IMAP 143/993 und SMTP 25/465/587/2525; andere Ports lehnen Verbindungstest, Import und Worker ab (Fehler „Port nicht erlaubt“).                                                                                                                                                                            |

> **Nur Entwicklung, niemals produktiv:** `MAIL_INSECURE_TRANSPORT=1` erlaubt IMAP/SMTP im Klartext ohne STARTTLS, schaltet die Zertifikatsprüfung ab und lässt Push an lokale http-Endpoints zu. Gedacht für Tests gegen GreenMail (`make check`, die CI); er wird von `docker-compose.yml` bewusst nicht durchgereicht.

## Datenbank

| Variable           | Standard | Pflicht | Dienst               | Zweck                                                                 |
| ------------------ | -------- | ------- | -------------------- | --------------------------------------------------------------------- |
| `MARIADB_PASSWORD` | –        | **ja**  | mariadb, php, worker | Passwort des Datenbankbenutzers (von `setup-env.sh` zufällig erzeugt) |
| `MARIADB_USER`     | `mail`   | nein    | mariadb, php, worker | Datenbankbenutzer                                                     |
| `MARIADB_DATABASE` | `mail`   | nein    | mariadb, php, worker | Datenbankname                                                         |

Benutzer, Passwort und Datenbankname übernimmt MariaDB nur beim **allerersten** Start (leeres Volume `mariadb-data`). Spätere Änderungen in der `.env` ändern die Datenbank nicht – dann starten php und worker nicht mehr (Anmeldung an der Datenbank schlägt fehl). Das root-Passwort von MariaDB ist zufällig und wird von der App nicht gebraucht.

`POSTGRES_*` aus dem früheren Node-Backend wirken nicht mehr und können aus der `.env` entfernt werden ([Upgrade](upgrade.md#installationen-mit-dem-früheren-node-backend)).

## Sync und Limits

| Variable                        | Standard           | Pflicht | Dienst      | Zweck                                                                                                                                                                         |
| ------------------------------- | ------------------ | ------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SYNC_INTERVAL_SECONDS`         | `120`              | nein    | worker      | Periodischer IMAP-Abgleich je Konto in Sekunden (Rückfallebene neben IMAP IDLE)                                                                                               |
| `SYNC_MIN_INTERVAL_SECONDS`     | `10`               | nein    | worker      | Mindestabstand zweier durch IDLE ausgelöster Abgleiche desselben Ordners (`0` = aus)                                                                                          |
| `IMAP_IDLE`                     | `1`                | nein    | worker      | IMAP IDLE für den Posteingang: neue Mails in Sekunden. `0` = nur periodischer Abgleich                                                                                        |
| `IMAP_IDLE_MAX_CONNECTIONS`     | `50`               | nein    | worker      | Höchstzahl gleichzeitiger IDLE-Verbindungen (eine je aktivem Konto)                                                                                                           |
| `IMAP_MAX_CONNECTIONS_PER_HOST` | `4`                | nein    | php, worker | Gleichzeitig laufende Jobs (= IMAP-Verbindungen) gegen denselben IMAP-Host über alle Konten; IDLE zählt nicht mit. Senken, wenn ein Anbieter über zu viele Verbindungen klagt |
| `MAX_RAW_MESSAGE_BYTES`         | `20971520` (20 MB) | nein    | worker      | Größere Rohmails werden nicht gespeichert (nur Metadaten, ohne Vorschau). Eine große Mail braucht beim Abgleich ein Mehrfaches ihrer Größe im Worker-RAM (Limit 384 MB)       |

Der Worker arbeitet die Jobs **nacheinander** ab (ein Runner, höchstens ein laufender Job je Konto); eine Einstellung für parallele Jobs gibt es nicht.

Intern (nicht in der `.env`): `WORKER_HEARTBEAT_FILE` (Standard `/tmp/worker-heartbeat`) ist die Heartbeat-Datei des Worker-Healthchecks; `MAIL_DATA_DIR` ist im Container fest `/data/mail` (Volume `mail-data`).

**Wenig RAM (1 GB):** `MAX_RAW_MESSAGE_BYTES=10485760` (10 MB) setzen.

## Anhänge (Versand)

| Variable                      | Standard           | Pflicht | Dienst | Zweck                                                                                                                                          |
| ----------------------------- | ------------------ | ------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `MAX_ATTACHMENT_BYTES`        | `10485760` (10 MB) | nein    | php    | Maximale Größe einer hochgeladenen Datei (php-fpm nimmt Uploads bis 16 MB an, Limit 256 MB RAM)                                                |
| `MAX_ATTACHMENTS_TOTAL_BYTES` | `14680064` (14 MB) | nein    | php    | Alle Anhänge einer Nachricht zusammen. base64 macht sie um ein Drittel größer, so bleibt die Kopie in „Gesendet“ unter `MAX_RAW_MESSAGE_BYTES` |

## Aufräumen (Cleanup)

Der Worker räumt regelmäßig auf.

| Variable                 | Standard | Pflicht | Dienst | Zweck                                   |
| ------------------------ | -------- | ------- | ------ | --------------------------------------- |
| `CLEANUP_INTERVAL_HOURS` | `6`      | nein    | worker | Wie oft der Cleanup-Job läuft (Stunden) |

Die Aufbewahrungsfristen sind fest eingestellt: erledigte Jobs 7 Tage, fehlgeschlagene Jobs 30 Tage, nie verwendete Uploads 7 Tage (damit offline geschriebene Mails noch gesendet werden können), gesendete oder fehlgeschlagene Postausgangs-Einträge 30 Tage, nicht mehr referenzierte Dateien in `mail-data` nach 24 Stunden.

## Web Push

| Variable            | Standard                   | Pflicht                 | Dienst      | Zweck                                                                                   |
| ------------------- | -------------------------- | ----------------------- | ----------- | --------------------------------------------------------------------------------------- |
| `VAPID_PUBLIC_KEY`  | leer                       | für Push                | php, worker | Öffentlicher VAPID-Schlüssel (P-256, base64url). Das Backend gibt ihn an Browser weiter |
| `VAPID_PRIVATE_KEY` | leer                       | für Push                | worker      | Privater VAPID-Schlüssel; nur der Worker versendet Push                                 |
| `VAPID_SUBJECT`     | `mailto:admin@example.com` | nein (empfohlen ändern) | worker      | Kontakt für die Push-Dienste (`mailto:` oder `https:`-URL)                              |

Leere Schlüssel = Push aus; die App zeigt dann „Auf dem Server sind keine VAPID-Schlüssel eingerichtet“. **Neue Schlüssel machen alle bestehenden Push-Abos ungültig** – Benachrichtigungen müssen dann auf jedem Gerät neu aktiviert werden. Die Schlüssel also nur einmal erzeugen (das erledigt `setup-env.sh`) und mit der `.env` sichern.

## Anmeldung mit Google/Microsoft (OAuth2)

Einrichtung der eigenen OAuth-App und Bedienung: [Anmeldung mit Google und Microsoft](oauth.md). Ein Anbieter ist aktiv, sobald Client-ID **und** Secret gesetzt sind; ohne beide fehlt der Button „Mit … anmelden“.

| Variable                        | Standard           | Pflicht | Dienst      | Zweck                                                                                                                                                                   |
| ------------------------------- | ------------------ | ------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUBLIC_URL`                    | `https://<DOMAIN>` | nein    | php, worker | Öffentliche Adresse der Instanz; daraus wird die Redirect-URI `<PUBLIC_URL>/api/oauth/callback`. Nötig bei `DOMAIN=:80` hinter eigenem TLS-Proxy oder unter einem Pfad. |
| `OAUTH_GOOGLE_CLIENT_ID`        | leer               | nein    | php, worker | Client-ID der eigenen Google-App (Webanwendung)                                                                                                                         |
| `OAUTH_GOOGLE_CLIENT_SECRET`    | leer               | nein    | php, worker | Clientschlüssel dazu (Secret)                                                                                                                                           |
| `OAUTH_MICROSOFT_CLIENT_ID`     | leer               | nein    | php, worker | Anwendungs-ID (Client) der Entra-App-Registrierung                                                                                                                      |
| `OAUTH_MICROSOFT_CLIENT_SECRET` | leer               | nein    | php, worker | Wert des geheimen Clientschlüssels (läuft nach höchstens 24 Monaten ab)                                                                                                 |
| `OAUTH_MICROSOFT_TENANT`        | `common`           | nein    | php, worker | `common` (persönliche und Organisationskonten), `consumers`, `organizations` oder eine Mandanten-ID                                                                     |

Die beiden Secrets gehören wie der `MASTER_KEY` nicht ins Repo und nicht in Support-Anfragen.

## Backup-Skript

`scripts/backup.sh` liest diese Variablen aus der Shell-Umgebung (z. B. in der Crontab); `BACKUP_KEEP_DAYS` ersatzweise aus der `.env`. Siehe [Backup & Restore](backup-restore.md).

| Variable           | Standard    | Zweck                                                     |
| ------------------ | ----------- | --------------------------------------------------------- |
| `BACKUP_DIR`       | `./backups` | Zielverzeichnis auf dem Host                              |
| `BACKUP_KEEP_DAYS` | `14`        | Ältere `fma-backup-*.fmabk` im Zielordner werden gelöscht |

## Release-Images (optional)

Nur für fertige Images statt lokalem Build ([Installation](installation.md#5-starten), [Upgrade](upgrade.md#fertige-images-statt-lokal-bauen)). Ohne diese Variablen baut `docker compose` lokal (Standard).

| Variable           | Standard        | Pflicht            | Dienst                     | Zweck                                                                                                                                                                                                                                                                                                                         |
| ------------------ | --------------- | ------------------ | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COMPOSE_FILE`     | leer            | nein               | compose                    | `docker-compose.yml:docker-compose.release.yml` = alle `docker compose`-Befehle (auch `scripts/backup.sh`) nutzen die Release-Images. Eine eigene `docker-compose.override.yml` wird dann nicht mehr automatisch geladen und muss als dritte Datei angehängt werden. `scripts/upgrade.sh` bricht damit ab (Upgrade von Hand). |
| `FMA_VERSION`      | –               | mit Release-Images | compose (web, php, worker) | Release ohne „v“, z. B. `0.1.0`.                                                                                                                                                                                                                                                                                              |
| `FMA_IMAGE_PREFIX` | `ghcr.io/mszkb` | nein               | compose (web, php, worker) | Registry/Owner für Forks.                                                                                                                                                                                                                                                                                                     |

## Fest eingestellt

Folgende Werte sind in `docker-compose.yml`, `Caddyfile`, `apps/server-php/Dockerfile` oder im Code fest und brauchen normalerweise keine Änderung:

| Was               | Wert                                                                                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Öffentliche Ports | 80, 443 (caddy); auf dem Host änderbar mit `HTTP_PORT`/`HTTPS_PORT` in der `.env`. MariaDB hat keinen Host-Port                                                                                        |
| Interne Ports     | web 3000 (HTTP), php 9000 (FastCGI), mariadb 3306 – nur im Compose-Netz                                                                                                                                |
| Volumes           | `mariadb-data` (Datenbank; hochgeladene Anhänge liegen verschlüsselt in der Tabelle `attachment_upload`, also hier), `mail-data` (verschlüsselte Rohmails), `caddy-data` (Zertifikate), `caddy-config` |
| Speicherlimits    | caddy 64 MB, web 64 MB, php 256 MB, worker 384 MB, mariadb 256 MB (Buffer-Pool 64 MB, max. 30 Verbindungen)                                                                                            |
| Request-Timeouts  | Caddy: Header 30 s, Body 2 min                                                                                                                                                                         |
| PHP               | `memory_limit` 256 MB, `upload_max_filesize`/`post_max_size` 16 MB                                                                                                                                     |
| Logs              | json-file, 10 MB × 3 Dateien je Dienst                                                                                                                                                                 |

Wer einen eigenen Reverse Proxy betreibt, lässt am einfachsten caddy mit `DOMAIN=:80` stehen, leitet vom eigenen TLS-Proxy alles an caddy weiter und setzt `COOKIE_SECURE=1`; caddy auf einem anderen Host-Port: `HTTP_PORT=8080`. Ohne caddy muss der eigene Proxy `/api/*` per **FastCGI** an `php:9000` (Root `/app/public`, Skript `index.php`, siehe `Caddyfile`) und alles andere per HTTP an `web:3000` weiterleiten und dafür im Compose-Netz hängen. Solche Änderungen gehören in eine eigene `docker-compose.override.yml` (wird automatisch geladen, ist nicht versioniert und blockiert `scripts/upgrade.sh` nicht; bestehende Port-Listen mit `ports: !override` ersetzen), nicht in die `docker-compose.yml` selbst.

## Nur Webspace (`config.php`)

Auf Shared Hosting ([Installation](installation-php.md)) kommen hinzu:

| Variable                         | Standard         | Zweck                                                                                                                  |
| -------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                   | –                | `mysql://benutzer:passwort@host:3306/datenbank` (alternativ `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`) |
| `MAIL_DATA_DIR`                  | `data/`          | Verzeichnis der verschlüsselten Rohmails, außerhalb des Webroots                                                       |
| `CRON_TIME_BUDGET_SECONDS`       | `50`             | Laufzeit je Cron-Aufruf; unter dem Laufzeitlimit des Hosters halten                                                    |
| `CRON_TOKEN`                     | leer             | Geheimnis für den Web-Cron (`cron.php`); leer = Web-Cron aus                                                           |
| `BACKUP_DIR`, `BACKUP_KEEP_DAYS` | `backups/`, `14` | Ziel und Aufbewahrung für `php bin/console backup create`                                                              |

Die Aufbewahrungsfristen des Cleanups liest das Backend aus `JOB_RETENTION_DAYS`, `FAILED_JOB_RETENTION_DAYS`, `UPLOAD_RETENTION_HOURS`, `OUTBOX_RETENTION_DAYS` und `ORPHAN_FILE_GRACE_HOURS`; im Docker-Stack über die `.env` (Standardwerte siehe `.env.example`: 7 / 30 Tage, 168 h, 30 Tage, 24 h), auf Webspace in `config.php`.
