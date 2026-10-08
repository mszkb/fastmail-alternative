# Upgrade auf eine neue Version

Ein Upgrade besteht immer aus denselben vier Schritten:

1. **Backup** mit der bisherigen Version ([Backup & Restore](backup-restore.md))
2. **Neue Version** auschecken und Images bauen (die alten Container laufen dabei weiter)
3. **Migrationen**: Der php-Container wendet beim Start alle ausstehenden Migrationen an
4. **Health-Check**: warten, bis alle Dienste `healthy` sind

`scripts/upgrade.sh` erledigt das automatisch.

> **Noch auf dem früheren Node-Backend (PostgreSQL)?** Dann gilt einmalig [Installationen mit dem früheren Node-Backend](#installationen-mit-dem-früheren-node-backend); `upgrade.sh` bricht in diesem Fall ab.

## Upgrade mit dem Skript

Im Projektverzeichnis (auf dem Raspberry Pi `~/fastmail-alternative`):

```sh
./scripts/upgrade.sh            # aktuellen Branch per fast-forward aktualisieren
./scripts/upgrade.sh v1.2.0     # auf einen bestimmten Tag/Branch/Commit wechseln
```

Das Skript

- bricht ab, wenn der Checkout lokale Änderungen hat oder **untracked Dateien** einen Pfad belegen, den das Ziel mitbringt – auch als übergeordnetes Verzeichnis oder als Verzeichnis an der Stelle einer neuen Datei (sonst würde `git checkout` erst nach dem Backup scheitern),
- bricht ab, solange das Volume `<projekt>_postgres-data` des früheren Node-Backends existiert ([siehe unten](#installationen-mit-dem-früheren-node-backend)),
- bricht ab, wenn web und php nicht beide lokal gebaut werden (der worker nutzt das php-Image), also bei [Release-Images](#fertige-images-statt-lokal-bauen) (`COMPOSE_FILE` mit `docker-compose.release.yml`) – dafür gilt der händische Ablauf unten,
- holt die neuen Stände (`git fetch`) und löst das Ziel auf – bei einem Branch-Namen den Stand von `origin/<branch>`, nicht einen evtl. veralteten lokalen Branch – und bricht ab, wenn das Ziel **kein Nachfolger** des aktuellen Commits ist (ein Downgrade ist ein [Rollback](#rollback) und braucht das Backup der alten Version),
- erstellt mit `scripts/backup.sh` ein verschlüsseltes Backup nach `./backups/` (Worker ist dafür kurz gestoppt, die API im php-Container läuft weiter) und verwendet nur eine Datei, die **dieser Lauf** geschrieben hat (Marker-Datei vor dem Backup, `find -newer`) – nie ein älteres Backup,
- hält den bisherigen Commit **und den Pfad dieses Backups** in `backups/upgrade-previous` fest (`PREVIOUS_REF=…`, `PREVIOUS_BACKUP=…`, `UPGRADE_TARGET=…`). Bei einem erneuten Aufruf, wenn der Checkout schon auf dem Ziel steht (z. B. nach einem fehlgeschlagenen Build), bleibt die Datei unverändert – sie verweist weiter auf das Backup von vor dem ersten Versuch. Existiert diese Backup-Datei nicht mehr, bricht `upgrade.sh` nicht ab, warnt aber deutlich, dass ein Rollback per Restore nicht möglich ist (ein neues Backup ersetzt sie bewusst nicht, weil es schon migrierte Daten enthalten kann). `scripts/backup.sh` löscht die dort genannte Datei bei der Aufbewahrung (`BACKUP_KEEP_DAYS`) nicht,
- wechselt auf die neue Version (`git checkout` bzw. fast-forward des Branches auf `origin/<branch>`),
- baut die Images (`docker compose build`),
- startet alles mit `docker compose up -d --wait` und meldet einen Fehler, wenn ein Dienst nicht `healthy` wird. Alle Dienste haben einen Healthcheck; beim Worker heißt `healthy`, dass seine Job-Schleife regelmäßig Durchläufe schafft (Heartbeat, siehe [Troubleshooting](troubleshooting.md)),
- räumt danach die unbenannten Images **dieses Compose-Projekts** weg (`docker image prune -f --filter label=com.docker.compose.project=<projekt>`); Images anderer Projekte oder Container auf demselben Docker-Host bleiben unberührt. Die Images der Vorversion sind danach gelöscht; ein Rollback baut sie neu (auf dem Pi einige Minuten).

Schlägt ab dem Checkout ein Schritt fehl, gibt das Skript den Rollback-Hinweis mit altem Commit und Backup-Pfad aus.

Nach einem Wechsel auf einen Tag oder Commit – und nach einem [Rollback](#rollback) – steht der Checkout auf einem „detached HEAD“. `./scripts/upgrade.sh` ohne Ziel bricht dann mit `no upstream branch (detached HEAD?)` ab; das nächste Upgrade deshalb mit Ziel aufrufen (`./scripts/upgrade.sh v1.3.0` bzw. `./scripts/upgrade.sh main`). Kein `git switch main` von Hand: der lokale Branch kann noch auf der zurückgerollten Version stehen.

### Händisch

Ohne Skript entspricht das:

```sh
git fetch --tags origin
git merge-base --is-ancestor HEAD v1.2.0   # Ziel muss Nachfolger sein
./scripts/backup.sh
# PREVIOUS_BACKUP = die Datei, die backup.sh eben ausgegeben hat ("backup written: …")
printf 'PREVIOUS_REF=%s\nPREVIOUS_BACKUP=%s\nUPGRADE_TARGET=%s\n' "$(git rev-parse HEAD)" \
  "backups/fma-backup-<zeitstempel>.fmabk" "$(git rev-parse 'v1.2.0^{commit}')" \
  > backups/upgrade-previous
git checkout v1.2.0
docker compose build
docker compose up -d --wait
```

**Prüfen:** `--wait` wartet auch auf den Worker-Healthcheck (Heartbeat nach jedem Durchlauf der Job-Schleife, bis zu 2 min nach dem Start). Er sagt nichts über die Mailkonten aus: Bei Problemen `docker compose logs --tail=50 php worker` auf Start- oder Migrationsfehler (`migration failed`) prüfen; Verbindungsprobleme einzelner Konten zeigt die Kontoliste.

Zwischen Backup und Neustart geschriebene Daten (neue Mails, gesendete Nachrichten) wären bei einem Rollback verloren; neue Mails holt der Worker danach beim Anbieter nach.

## Fertige Images statt lokal bauen

Optional, statt `docker compose build` auf dem Server (Standard auf dem Pi bleibt der lokale Build per `upgrade.sh`). Die signierten Release-Images ([Release-Prozess](../process/release.md)) dauerhaft einschalten, indem die Instanz die Compose-Dateien und die Version aus der `.env` liest:

```sh
# in .env
COMPOSE_FILE=docker-compose.yml:docker-compose.release.yml
FMA_VERSION=1.1.0
```

Damit benutzen **alle** `docker compose`-Befehle – auch `scripts/backup.sh`, die Restore-Befehle und die Befehle in dieser Doku – die Release-Images, ohne jedes Mal `-f … -f …` anzugeben. Eine eigene `docker-compose.override.yml` lädt Compose dann **nicht mehr automatisch**; sie muss als dritte Datei angehängt werden: `COMPOSE_FILE=docker-compose.yml:docker-compose.release.yml:docker-compose.override.yml`. Prüfen mit `docker compose config --images` (web, php, worker zeigen auf `ghcr.io/…:<FMA_VERSION>`).

`scripts/upgrade.sh` bricht bei Release-Images ab (es würde sonst nur den Checkout wechseln, aber die alten Images weiterlaufen lassen). Upgrade von Hand – das Backup läuft dabei bewusst noch mit der **alten** `FMA_VERSION`:

```sh
git fetch --tags origin
git merge-base --is-ancestor HEAD v1.2.0   # Ziel muss Nachfolger sein
./scripts/backup.sh                        # alte Version, Pfad aus "backup written: …" notieren
printf 'PREVIOUS_REF=%s\nPREVIOUS_BACKUP=%s\nUPGRADE_TARGET=%s\n' "$(git rev-parse HEAD)" \
  "backups/fma-backup-<zeitstempel>.fmabk" "$(git rev-parse 'v1.2.0^{commit}')" \
  > backups/upgrade-previous
git checkout v1.2.0                        # Compose-Datei und Doku zur Version
# in .env: FMA_VERSION=1.2.0 (alte Version notieren - für einen Rollback)
cosign verify --certificate-identity-regexp '^https://github\.com/mszkb/fastmail-alternative/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/mszkb/fastmail-alternative-server-php:1.2.0   # optional, ebenso web
docker compose pull
docker compose up -d --wait
```

Rollback: wie unter [Rollback](#rollback), statt `docker compose build` die alte `FMA_VERSION` in `.env` eintragen und `docker compose pull`. Patch-Releases enthalten keine Migrationen und lassen sich ohne Restore zurücksetzen.

Ohne Eintrag in `.env` funktionieren die Release-Images auch pro Befehl (`FMA_VERSION=1.2.0 docker compose -f docker-compose.yml -f docker-compose.release.yml up -d --wait`); dann aber jeden weiteren Befehl ebenso aufrufen – ein schlichtes `docker compose` (auch in `backup.sh`) würde lokal bauen.

## Wie Migrationen laufen

- Migrationen sind reines SQL (`apps/server-php/migrations/NNNN_name.sql`), werden in fester Reihenfolge angewendet und in `schema_migrations` vermerkt. Ein erneuter Start wendet nichts doppelt an.
- Der php-Container führt sie bei jedem Start aus (`php bin/migrate.php`, danach php-fpm); auf Webspace der Installer bzw. `php bin/migrate.php`. Eine Datenbanksperre (`GET_LOCK`) verhindert, dass zwei Prozesse gleichzeitig migrieren.
- **MySQL/MariaDB kennt keine transaktionalen Schemaänderungen:** Eine fehlgeschlagene Migration kann teilweise angewendet sein. Jede Anweisung ist deshalb wiederholbar geschrieben (`IF NOT EXISTS` usw.); nach Behebung der Ursache wird die Migration beim nächsten Start einfach erneut angewendet. Schlägt sie fehl, startet php-fpm nicht (`migration failed` im Log, Healthcheck schlägt fehl).
- Migrationen sind **nur vorwärts** (keine Down-Migrationen).
- **Startschutz gegen zu alte Versionen:** Kennt die App Migrationen in der Datenbank nicht (eine neuere Version hat sie schon migriert), bricht `bin/migrate.php` mit `migration refused` ab und der `php`-Container startet nicht; `bin/cron.php`, `bin/worker.php` und der Web-Cron arbeiten dann keine Jobs ab (`jobs refused` im Log, Web-Cron `503`). Ein Rückschritt deshalb immer als [Rollback](#rollback) mit Restore (`--force` baut das Schema der alten Version neu auf). Versionen vor dieser Prüfung starten auf dem neueren Schema trotzdem – auch dann nur per Rollback zurückwechseln. Das Einspielen von Backups einer neueren Version lehnt `backup restore` ab.

## Rollback

Weil Migrationen nur vorwärts laufen, heißt Rollback: **alte Version + Backup von vor dem Upgrade**.

```sh
cd ~/fastmail-alternative
BACKUP_DIR="${BACKUP_DIR:-$PWD/backups}"   # wie in scripts/upgrade.sh
cat "$BACKUP_DIR/upgrade-previous"      # alter Commit + Backup von vor dem Upgrade
. "$BACKUP_DIR/upgrade-previous"        # setzt PREVIOUS_REF und PREVIOUS_BACKUP
git checkout "$PREVIOUS_REF"
docker compose build
docker compose stop php worker
docker compose run --rm --no-deps --user root -v "$BACKUP_DIR:/backups" php \
  php bin/console backup restore "/backups/$(basename "$PREVIOUS_BACKUP")" --force
# Nur nötig, wenn die alte Version die Dateien nach dem Restore noch nicht selbst übergibt (harmlos sonst):
docker compose run --rm --no-deps --user root php chown -R www-data:www-data /data/mail
docker compose up -d --wait caddy web php mariadb   # Worker bleibt gestoppt
# Nicht gesendete Postausgangs-Einträge anzeigen (nur IDs/Zeiten, keine Inhalte):
docker compose exec mariadb sh -c 'mariadb -u"$MARIADB_USER" -p"$MARIADB_PASSWORD" "$MARIADB_DATABASE" -e "
  SELECT id, account_id, status, created_at FROM outbox_message
  WHERE sent_at IS NULL AND status IN ('"'"'queued'"'"', '"'"'sending'"'"') ORDER BY created_at"'
# ... mit den Gesendet-Ordnern beim Anbieter abgleichen, bereits gesendete entfernen:
# docker compose exec mariadb sh -c 'mariadb -u"$MARIADB_USER" -p"$MARIADB_PASSWORD" "$MARIADB_DATABASE" -e "
#   DELETE FROM outbox_message WHERE id = '"'"'<id>'"'"'"'
docker compose up -d --wait worker
```

Danach steht der Checkout auf einem **detached HEAD** (`$PREVIOUS_REF` ist ein Commit): das nächste Upgrade mit Ziel aufrufen, z. B. `./scripts/upgrade.sh main` ([siehe oben](#upgrade-mit-dem-skript)).

**Doppelversand vermeiden:** Das Backup kann Postausgangs-Einträge enthalten, die damals noch nicht gesendet waren, inzwischen (nach dem Backup) aber per SMTP verschickt wurden. Nach dem Restore stehen sie wieder als ungesendet in der Datenbank – ein Start des Workers würde sie **erneut senden**. Deshalb den Worker erst starten, nachdem die ausstehenden Einträge geprüft wurden: Was laut Gesendet-Ordner beim Anbieter schon verschickt ist, entfernen. `restore` weist auf solche Einträge hin (`warning: N unsent outbox message(s) …`, nur die Anzahl).

Maßgeblich ist das in `backups/upgrade-previous` festgehaltene Backup – nicht einfach das neueste in `backups/`: ein späterer Cron-Lauf oder ein erneuter Aufruf von `upgrade.sh` kann inzwischen ein Backup mit bereits migrierter Datenbank geschrieben haben. `restore --force` prüft das Backup vollständig, bevor es Datenbank und `mail-data` ersetzt. Details: [Backup & Restore](backup-restore.md).

Ist nur der Build oder Start fehlgeschlagen, **bevor** eine Migration lief (z. B. Build-Fehler), genügt `git checkout <alter commit>`, `docker compose build` und `docker compose up -d --wait` – ohne Restore.

## Installationen mit dem früheren Node-Backend

Bis zur Umstellung auf das PHP-Backend ([ADR-0013](../adr/0013-php-backend.md)) lief der Stack mit Node (Dienste `api`, `worker`) und PostgreSQL. **Eine Datenübernahme gibt es nicht:** Die Instanz wird neu aufgesetzt, die Mails holt der Worker danach wieder per IMAP vom Anbieter (beim Anbieter ändert sich nichts). Verloren gehen nur Daten, die allein auf dem Server lagen: Benutzer und Passwort der App, Geräte/Sitzungen, Push-Abos und noch nicht gesendete Postausgangs-Einträge. Alte Backups (`.fmabk`) lassen sich in das PHP-Backend nicht einspielen.

`scripts/upgrade.sh` bricht ab, solange das Volume `<projekt>_postgres-data` existiert, und verweist hierher. Im Projektverzeichnis (auf dem Pi `~/fastmail-alternative`):

1. **Optional, mit der alten Version:** unter **Einstellungen → Konfiguration übertragen → Exportieren** die Kontoeinstellungen sichern ([Umzug, Weg B](migration.md#b-konfiguration-exportieren-und-importieren)); dann müssen nach dem Neuaufsetzen nur die Passwörter neu eingegeben werden. Ungesendetes im Postausgang vorher senden oder notieren.
2. **Mit dem alten Checkout** Container und Volumes löschen – das löscht die alte Datenbank und `mail-data` (gewollt) sowie die Zertifikate in `caddy-data` (Caddy holt beim Start neue):

   ```sh
   docker compose down -v
   ```

3. **`.env`:** Behalten und `MARIADB_PASSWORD=<Zufallswert>` ergänzen (z. B. `openssl rand -base64 24`), die `POSTGRES_*`-Zeilen dürfen entfallen. Oder neu erzeugen: alte `.env` beiseitelegen (`mv .env .env.node`) und `./scripts/setup-env.sh` ausführen, danach `DOMAIN` und `VAPID_SUBJECT` wieder eintragen. Mit neuen VAPID-Schlüsseln muss Push ohnehin auf jedem Gerät neu aktiviert werden.
4. **Neue Version auschecken und starten:**

   ```sh
   git fetch origin
   git checkout main            # bzw. ein Tag, z. B. v1.2.0
   docker compose up -d --build --wait
   ```

5. **Ersteinrichtung** wie bei einer Neuinstallation ([Installation, Schritt 6](installation.md#6-benutzer-anlegen-ersteinrichtung)): `docker compose exec php php bin/setup-code.php`, Benutzer anlegen, dann die Mailkonten neu hinzufügen bzw. die Exportdatei importieren und je Konto das Passwort eingeben. App auf den Geräten neu anmelden und Push neu aktivieren.
6. Neues Backup einrichten bzw. prüfen ([Backup & Restore](backup-restore.md)); das Format ist neu, alte Backup-Dateien können weg.

Ab dann laufen Upgrades wieder mit `./scripts/upgrade.sh`.

## Hinweise für den Raspberry Pi

- **Speicher:** Die Container sind begrenzt (u. a. worker 384 MB, php 256 MB). Migrationen sind so geschrieben, dass sie keine Daten in den Speicher laden; der Build (`docker compose build`) ist nicht begrenzt und braucht auf dem Pi einige Minuten und den meisten Arbeitsspeicher. Bei sehr knappem RAM vorher Swap prüfen (`free -h`).
- **Platz:** Backup und neue Images brauchen zusätzlichen Platz. Vor dem Upgrade `df -h` und `docker system df` prüfen; `upgrade.sh` entfernt danach nicht mehr benutzte Images.
- **Rootless Docker:** Skript als der Benutzer ausführen, unter dem Docker läuft (über SSH: `ssh raspberrypi`, dann `cd ~/fastmail-alternative`). Bei Aufruf aus Cron/Skripten `XDG_RUNTIME_DIR` und `DOCKER_HOST` setzen wie bei den [automatischen Backups](backup-restore.md#automatisch-per-cron-raspberry-pi-rootless-docker).
- **`.env` bleibt unverändert.** Neue optionale Variablen stehen in `.env.example`; der `MASTER_KEY` darf nie neu erzeugt werden.
