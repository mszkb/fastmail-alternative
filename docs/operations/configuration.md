# Konfiguration

Die gesamte Konfiguration steht in der Datei `.env` im Projektverzeichnis ([ADR-0007](../adr/0007-deployment.md)). `docker compose` liest sie beim Start und reicht die Werte an die Dienste weiter. Erzeugt wird sie mit `node scripts/setup-env.mjs` (siehe [Installation](installation.md#3-konfiguration-erzeugen-env)); alle Variablen mit Kommentar stehen in `.env.example`.

- Nach einer Änderung: `docker compose up -d` – Compose erstellt die betroffenen Container neu.
- Nur Variablen aus den Tabellen unten wirken. Die `docker-compose.yml` reicht ausschließlich diese an die Container weiter; andere Einträge in der `.env` werden ignoriert.
- **Pflicht** heißt: ohne Wert startet `docker compose` nicht (Fehlermeldung `set … in .env`) bzw. die Funktion ist aus.
- Die `.env` enthält Secrets (`MASTER_KEY`, `VAPID_PRIVATE_KEY`, `POSTGRES_PASSWORD`, `METRICS_TOKEN`, ggf. `SETUP_TOKEN`): Rechte `0600`, nie committen, nie in Support-Anfragen kopieren.

## Kern

| Variable    | Standard | Pflicht | Dienst      | Zweck                                                                                                                                                                 |
| ----------- | -------- | ------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DOMAIN`    | `:80`    | nein    | caddy, api  | Site-Adresse für Caddy. Domainname (z. B. `mail.example.org`) = automatisches Let's-Encrypt-TLS und `Secure`-Session-Cookie; `:80` = HTTP ohne TLS (nur Test im LAN). |
| `LOG_LEVEL` | `info`   | nein    | api, worker | `debug`, `info`, `warn` oder `error`. Logs enthalten auch auf `debug` keine Mailinhalte oder Zugangsdaten.                                                            |

## Sicherheit und Verschlüsselung

| Variable                   | Standard | Pflicht | Dienst      | Zweck                                                                                                                                                                                                                                                                                                                          |
| -------------------------- | -------- | ------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MASTER_KEY`               | –        | **ja**  | api, worker | Master-Key der Envelope-Encryption (32 Byte, base64). Verschlüsselt alle Data Keys und damit Zugangsdaten und Mailinhalte; auch Backups. **Verlust = alle Daten unlesbar.** Getrennt sichern.                                                                                                                                  |
| `MASTER_KEY_ID`            | `v1`     | nein    | api         | Version des Master-Keys. Nur zusammen mit einer [Key-Rotation](../process/key-rotation.md) ändern.                                                                                                                                                                                                                             |
| `METRICS_TOKEN`            | leer     | nein    | api         | Leer = `/api/metrics` deaktiviert (404). Gesetzt = Prometheus-Metriken mit Header `Authorization: Bearer <METRICS_TOKEN>`.                                                                                                                                                                                                     |
| `SETUP_TOKEN`              | leer     | nein    | api         | Setup-Code für die [Ersteinrichtung](installation.md#6-benutzer-anlegen-ersteinrichtung). Leer = die api erzeugt beim Start einen zufälligen Code und schreibt ihn einmalig ins Log (`docker compose logs api`), solange kein Benutzer existiert. Gesetzt = dieser Wert (wird nie geloggt). Nach der Einrichtung ohne Wirkung. |
| `MAIL_ALLOW_PRIVATE_HOSTS` | leer     | nein    | api, worker | `1` = private/interne Mail-Hosts erlauben (eigener Mailserver im LAN/Heimnetz). Schaltet den SSRF-Schutz für Mail-Hosts ab – nur setzen, wenn nötig. STARTTLS-Pflicht und Zertifikatsprüfung bleiben aktiv (gültiges Zertifikat für den Hostnamen nötig).                                                                      |

> **Nur Entwicklung, niemals produktiv:** `MAIL_INSECURE_TRANSPORT=1` erlaubt IMAP/SMTP im Klartext ohne STARTTLS, schaltet die Zertifikatsprüfung ab und lässt Push an lokale http-Endpoints zu. Gedacht für Tests gegen GreenMail (die Vitest-Configs und die CI setzen ihn); er wird von `docker-compose.yml` bewusst nicht durchgereicht.

## Datenbank

| Variable             | Standard | Pflicht | Dienst                | Zweck                                                                                                                   |
| -------------------- | -------- | ------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `POSTGRES_USER`      | `mail`   | nein    | postgres, api, worker | Datenbankbenutzer                                                                                                       |
| `POSTGRES_PASSWORD`  | –        | **ja**  | postgres, api, worker | Datenbankpasswort (von `setup-env.mjs` zufällig erzeugt)                                                                |
| `POSTGRES_DB`        | `mail`   | nein    | postgres, api, worker | Datenbankname                                                                                                           |
| `POSTGRES_HOST_PORT` | `5432`   | nein    | compose (postgres)    | Host-Port für den Wartungszugang auf `127.0.0.1` (z. B. `55432`, wenn auf dem Host schon eine PostgreSQL-Instanz läuft) |

Benutzer, Passwort und Datenbankname werden von PostgreSQL nur beim **allerersten** Start (leeres Volume `postgres-data`) übernommen. Spätere Änderungen in der `.env` ändern die Datenbank nicht – dann starten api und worker nicht mehr (Anmeldung an der Datenbank schlägt fehl).

## Sync und Limits

| Variable                        | Standard           | Pflicht | Dienst | Zweck                                                                                                                                                                        |
| ------------------------------- | ------------------ | ------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SYNC_INTERVAL_SECONDS`         | `120`              | nein    | worker | Periodischer IMAP-Abgleich je Konto in Sekunden (Rückfallebene neben IMAP IDLE)                                                                                              |
| `SYNC_MIN_INTERVAL_SECONDS`     | `10`               | nein    | worker | Mindestabstand zweier durch IDLE ausgelöster Abgleiche desselben Ordners (`0` = aus)                                                                                         |
| `IMAP_IDLE`                     | `1`                | nein    | worker | IMAP IDLE für den Posteingang: neue Mails in Sekunden. `0` = nur periodischer Abgleich                                                                                       |
| `IMAP_IDLE_MAX_CONNECTIONS`     | `50`               | nein    | worker | Höchstzahl gleichzeitiger IDLE-Verbindungen (eine je aktivem Konto)                                                                                                          |
| `WORKER_CONCURRENCY`            | `4`                | nein    | worker | Jobs, die der Worker parallel ausführt; höchstens einer je Konto                                                                                                             |
| `IMAP_MAX_CONNECTIONS_PER_HOST` | `4`                | nein    | worker | Gleichzeitige Jobs (= IMAP-Verbindungen) gegen denselben IMAP-Host über alle Konten; IDLE zählt nicht mit. Senken, wenn ein Anbieter über zu viele Verbindungen klagt        |
| `MAX_RAW_MESSAGE_BYTES`         | `20971520` (20 MB) | nein    | worker | Größere Rohmails werden nicht gespeichert (nur Kopfzeilen und Vorschau). Jede große Mail braucht beim Abgleich bis etwa das 5-Fache ihrer Größe im Worker-RAM (Limit 384 MB) |

Intern (nicht in der `.env`): `WORKER_HEARTBEAT_FILE` (Standard `/tmp/worker-heartbeat`) ist die Heartbeat-Datei des Worker-Healthchecks; nur relevant, wenn der Worker außerhalb von Docker läuft.

**Wenig RAM (1 GB):** `WORKER_CONCURRENCY=2` und/oder `MAX_RAW_MESSAGE_BYTES=10485760` (10 MB) setzen. Faustregel: `WORKER_CONCURRENCY × 5 × MAX_RAW_MESSAGE_BYTES` sollte deutlich unter dem Worker-Limit von 384 MB bleiben.

## Anhänge (Versand)

| Variable                      | Standard           | Pflicht | Dienst | Zweck                                                                                                                                          |
| ----------------------------- | ------------------ | ------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `MAX_ATTACHMENT_BYTES`        | `10485760` (10 MB) | nein    | api    | Maximale Größe einer hochgeladenen Datei. Ein Upload belegt beim Verschlüsseln etwa das 4-Fache im API-RAM (Limit 192 MB)                      |
| `MAX_ATTACHMENTS_TOTAL_BYTES` | `14680064` (14 MB) | nein    | api    | Alle Anhänge einer Nachricht zusammen. base64 macht sie um ein Drittel größer, so bleibt die Kopie in „Gesendet“ unter `MAX_RAW_MESSAGE_BYTES` |
| `MAX_CONCURRENT_UPLOADS`      | `2`                | nein    | api    | Gleichzeitig angenommene Uploads (je ca. 4 × `MAX_ATTACHMENT_BYTES` RAM)                                                                       |

## Aufräumen (Cleanup)

Der Worker räumt regelmäßig auf. Ungültige Werte oder `0` fallen auf den Standard zurück.

| Variable                    | Standard | Pflicht | Dienst | Zweck                                                                                                                             |
| --------------------------- | -------- | ------- | ------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `CLEANUP_INTERVAL_HOURS`    | `6`      | nein    | worker | Wie oft der Cleanup-Job läuft (Stunden)                                                                                           |
| `JOB_RETENTION_DAYS`        | `7`      | nein    | worker | Aufbewahrung erledigter Jobs (Tage)                                                                                               |
| `FAILED_JOB_RETENTION_DAYS` | `30`     | nein    | worker | Aufbewahrung fehlgeschlagener Jobs (Tage)                                                                                         |
| `UPLOAD_RETENTION_HOURS`    | `168`    | nein    | worker | Uploads, die nie an eine Nachricht gehängt wurden (Stunden; 7 Tage, damit offline geschriebene Mails noch gesendet werden können) |
| `OUTBOX_RETENTION_DAYS`     | `30`     | nein    | worker | Gesendete oder fehlgeschlagene Postausgangs-Einträge (Tage)                                                                       |
| `ORPHAN_FILE_GRACE_HOURS`   | `24`     | nein    | worker | Wartezeit, bevor nicht mehr referenzierte Dateien im Volume `mail-data` gelöscht werden (Stunden)                                 |

## Web Push

| Variable            | Standard                   | Pflicht                 | Dienst      | Zweck                                                                               |
| ------------------- | -------------------------- | ----------------------- | ----------- | ----------------------------------------------------------------------------------- |
| `VAPID_PUBLIC_KEY`  | leer                       | für Push                | api, worker | Öffentlicher VAPID-Schlüssel (P-256, base64url). Die API gibt ihn an Browser weiter |
| `VAPID_PRIVATE_KEY` | leer                       | für Push                | worker      | Privater VAPID-Schlüssel; nur der Worker versendet Push                             |
| `VAPID_SUBJECT`     | `mailto:admin@example.com` | nein (empfohlen ändern) | worker      | Kontakt für die Push-Dienste (`mailto:` oder `https:`-URL)                          |

Leere Schlüssel = Push aus; die App zeigt dann „Auf dem Server sind keine VAPID-Schlüssel eingerichtet“. **Neue Schlüssel machen alle bestehenden Push-Abos ungültig** – Benachrichtigungen müssen dann auf jedem Gerät neu aktiviert werden. Die Schlüssel also nur einmal erzeugen (das erledigt `setup-env.mjs`) und mit der `.env` sichern.

## Backup-Skript

Diese Variablen gehören **nicht** in die `.env`: `scripts/backup.sh` liest sie aus der Shell-Umgebung (z. B. in der Crontab), siehe [Backup & Restore](backup-restore.md).

| Variable           | Standard    | Zweck                                                     |
| ------------------ | ----------- | --------------------------------------------------------- |
| `BACKUP_DIR`       | `./backups` | Zielverzeichnis auf dem Host                              |
| `BACKUP_KEEP_DAYS` | `14`        | Ältere `fma-backup-*.fmabk` im Zielordner werden gelöscht |

## Fest eingestellt

Folgende Werte sind in `docker-compose.yml`, `Caddyfile` oder im Code fest und brauchen normalerweise keine Änderung:

| Was               | Wert                                                                                                                                                                                                        |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Öffentliche Ports | 80, 443 (caddy); PostgreSQL nur auf `127.0.0.1:5432` (für SSH-Tunnel/Wartung, nicht aus dem Netz erreichbar; Host-Port per `POSTGRES_HOST_PORT`)                                                            |
| Interne Ports     | web 3000, api 3001 (nur im Compose-Netz)                                                                                                                                                                    |
| Volumes           | `postgres-data`, `mail-data` (verschlüsselte Rohmails; Uploads liegen verschlüsselt in PostgreSQL, Tabelle `attachment_upload`, also im Volume `postgres-data`), `caddy-data` (Zertifikate), `caddy-config` |
| Speicherlimits    | caddy 64 MB, web 64 MB, api 192 MB, worker 384 MB, postgres 256 MB                                                                                                                                          |
| Request-Timeouts  | Caddy: Header 30 s, Body 2 min; API: 120 s                                                                                                                                                                  |
| Logs              | json-file, 10 MB × 3 Dateien je Dienst                                                                                                                                                                      |

Wer einen eigenen Reverse Proxy betreibt, kann den Dienst `caddy` entfernen und `/api/*` an `api:3001`, alles andere an `web:3000` weiterleiten (siehe `Caddyfile`). web und api haben nur interne Ports; der eigene Proxy muss sie also im Compose-Netz erreichen, oder die Ports werden auf `127.0.0.1` freigegeben – in einer eigenen `docker-compose.override.yml` (wird automatisch geladen, ist nicht versioniert und blockiert `scripts/upgrade.sh` nicht; bestehende Port-Listen mit `ports: !override` ersetzen), nicht in der `docker-compose.yml` selbst.
