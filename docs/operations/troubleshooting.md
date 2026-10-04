# Troubleshooting

Alle Befehle laufen im Projektverzeichnis (auf dem Raspberry Pi `~/fastmail-alternative`, als der Benutzer, unter dem Docker läuft).

## Erste Diagnose

```sh
docker compose ps                         # Status aller Dienste
docker compose logs --tail=100 api        # bzw. worker, caddy, web, postgres
docker compose logs -f worker             # live mitlesen
docker stats --no-stream                  # RAM/CPU je Container
df -h && docker system df                 # Plattenplatz
```

| Dienst     | Healthcheck                                   | Erwarteter Status              |
| ---------- | --------------------------------------------- | ------------------------------ |
| `caddy`    | Admin-API auf Port 2019                       | `healthy`                      |
| `web`      | `GET /` auf Port 3000                         | `healthy`                      |
| `api`      | `GET /api/health` (inkl. Datenbankverbindung) | `healthy`                      |
| `postgres` | `pg_isready`                                  | `healthy`                      |
| `worker`   | keiner                                        | `running` (nicht `restarting`) |

Von außen: `curl -s https://mail.example.org/api/health` liefert `{"status":"ok",…,"checks":{"database":"ok"}}`; ohne Datenbank antwortet die API mit `503` und `"database":"down"`.

**Logs enthalten bewusst keine Mailinhalte, Betreffzeilen, Adressen oder Zugangsdaten** – auch keine Fehlertexte der Mailanbieter (die können Inhalte zitieren). Gespeichert werden nur stabile Fehlercodes (z. B. `AUTH_FAILED`), IDs, Zähler und Größen. Ein Logauszug kann deshalb für eine Support-Anfrage weitergegeben werden; die `.env` dagegen **nie** (sie enthält `MASTER_KEY`, VAPID-Privatschlüssel und Datenbankpasswort). Für eine Fehlermeldung genügen: Version (`git rev-parse --short HEAD`), `docker compose ps`, die relevanten Logzeilen und der Fehlercode aus der Kontoliste.

## Start und Installation

| Symptom                                                                      | Ursache / Lösung                                                                                                                                                                         |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker compose` bricht ab: `set MASTER_KEY in .env (scripts/setup-env.mjs)` | `.env` fehlt oder ist unvollständig. `node scripts/setup-env.mjs` ausführen (überschreibt nie eine vorhandene `.env`).                                                                   |
| `setup-env.mjs`: `already exists - not overwriting`                          | Es gibt schon eine `.env`. **Nicht löschen**, wenn die Instanz schon Daten hat – ein neuer `MASTER_KEY` macht alles unlesbar.                                                            |
| Fehler beim Binden von Port 80/443 (`permission denied`)                     | Rootless Docker darf Ports < 1024 nicht öffnen: `net.ipv4.ip_unprivileged_port_start=80` setzen, siehe [Installation](installation.md#rootless-docker).                                  |
| Port 80/443 bzw. `127.0.0.1:5432` `address already in use`                   | Ein anderer Webserver bzw. ein lokales PostgreSQL belegt den Port (`sudo ss -tlnp`). Dienst stoppen oder die Portzuordnung in `docker-compose.yml` anpassen.                             |
| Build bricht auf dem Pi ab oder hängt                                        | Zu wenig RAM für den Build: Swap vergrößern (`free -h`), andere Dienste stoppen, Build-Cache leeren (`docker builder prune -af`).                                                        |
| api wird nicht `healthy`, Log: Anmeldung an der Datenbank fehlgeschlagen     | `POSTGRES_*` in der `.env` wurden nach dem ersten Start geändert. PostgreSQL übernimmt sie nur bei leerem Volume – alte Werte wiederherstellen.                                          |
| Startseite zeigt „Anmeldung“ statt „Einrichtung“                             | Es existiert schon ein Benutzer (Single-User). Hat jemand anderes die Einrichtung vorgenommen, Instanz verwerfen (`docker compose down -v`) und neu aufsetzen, bevor Daten darin liegen. |
| Anmeldung wird mit HTTP `429` abgelehnt                                      | Schutz gegen Passwort-Raten bzw. Rate Limit pro IP. Kurz warten (Header `retry-after`).                                                                                                  |

## TLS und Caddy

- **Kein Zertifikat:** `docker compose logs caddy` zeigt die Let's-Encrypt-Fehler. Prüfen: DNS-Eintrag der Domain zeigt auf diesen Server (`dig +short mail.example.org`), Ports 80 **und** 443 sind aus dem Internet erreichbar (Router-Portweiterleitung, Firewall), `DOMAIN` in der `.env` ist exakt der Domainname ohne `https://`.
- Nach zu vielen Fehlversuchen sperrt Let's Encrypt die Domain vorübergehend (Rate Limit). Ursache beheben und warten; Caddy versucht es selbst erneut.
- Zertifikate liegen im Volume `caddy-data`; es nie mit `docker compose down -v` löschen, wenn es nicht nötig ist.
- **Seite lädt per HTTP, aber keine App-Installation/kein Push/kein Offline-Modus:** Mit `DOMAIN=:80` gibt es kein HTTPS, Browser aktivieren dann keinen Service Worker. Domain setzen.

