# Installation ohne Docker

Der Standardweg ist `docker compose up` (ADR-0007). Ohne Docker läuft dieselbe Anwendung direkt mit Node und einem PostgreSQL-Server. Statt der Container gibt es dann **einen einzigen Node-Prozess** (`pnpm start`), in dem API (inkl. PWA) und Worker gemeinsam laufen. Das spart eine Node-Runtime: gemessen ~105 MB RAM statt ~180 MB für zwei getrennte Prozesse (Leerlauf, ohne Konten).

## Voraussetzungen

| Was        | Version                                                                                                   |
| ---------- | --------------------------------------------------------------------------------------------------------- |
| Node       | ≥ 24.11                                                                                                   |
| pnpm       | ≥ 12 (`npm i -g pnpm` oder Corepack)                                                                      |
| PostgreSQL | 17 empfohlen (wie im Compose-Setup); für Backups müssen `pg_dump`/`pg_restore` mindestens gleich neu sein |
| optional   | Caddy (oder ein anderer Reverse Proxy) für HTTPS                                                          |

Web Push und Service Worker brauchen HTTPS mit gültigem Zertifikat. Ohne Reverse Proxy taugt die Installation nur zum Ausprobieren.

## Einrichtung

```sh
git clone <repo> fastmail-alternative && cd fastmail-alternative
pnpm install
pnpm build                     # baut PWA, API und Worker
node scripts/setup-env.mjs     # erzeugt .env mit MASTER_KEY, VAPID, DB-Passwort
```

**`MASTER_KEY` aus der `.env` sofort getrennt sichern** (Passwortmanager o. Ä.). Ohne ihn sind alle Mails und Zugangsdaten unlesbar.

Datenbank anlegen, mit Benutzer und Passwort aus der `.env`:

```sh
sudo -u postgres psql -c "CREATE ROLE mail LOGIN PASSWORD '<POSTGRES_PASSWORD aus .env>'"
sudo -u postgres psql -c "CREATE DATABASE mail OWNER mail"
```

Läuft PostgreSQL nicht auf `localhost:5432`, in der `.env` `POSTGRES_HOST` und `POSTGRES_PORT` ergänzen.

## Starten

```sh
pnpm start
```

- Migrationen laufen beim Start automatisch.
- Die App lauscht auf `http://127.0.0.1:3001` (nur lokal). Für einen Test im Heimnetz ohne Proxy `HOST=0.0.0.0` setzen, z. B. in der `.env`.
- Mails liegen verschlüsselt in `data/mail-data/` im Projektordner (änderbar per `MAIL_DATA_DIR`).
- Stürzt der Worker-Teil ab, fährt `pnpm start` auch die API herunter und endet mit Fehlercode. Neu starten ist Aufgabe des Supervisors (systemd, siehe unten).
- Bei SIGINT/SIGTERM (Strg+C, `systemctl stop`) werden laufende Jobs noch zu Ende geführt, wie beim Worker-Container.

Alle Variablen aus [`.env.example`](../../.env.example) gelten unverändert. `DOMAIN` wird nur von Caddy gelesen.

## HTTPS mit Caddy

Das [`Caddyfile`](../../Caddyfile) aus dem Repo funktioniert auch mit einem lokal installierten Caddy. Es braucht nur das Ziel der API:

```sh
DOMAIN=mail.example.com API_UPSTREAM=127.0.0.1:3001 caddy run --config Caddyfile
```

Ein eigener nginx/Apache leitet einfach **alle** Pfade an `127.0.0.1:3001` weiter. Die API liefert PWA und `/api/*` und setzt die Security-Header selbst.

## Als Dienst (systemd)

`/etc/systemd/system/fastmail-alternative.service`:

```ini
[Unit]
Description=fastmail-alternative (api + worker)
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
User=mail
WorkingDirectory=/opt/fastmail-alternative
ExecStart=/usr/bin/node scripts/native.mjs start
Restart=on-failure
RestartSec=5
# Entspricht den Limits aus docker-compose.yml (api 192 MB + worker 384 MB).
MemoryMax=600M
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/opt/fastmail-alternative/data

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload && sudo systemctl enable --now fastmail-alternative
journalctl -u fastmail-alternative -f     # Logs (JSON, ohne Mailinhalte)
```

## Update

```sh
git pull
pnpm install
pnpm build
sudo systemctl restart fastmail-alternative
```

## Backup

Dasselbe verschlüsselte Backup-Format wie im Docker-Setup ([Backup & Restore](backup-restore.md)). Während des Backups muss der Dienst gestoppt sein, damit Datenbank und `mail-data` zusammenpassen:

```sh
sudo systemctl stop fastmail-alternative
pnpm backup create ./backups
sudo systemctl start fastmail-alternative
```

`pnpm backup verify <datei>` und `pnpm backup restore <datei>` funktionieren genauso. Liegen `pg_dump`/`pg_restore` nicht im `PATH`, zeigt `PG_BIN` auf ihren Ordner (z. B. `PG_BIN=/usr/lib/postgresql/17/bin`).

## Unterschiede zum Docker-Setup

|                         | Docker                             | Ohne Docker                             |
| ----------------------- | ---------------------------------- | --------------------------------------- |
| Prozesse                | getrennte Container                | ein Node-Prozess für API und Worker     |
| `mail-data` für die API | nur lesend eingebunden             | gleicher Benutzer, technisch schreibbar |
| Speicherlimits          | je Service (`mem_limit`)           | gemeinsam (`MemoryMax` in systemd)      |
| Last beim Sync          | betrifft nur den Worker            | kann die Oberfläche kurz verlangsamen   |
| TLS                     | Caddy im Compose                   | eigener Caddy/Proxy                     |
| PostgreSQL              | Container, getunt für Einzelnutzer | eigene Installation und Pflege          |

Die API schreibt `mail-data` auch ohne Docker nicht. Der Nur-Lesen-Schutz ist dort aber eine Eigenschaft des Codes und nicht mehr des Deployments. Weil API und Worker sich eine Event-Loop teilen, kann ein großer Initial-Sync (Verschlüsseln, Parsen) die Antwortzeiten der Oberfläche spürbar erhöhen; im Docker-Setup ist das durch die Trennung ausgeschlossen.
