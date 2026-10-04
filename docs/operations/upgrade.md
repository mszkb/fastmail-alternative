# Upgrade auf eine neue Version

Ein Upgrade besteht immer aus denselben vier Schritten:

1. **Backup** mit der bisherigen Version ([Backup & Restore](backup-restore.md))
2. **Neue Version** auschecken und Images bauen (die alten Container laufen dabei weiter)
3. **Migrationen**: Die API führt beim Start alle ausstehenden Migrationen aus
4. **Health-Check**: warten, bis alle Dienste `healthy` sind

`scripts/upgrade.sh` erledigt das automatisch.

## Upgrade mit dem Skript

Im Projektverzeichnis (auf dem Raspberry Pi `~/fastmail-alternative`):

```sh
./scripts/upgrade.sh            # aktuellen Branch per fast-forward aktualisieren
./scripts/upgrade.sh v1.2.0     # auf einen bestimmten Tag/Branch/Commit wechseln
```

Das Skript

- bricht ab, wenn der Checkout lokale Änderungen hat,
- holt die neuen Stände (`git fetch`) und löst das Ziel auf – bei einem Branch-Namen den Stand von `origin/<branch>`, nicht einen evtl. veralteten lokalen Branch – und bricht ab, wenn das Ziel **kein Nachfolger** des aktuellen Commits ist (ein Downgrade ist ein [Rollback](#rollback) und braucht das Backup der alten Version),
- erstellt mit `scripts/backup.sh` ein verschlüsseltes Backup nach `./backups/` (Worker ist dafür kurz gestoppt, die API läuft weiter) und verwendet nur eine Datei, die **dieser Lauf** geschrieben hat (Marker-Datei vor dem Backup, `find -newer`) – nie ein älteres Backup,
- hält den bisherigen Commit **und den Pfad dieses Backups** in `backups/upgrade-previous` fest (`PREVIOUS_REF=…`, `PREVIOUS_BACKUP=…`, `UPGRADE_TARGET=…`). Bei einem erneuten Aufruf, wenn der Checkout schon auf dem Ziel steht (z. B. nach einem fehlgeschlagenen Build), bleibt die Datei unverändert – sie verweist weiter auf das Backup von vor dem ersten Versuch,
- wechselt auf die neue Version (`git checkout` bzw. fast-forward des Branches auf `origin/<branch>`),
- baut die Images (`docker compose build`),
- startet alles mit `docker compose up -d --wait` und meldet einen Fehler, wenn ein Dienst nicht `healthy` wird. Das gilt für Dienste mit Healthcheck (caddy, web, api, postgres); der **Worker hat keinen Healthcheck** und wird nur als „running“ geprüft – ihn danach separat kontrollieren (siehe unten),
- räumt danach alte, unbenutzte Images weg (`docker image prune -f`).

Schlägt ab dem Checkout ein Schritt fehl, gibt das Skript den Rollback-Hinweis mit altem Commit und Backup-Pfad aus.

Nach einem Wechsel auf einen Tag steht der Checkout auf einem „detached HEAD“; das nächste Upgrade dann ebenfalls mit Ziel aufrufen (`./scripts/upgrade.sh v1.3.0`).

Händisch entspricht das:

```sh
git fetch --tags origin
git merge-base --is-ancestor HEAD v1.2.0   # Ziel muss Nachfolger sein
./scripts/backup.sh
# PREVIOUS_BACKUP = die Datei, die backup.sh eben ausgegeben hat ("backup written: …")
printf 'PREVIOUS_REF=%s\nPREVIOUS_BACKUP=%s\n' "$(git rev-parse HEAD)" \
  "backups/fma-backup-<zeitstempel>.fmabk" > backups/upgrade-previous
git checkout v1.2.0
docker compose build
docker compose up -d --wait
```

**Worker prüfen:** `--wait` erkennt beim Worker nur, ob der Container läuft. Danach `docker compose ps worker` (Status `running`, nicht `restarting`) und `docker compose logs --tail=50 worker` auf Start- oder Migrationsfehler (z. B. `database schema is newer than this app version`) prüfen.

Zwischen Backup und Neustart geschriebene Daten (neue Mails, gesendete Nachrichten) wären bei einem Rollback verloren; neue Mails holt der Worker danach beim Anbieter nach.

## Wie Migrationen laufen

- Migrationen sind reines SQL, werden in fester Reihenfolge angewendet und in `schema_migrations` vermerkt ([ADR-0002](../adr/0002-database.md)). Ein erneuter Start wendet nichts doppelt an.
- **Jede Migration läuft in einer eigenen Transaktion.** Schlägt eine fehl, wird sie vollständig zurückgerollt; die API startet nicht (Health-Check schlägt fehl), die zuvor erfolgreichen Migrationen bleiben angewendet.
- Ein **Advisory Lock** verhindert, dass API und Worker (oder mehrere Instanzen) gleichzeitig migrieren.
- Migrationen sind **nur vorwärts** (keine Down-Migrationen). Sie werden so geschrieben, dass sie auf einer befüllten Datenbank ohne lange Sperren laufen (z. B. neue `NOT NULL`-Spalten nur mit konstantem Default).
- **Schutz vor zu alter App-Version:** Findet eine App in `schema_migrations` Migrationen, die sie nicht kennt (Datenbank wurde schon von einer neueren Version migriert), bricht sie beim Start mit `database schema is newer than this app version` ab, statt auf einem unbekannten Schema weiterzulaufen. Dasselbe gilt für das Einspielen von Backups einer neueren Version.

## Rollback

Weil Migrationen nur vorwärts laufen, heißt Rollback: **alte Version + Backup von vor dem Upgrade**. Ein bloßes Zurückwechseln des Codes reicht nicht – die alte Version verweigert dann den Start (siehe oben).

```sh
cd ~/fastmail-alternative
cat backups/upgrade-previous            # alter Commit + Backup von vor dem Upgrade
. backups/upgrade-previous              # setzt PREVIOUS_REF und PREVIOUS_BACKUP
git checkout "$PREVIOUS_REF"
docker compose build
docker compose stop api worker
docker compose run --rm --user root -v "$PWD/backups:/backups:ro" worker \
  node dist/backup.js restore "/backups/$(basename "$PREVIOUS_BACKUP")" --force
docker compose up -d --wait caddy web api postgres   # Worker bleibt gestoppt
# Nicht gesendete Postausgangs-Einträge anzeigen (nur IDs/Zeiten, keine Inhalte):
docker compose exec postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
  SELECT id, account_id, status, created_at FROM outbox_message
  WHERE sent_at IS NULL AND status IN ('"'"'queued'"'"', '"'"'sending'"'"') ORDER BY created_at"'
# ... mit den Gesendet-Ordnern beim Anbieter abgleichen, bereits gesendete entfernen:
# docker compose exec postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
#   DELETE FROM outbox_message WHERE id = '"'"'<id>'"'"'"'
docker compose up -d --wait worker
```

**Doppelversand vermeiden:** Das Backup kann Postausgangs-Einträge enthalten, die damals noch nicht gesendet waren, inzwischen (nach dem Backup) aber per SMTP verschickt wurden. Nach dem Restore stehen sie wieder als ungesendet in der Datenbank – ein Start des Workers würde sie **erneut senden**. Deshalb den Worker erst starten, nachdem die ausstehenden Einträge geprüft wurden: Was laut Gesendet-Ordner beim Anbieter schon verschickt ist, entfernen. `restore` weist auf solche Einträge hin (`warning: N unsent outbox message(s) …`, nur die Anzahl).

Maßgeblich ist das in `backups/upgrade-previous` festgehaltene Backup – nicht einfach das neueste in `backups/`: ein späterer Cron-Lauf oder ein erneuter Aufruf von `upgrade.sh` kann inzwischen ein Backup mit bereits migrierter Datenbank geschrieben haben. `restore --force` prüft das Backup vollständig, bevor es Datenbank und `mail-data` ersetzt. Details: [Backup & Restore](backup-restore.md).

Ist nur der Build oder Start fehlgeschlagen, **bevor** eine Migration lief (z. B. Build-Fehler), genügt `git checkout <alter commit>`, `docker compose build` und `docker compose up -d --wait` – ohne Restore.

## Hinweise für den Raspberry Pi

- **Speicher:** Die Container sind begrenzt (u. a. Worker 384 MB, API 192 MB). Migrationen sind so geschrieben, dass sie keine Daten in den Speicher laden; der Build (`docker compose build`) ist nicht begrenzt und braucht auf dem Pi einige Minuten und den meisten Arbeitsspeicher. Bei sehr knappem RAM vorher Swap prüfen (`free -h`).
- **Platz:** Backup und neue Images brauchen zusätzlichen Platz. Vor dem Upgrade `df -h` und `docker system df` prüfen; `upgrade.sh` entfernt danach nicht mehr benutzte Images.
- **Rootless Docker:** Skript als der Benutzer ausführen, unter dem Docker läuft (über SSH: `ssh raspberrypi`, dann `cd ~/fastmail-alternative`). Bei Aufruf aus Cron/Skripten `XDG_RUNTIME_DIR` und `DOCKER_HOST` setzen wie bei den [automatischen Backups](backup-restore.md#automatisch-per-cron-raspberry-pi-rootless-docker).
- **`.env` bleibt unverändert.** Neue optionale Variablen stehen in `.env.example`; der `MASTER_KEY` darf nie neu erzeugt werden.

## Getestet

`packages/db/test/upgrade.test.ts` läuft bei jedem Testlauf gegen echtes PostgreSQL: Eine Datenbank wird nur bis zu einer älteren Migration aufgebaut („vorherige Version“), mit Benutzer, Konto (verpackter Data Key, verschlüsselte Zugangsdaten), Identitäten, Ordner, Nachricht mit verschlüsselten Feldern, Body-Verweis und Postausgang befüllt und dann auf den aktuellen Stand migriert. Geprüft wird, dass alle Daten erhalten und mit demselben `MASTER_KEY` entschlüsselbar sind, Daten-Migrationen (z. B. Ordnerrollen, Identitäts-Duplikate) korrekt greifen, das Schema exakt dem einer Neuinstallation entspricht, ein zweiter Start nichts mehr anwendet und eine ältere App-Version die neuere Datenbank ablehnt.