## Mailkonten

Die Kontoliste (**Einstellungen → Konten**) zeigt Probleme als Hinweis am Konto. Ein gestörtes Konto blockiert nie die anderen Konten.

| Anzeige / Status                                                       | Code                                                                                             | Bedeutung und Abhilfe                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| „Anmeldung fehlgeschlagen“ (`auth_error`)                              | `AUTH_FAILED`                                                                                    | Der Anbieter lehnt die Zugangsdaten ab. **Kein automatischer Neuversuch**, bis über „Zugangsdaten aktualisieren“ neue gespeichert sind. Häufig: Passwort geändert, App-Passwort widerrufen, IMAP beim Anbieter deaktiviert.                               |
| „Passwort fehlt“ (`auth_error`)                                        | `CREDENTIALS_REQUIRED`                                                                           | Konto stammt aus einem Konfigurations-Import; Passwort über „Bearbeiten“ eingeben ([Umzug](migration.md#import-neuer-server)).                                                                                                                            |
| „Server nicht erreichbar“ (`unreachable`)                              | `HOST_NOT_FOUND`, `CONNECTION_REFUSED`, `CONNECTION_LOST`, `TIMEOUT`, `TLS_ERROR`, `JOB_TIMEOUT` | Verbindungsproblem. Neue Versuche erfolgen automatisch mit wachsendem Abstand (Backoff: 1 min, verdoppelt bis max. 1 h); der Status erscheint nach drei Fehlschlägen in Folge. Host/Port prüfen; bei `TLS_ERROR` hat der Server kein gültiges Zertifikat. |
| „Server nicht erreichbar“ mit Hinweis „Der Mailanbieter bremst gerade“ | `RATE_LIMITED`                                                                                   | Der Anbieter drosselt (zu viele Verbindungen/Anfragen). Gleicher Backoff wie oben, keine Endlosschleife. Wiederholt es sich, `IMAP_MAX_CONNECTIONS_PER_HOST` senken ([Konfiguration](configuration.md#sync-und-limits)).                                  |
| „Interner Host ist blockiert“                                          | `BLOCKED_HOST`                                                                                   | Der Mailserver löst auf eine private/interne IP auf. Aus Sicherheitsgründen (SSRF-Schutz) nicht erlaubt.                                                                                                                                                  |
| „Deaktiviert“ (`disabled`)                                             | –                                                                                                | Konto wird nicht abgeglichen.                                                                                                                                                                                                                             |

Weitere Punkte:

- **Neue Mails kommen verzögert:** IMAP IDLE prüfen (`IMAP_IDLE=1`); ohne IDLE gilt `SYNC_INTERVAL_SECONDS` (Standard 2 min). Im Worker-Log erscheint `idle start failed` mit Fehlercode, wenn IDLE nicht startet. Manuell abgleichen: Aktualisieren-Knopf bzw. Pull-to-Refresh in der App.
- **Große Mail zeigt nur Vorschau:** Größer als `MAX_RAW_MESSAGE_BYTES` (Standard 20 MB) – gewollt, um den Worker-RAM zu schützen.
- **Versand hängt im Postausgang:** Worker läuft? (`docker compose ps worker`). Fehlgeschlagene Sendungen zeigt die App im Postausgang mit deutscher Fehlerbeschreibung und lassen sich erneut senden; gespeichert wird nur ein Fehlercode (z. B. `SMTP_REJECTED`, `SMTP_TEMPORARY`), nie der Fehlertext des Anbieters.

## Push kommt nicht an

1. **Einstellungen → Benachrichtigungen** zeigt den Grund:
   - „keine VAPID-Schlüssel eingerichtet“ → `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` in der `.env` fehlen ([Konfiguration](configuration.md#web-push)); danach `docker compose up -d`.
   - „funktionieren nur in der installierten App“ (iPhone/iPad) → über Safari „Zum Home-Bildschirm“ installieren und Push **in der installierten App** aktivieren.
   - „blockiert“ → in Browser- bzw. Systemeinstellungen für die Seite erlauben.
   - „unterstützt keine Push-Benachrichtigungen“ → anderer Browser oder kein HTTPS (Service Worker inaktiv).
2. Worker-Log prüfen: `push_notify skipped: VAPID keys not configured`, `push delivery failed`, `push subscription expired, removed` (Abo beim Push-Dienst abgelaufen – auf dem Gerät neu aktivieren), `push subscription disabled after failures`.
3. **VAPID-Schlüssel geändert?** Dann sind alle alten Abos ungültig; auf jedem Gerät neu aktivieren.
4. **Domain geändert?** Push-Abos und installierte Apps hängen an der alten Domain – App neu installieren, Push neu aktivieren.
5. Der Server muss die Push-Dienste der Browserhersteller (z. B. `fcm.googleapis.com`, `web.push.apple.com`, Mozilla) ausgehend per HTTPS erreichen.

Push ist nur ein Hinweis: Auch ohne Push gleicht die App beim Öffnen und bei jedem Wechsel in den Vordergrund ab.

## Speicher und Ressourcen

- **Platte voll:** `df -h`, `docker system df`. Größter Posten ist das Volume `mail-data` (verschlüsselte Rohmails). Speicherverbrauch je Konto steht unter **Einstellungen → Konten**. Abhilfe: Build-Cache leeren (`docker builder prune -af`), alte Images (`docker image prune -f`), alte Backups in `./backups/` außer Haus bringen, für große Konten einen kürzeren Sync-Zeitraum wählen. Der Cleanup-Job entfernt alte Jobs, Uploads und verwaiste Dateien automatisch ([Konfiguration](configuration.md#aufräumen-cleanup)).
- **Worker startet ständig neu (`restarting`) / OOM:** `docker inspect --format '{{.State.OOMKilled}}' $(docker compose ps -q worker)` zeigt `true`, wenn das Speicherlimit (384 MB) erreicht wurde. `WORKER_CONCURRENCY` und/oder `MAX_RAW_MESSAGE_BYTES` senken. Läuft ein Job zu lange, bricht er mit `JOB_TIMEOUT` ab; nach einem Absturz meldet der Worker beim Start `lost running jobs recovered` und setzt die Jobs neu an.
- **Speicherlimits greifen nicht (Raspberry Pi):** siehe [Systemanforderungen](system-requirements.md#hinweis-zu-memory-limits-auf-raspberry-pi-systemen).

## Migrationen und Upgrade

API und Worker führen beim Start ausstehende Migrationen aus (`migrations applied` im Log).

| Symptom                                                                       | Ursache / Lösung                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Log: `database schema is newer than this app version (unknown migrations: …)` | Die Datenbank wurde schon von einer neueren Version migriert, der Code ist älter (`SchemaTooNewError`). Auf die neuere Version wechseln – oder, für einen echten Rückschritt, den [Rollback](upgrade.md#rollback) mit dem Backup von vor dem Upgrade durchführen. |
| Eine Migration schlägt fehl, api wird nicht `healthy`                         | Die fehlerhafte Migration wird komplett zurückgerollt, frühere bleiben angewendet. Logzeile notieren, dann [Rollback](upgrade.md#rollback) oder Fehler melden. Nicht von Hand am Schema ändern.                                                                   |
| `upgrade.sh` bricht ab: lokale Änderungen / Ziel kein Nachfolger              | Gewollte Sicherungen, siehe [Upgrade](upgrade.md#upgrade-mit-dem-skript).                                                                                                                                                                                         |

## Backup und Restore

| Meldung                                                                                        | Bedeutung                                                                                                               |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `verify`/`restore` bricht mit Entschlüsselungs- oder `backup is corrupt`/`truncated`-Fehler ab | Falscher `MASTER_KEY` (z. B. neu erzeugte `.env`) oder beschädigte Datei. Mit dem gesicherten Key erneut versuchen.     |
| `restore` verweigert: Ziel nicht leer                                                          | Datenbank hat schon Tabellen oder `mail-data` Dateien. Nur in eine leere Instanz – oder bewusst mit `--force` ersetzen. |
| Backup einer neueren Version abgelehnt                                                         | Erst die App auf mindestens diese Version aktualisieren.                                                                |
| `warning: N unsent outbox message(s)`                                                          | Vor dem Start des Workers den Postausgang prüfen (Doppelversand), siehe [Rollback](upgrade.md#rollback).                |

Details: [Backup & Restore](backup-restore.md).

## Datenbank direkt ansehen

Nur für die Diagnose, nicht für Änderungen:

```sh
docker compose exec postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
```

Mailinhalte (Betreff, Adressen, Snippet, Body, Dateinamen) und Zugangsdaten sind dort verschlüsselt und nicht lesbar – das ist gewollt.
