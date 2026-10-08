# Testbericht 2026-10-05 – lokale Verifikation

> Hinweis: Dieser Bericht bezieht sich auf den damaligen Stack mit Node-Backend (`apps/api`, `apps/worker`) und PostgreSQL, der mit #110 entfernt wurde. Die Ergebnisse gelten für diesen Stand; heute betreibt Docker Compose das PHP-Backend (`apps/server-php`) mit MariaDB.

Umgebung: macOS (arm64), Docker Desktop 27.3.1 / Compose 2.29.7, Node 25.2.1, pnpm 12.8.1. Der PC ersetzt den Raspberry Pi als Testumgebung; jedes Szenario lief in einem eigenen Compose-Projekt (`install`, `upgrade`, `restore`) unter `~/Documents/work/fma-local-test/`. Ausgaben ohne Secrets und Mailinhalte; Testdaten nur mit GreenMail (`greenmail/standalone:2.1.14`).

Dauern mit warmem Build-Cache – nicht repräsentativ für den Pi.

## Ergebnis

| #   | Punkt                                           | Ergebnis                                           |
| --- | ----------------------------------------------- | -------------------------------------------------- |
| 1   | Frische Installation nach Doku (#61, #22)       | ok – nach Doku-Korrekturen                         |
| 2   | Upgrade 3541603 → `main` und Rollback (#59)     | ok – Doku-Lücken, siehe Befunde                    |
| 3   | Backup/Restore in frisches Projekt (#57)        | ok – **Doppelversand nach Restore** behoben (Doku) |
| 4   | Release-Override (#62), `docker compose config` | ok                                                 |
| 5   | UI-Abnahme im Browser (Handy-Viewport, Touch)   | ok – 2 Bugs gefunden und behoben                   |
| 6   | Playwright-E2E (#74, #75)                       | ok – CI-Job, erster Gesamtlauf: 3 Befunde behoben  |
| 7   | Lasttest (#60)                                  | nicht durchgeführt (optional)                      |

## 1. Frische Installation nach `installation.md`

`git clone`, `node scripts/setup-env.mjs` (`.env` mit `0600`, `DOMAIN=:80`), `docker compose up -d --build --wait`.

- **Fehler:** `Bind for 127.0.0.1:5432 failed: port is already allocated` – auf dem Host lief bereits eine PostgreSQL-Instanz. Der Port war fest verdrahtet und in der Installationsdoku nicht erwähnt. **Behoben:** `POSTGRES_HOST_PORT` (Default 5432) in `docker-compose.yml`, `.env.example`, `configuration.md`, Hinweis in `installation.md`.
- Danach: alle fünf Dienste `healthy`, **inkl. worker** (Heartbeat nach ca. 10 s) – #22 bestätigt.
- Setup-Code: `docker compose logs api | grep "FIRST-RUN SETUP CODE"` liefert genau eine Zeile; Einrichtungsseite wie beschrieben.
- `GET /api/health` → `{"status":"ok", … "database":"ok"}`.

Doku-Abweichungen (korrigiert in `installation.md`):

- „wartet, bis caddy, web, api und postgres healthy sind“ – der worker gehört inzwischen dazu.
- „`docker compose logs api` → migrations applied“ – die Zeile schreibt, wer den Advisory Lock zuerst bekommt (hier der worker).
- „certificate obtained“ erscheint bei `DOMAIN=:80` nicht; nur mit Domain.

## 2. Upgrade-Pfad und Rollback

Projekt `upgrade` auf 3541603 (Migrationen bis 0019), GreenMail im Compose-Netz, Ports per untracked `docker-compose.override.yml` (`ports: !override`). Testdaten per API: 1 Benutzer, 1 Konto, 5 Nachrichten, 1 Entwurf.

- 3541603 kennt `MAIL_INSECURE_TRANSPORT` noch nicht und erzwingt auch kein STARTTLS; dort genügte `MAIL_ALLOW_PRIVATE_HOSTS=1`.
- **3541603 hat noch kein `scripts/upgrade.sh`** (kam mit PR #77). Das Skript aus `main` wurde nach `.upgrade-bootstrap/` (untracked) gelegt und von dort gestartet. Eine Kopie nach `scripts/` lässt `git checkout` scheitern („untracked working tree files would be overwritten“).
- `upgrade.sh main` aus detached HEAD: ok (33 s). Zählwerte identisch, Login ok, alte Session gültig, `schema_migrations` enthält 0020 und 0021, `backups/upgrade-previous` mit `PREVIOUS_REF`/`PREVIOUS_BACKUP`/`UPGRADE_TARGET`, alle Dienste `healthy`. Ein Downgrade-Ziel wird abgelehnt (exit 1). Die untracked Override-Datei blockiert das Skript nicht.
- `docker image prune -f` löscht die Images der Vorversion; ein Rollback muss neu bauen (vorher und nachher 0 fremde dangling Images).
- **Rollback exakt nach `upgrade.md`:** jeder Befehl funktionierte (53 s). Stand 3541603, `schema_migrations` endet bei 0019, Login ok; die nach dem Backup eingegangene Mail holte der Worker binnen Sekunden nach. `restore --force` warnte nicht vor ungesendeten Outbox-Einträgen – die alte Version kennt die Warnung noch nicht (Doku ergänzt).

## 3. Backup/Restore

Im (wieder auf `main` gehobenen) Projekt eine ungesendete Outbox-Mail erzeugt (Worker gestoppt, `POST /api/outbox` → `queued`). Backup händisch nach Doku mit gestopptem Worker (`backup.sh` startet ihn am Ende wieder und hätte die Mail versendet). `verify`: `backup ok: 6 files, 21 migrations`.

Restore in das frische Projekt `restore` exakt nach `backup-restore.md` (gesicherte `.env` per `cp`, nur postgres, `verify`, `restore`, `up -d`):

- `restore` meldet `warning: 1 unsent outbox message(s) …` – ok.
- Login mit dem alten Benutzer, Zählwerte stimmen, alle `healthy`.
- **Fehler:** Schritt 4 (`docker compose up -d`) startete den Worker sofort, die Outbox-Mail wurde **ohne Prüfung versendet** (`send_message accepted by smtp`). **Behoben (Doku):** Restore startet erst ohne Worker, Outbox prüfen, dann Worker; Hinweis, die alte Instanz vorher zu stoppen.
- `restore` ohne `--force` auf nicht leeres Ziel → exit 1 („restore target is not empty … use --force“) – ok.
- `verify` und `restore --force` mit falschem 32-Byte-Key → exit 1, Ziel unverändert – ok.
- `verify` mit formal ungültigem Key (zu kurz) → exit 1, aber nur `backup failed: Error` (siehe offene Punkte).
- Der erste `docker compose run` baute das Worker-Image implizit (Doku: vorher `docker compose build`).

## 4. Release-Override

- `FMA_VERSION=0.1.0 docker compose -f docker-compose.yml -f docker-compose.release.yml config`: web/api/worker mit `ghcr.io/mszkb/fastmail-alternative-<app>:0.1.0`, kein `build` (`!reset` funktioniert mit Compose 2.29.7) – ok.
- Ohne `FMA_VERSION`: Abbruch mit „set FMA_VERSION, e.g. 0.1.0“ – ok. `FMA_IMAGE_PREFIX` wird übernommen – ok.
- Mit `-f` lädt Compose eine `docker-compose.override.yml` **nicht** mehr automatisch; `backup.sh`, `upgrade.sh` und die Doku-Befehle nutzen schlichtes `docker compose` und würden lokal bauen (offener Punkt, Vorschlag: `COMPOSE_FILE` in `.env`).

## 5. UI-Abnahme (Chromium, Pixel-7-Viewport mit Touch)

Gegen den lokalen Stack aus `e2e/stack.mjs` (gleiche CSP-Header wie nginx), automatisiert mit Playwright:

| Ablauf                                                                                       | Ergebnis           |
| -------------------------------------------------------------------------------------------- | ------------------ |
| Ersteinrichtung (falscher Setup-Code abgelehnt), Logout, Login (falsches Passwort abgelehnt) | ok                 |
| Konto anlegen (Formular, Verbindungstest)                                                    | ok                 |
| **Neues Konto direkt öffnen**                                                                | **Bug 1**, behoben |
| Mail lesen: HTML mit Inline-Bild (cid:), Anhang-Download, gelesen-Markierung                 | ok                 |
| Entwurf mit Anhang speichern, schließen, wieder öffnen, verwerfen                            | **Bug 2**, behoben |
| Weiterleiten mit Anhang + Inline-Bild, Empfang beim zweiten Konto                            | ok                 |
| `sync_since` (30 Tage): alte Mail nicht synchronisiert, „Ältere Mails laden“ holt sie        | ok                 |
| Speicheranzeige je Konto und gesamt                                                          | ok                 |
| Gemeinsamer Posteingang ein/aus (bleibt nach Reload aus)                                     | ok                 |
| Aktualisieren-Button, Pull-to-Refresh (kurzer Zug löst nichts aus)                           | ok, siehe Hinweis  |
| Swipe-Back: Nachricht → Liste; Start im linken 20-px-Rand ignoriert                          | ok                 |
| Swipe-Back mit halb ausgefülltem Kontoformular / offenem Entwurf: kein Datenverlust          | ok                 |
| Passwortwechsel: andere Sitzung abgemeldet, eigene bleibt; Fehlerfälle                       | ok                 |

**Bug 1** – Ordnerliste eines neuen Kontos blieb leer („Noch keine Ordner synchronisiert“), obwohl der Zähler schon neue Mails zeigte. Ursache: `refreshView()` brach ab, solange kein Ordner offen war (`apps/web/app/components/MailView.vue`). Fix: ohne offenen Ordner die Ordner neu laden. Regressionstest: `e2e/tests/new-account.spec.ts` (vor dem Fix rot, danach grün).

**Bug 2** – „Entwurf gespeichert“ erschien nie; Schließen speicherte unnötig erneut. Ursache: `dirty` (computed) verglich mit `lastSaved`, einer nicht reaktiven Variable (`apps/web/app/components/ComposeForm.vue`). Fix: `lastSaved` als `ref`. Regressionstest: `e2e/tests/compose.spec.ts` (vor dem Fix rot).

**Hinweis (kein Bug, Design):** Direkt nach dem Öffnen ist das Aktualisieren gesperrt, solange der Start-Sync läuft; danach lehnt der Server einen weiteren manuellen Sync desselben Kontos 30 s lang ab („Gerade aktualisiert.“). Neue Mails bei offener App erscheinen spätestens mit dem 60-s-Kontenabgleich. Als offene Frage notiert.

Kleiner Layout-Befund: Im Verfassen-Dialog klebt die Anhangsliste am linken Rand (Handy-Viewport).

## Vorbestehende Testfehler

`apps/worker/test/quotas.test.ts › never runs more jobs per IMAP host than the limit` war auf `main` unter macOS rot (`listen EADDRNOTAVAIL 127.0.0.2`: macOS bindet nur `127.0.0.1` auf `lo0`). Der Test überspringt sich jetzt, wenn die Adresse nicht bindbar ist; unter Linux/CI läuft er unverändert.

## Nachtrag: erster Gesamtlauf und CI-Job (#74)

Lokal liefen die Specs nur einzeln. Der erste Gesamtlauf in einem Durchgang (Linux-Container, Node 24, PostgreSQL 16, GreenMail 2.1.14 als JAR, Chromium) war zunächst rot:

| Befund                                                                                       | Ursache                                                                                                                                                  | Behebung                                                                                             |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Alle Specs nach `password.spec` landeten auf der Anmeldeseite                                | Der Passwortwechsel rotiert das Token der eigenen Sitzung (gewollt); die gemeinsame `.auth/state.json` hielt noch das alte                               | Test: Storage-State nach dem Wechsel neu schreiben                                                   |
| Swipe-Back-Tests: leere Seite nach dem Wischen                                               | Das volle Chromium führt bei der Touch-Geste die eigene History-Navigation aus (die Headless-Shell nicht)                                                | Test-Konfiguration: `--disable-features=OverscrollHistoryNavigation`                                 |
| **Neues Konto blieb leer** („Noch keine Ordner synchronisiert“), auch einzeln reproduzierbar | **App-Bug:** Nach „Konto hinzufügen“ (und Import) öffnete die App das Poll-Fenster nicht; das Ende des Erst-Syncs fiel erst beim 60-s-Kontenabgleich auf | `app.vue`: Poll-Fenster wie beim manuellen Sync öffnen; `new-account.spec` deckt das ab (vorher rot) |

Danach alle 12 Tests grün in ca. 75 s. Der CI-Job „Browser tests (Playwright)“ (`.github/workflows/ci.yml`) startet PostgreSQL (eigene Datenbank `mail_e2e`) und GreenMail als Services, baut, installiert Chromium und lädt bei Fehlschlag HTML-Report und Traces als Artifact hoch.

Weitere Punkte aus diesem Bericht, inzwischen erledigt:

- `upgrade.md`: Bootstrap für das erste Upgrade (`.upgrade-bootstrap/`), ältere Versionen ohne Worker-Healthcheck, detached HEAD nach Rollback, `UPGRADE_TARGET` im händischen `printf`.
- Release-Images dauerhaft per `COMPOSE_FILE` in `.env` (installation, configuration, upgrade, release); mit Compose 5.3 per `docker compose config` geprüft, auch dass eine eigene `docker-compose.override.yml` dann nur geladen wird, wenn sie in `COMPOSE_FILE` steht.
- `backup.js`: ungültiger `MASTER_KEY` → `backup failed: MASTER_KEY is invalid: expected 32 bytes, base64-encoded …` (Test in `apps/worker/test/backup.test.ts`).
- `upgrade.sh`: `image prune` nur mit `label=com.docker.compose.project=<projekt>`; Abbruch vor dem Backup bei untracked Dateien, die das Ziel mitbringt; Abbruch bei Release-Images. Geprüft mit einem Test-Repository und einem Docker-Stub (Docker selbst lief in dieser Umgebung nicht).
- Anhangsliste im Verfassen-Dialog: gleicher Innenabstand wie die Felder (Assertion in `compose.spec`, vorher rot).
- Produktfragen zum Sync-Verhalten: [offene-fragen.md](../product/offene-fragen.md).

## Offene Punkte

- Lasttest (#60) – braucht Docker mit Speicherlimits, bleibt lokal.
- `upgrade.sh`-Änderungen einmal gegen ein echtes Compose-Projekt laufen lassen (Label-Filter beim `image prune`).
