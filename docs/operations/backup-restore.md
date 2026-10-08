# Backup & Restore

Ein Backup ist **eine verschlüsselte Datei** (`fma-backup-JJJJMMTT-HHMMSS.fmabk`) mit allem, was eine Instanz ausmacht: alle Tabellen der Datenbank (logischer Export aus PHP, kein `mysqldump` nötig) und der komplette Inhalt des Volumes `mail-data` (verschlüsselte Rohmails). Hochgeladene Anhänge liegen verschlüsselt in der Datenbank (`attachment_upload.content_enc`) und sind damit enthalten. Wiederhergestellt wird es in eine **leere** Instanz; fehlende Migrationen laufen dabei automatisch.

Das Werkzeug ist `php bin/console` im Backend (`apps/server-php`); im Docker-Stack ruft `scripts/backup.sh` es im php-Image auf, auf Webspace läuft es per Cron ([unten](#webspace-ohne-docker)).

> **Der `MASTER_KEY` ist nie im Backup.** Ohne genau diesen Key ist ein Backup wertlos – sowohl die Backup-Datei als auch die Data Keys darin sind damit verschlüsselt. Die `.env` (bzw. mindestens `MASTER_KEY` und `MASTER_KEY_ID`) **getrennt** von den Backups aufbewahren, z. B. im Passwortmanager oder ausgedruckt im Safe. Wer Backup und Key zusammen hat, kann alles lesen.

> **Backups des früheren Node-Backends** (`.fmabk` von vor der Umstellung auf PHP, [ADR-0013](../adr/0013-php-backend.md)) haben einen anderen Inhalt (`pg_dump`) und lassen sich **nicht** in das PHP-Backend einspielen; einen Importweg gibt es nicht. Sie sind nur mit der alten Version restorebar. Siehe [Upgrade – Installationen mit dem früheren Node-Backend](upgrade.md#installationen-mit-dem-früheren-node-backend).

## Format und Sicherheit

| Bestandteil  | Inhalt                                                                                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Kopf         | `fma.bk1` + zufälliges Salt (16 Byte) – sonst nichts im Klartext                                                                                                               |
| Schlüssel    | pro Backup per HKDF-SHA256 aus `MASTER_KEY` und Salt abgeleitet; kein zusätzliches Secret                                                                                      |
| Verschlüss.  | AES-256-GCM in 64-KiB-Blöcken (Zähler als Nonce, letzter Block markiert) – Reihenfolge und Ende geschützt                                                                      |
| Inhalt       | Manifest (Formatversion, Zeitstempel, angewandte Migrationen), alle Tabellen außer Laufzeitdaten (`rate_limit`, `login_lockout`, `metric_counter`), alle Dateien aus mail-data |
| Prüfsummen   | Zeilenzahl und SHA-256 je Tabelle, Größe und SHA-256 je Datei; der Restore prüft alles. Binärspalten (verschlüsselte Inhalte, Hashes) werden byte-genau übernommen             |
| Speicherlast | alles gestreamt (Zeile für Zeile, Dateien in 64-KiB-Blöcken), nur wenige Blöcke im RAM (Raspberry Pi)                                                                          |

Mailinhalte und Zugangsdaten sind in der Datenbank ohnehin mit Konto-DEKs verschlüsselt. Die zusätzliche Verschlüsselung schützt die Metadaten, die im Klartext in der DB liegen (Hostnamen, Benutzernamen, Mailadressen, Ordnerstruktur, Zeitstempel). Ein falscher Key, eine veränderte oder abgeschnittene Datei führt zu einem Abbruch mit klarer Meldung; Ausgaben enthalten nur Zähler, Größen und den Dateinamen des Backups.

**Key-Rotation:** Backups sind an den `MASTER_KEY` gebunden, mit dem sie erstellt wurden. Nach einer [Rotation](../process/key-rotation.md) den alten Key so lange (getrennt) aufbewahren, wie alte Backups aufgehoben werden – oder direkt nach der Rotation ein neues Backup erstellen.

## Werkzeug

| Befehl (im php-Container bzw. in `apps/server-php`) | Wirkung                                                                                                                              |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `php bin/console backup create [--out=ORDNER]`      | Backup schreiben (Standard: `BACKUP_DIR`, sonst `backups/` neben `bin/`; Modus `0600`)                                               |
| `php bin/console backup verify DATEI`               | entschlüsseln und alle Prüfsummen, Zeilenzahlen und das Manifest prüfen, ohne etwas zu schreiben                                     |
| `php bin/console backup restore DATEI`              | Migrationen anwenden, dann in leere Datenbank + leeres mail-data wiederherstellen                                                    |
| `php bin/console backup restore DATEI --force`      | bestehende Datenbank und mail-data **ersetzen** (alles Vorhandene wird gelöscht – erst nachdem das Backup vollständig geprüft wurde) |

- **Konsistenz:** Während `create` hält das Werkzeug die Runner-Sperre (Jobs pausieren, laufende werden bis zu 2 Minuten abgewartet) und liest alle Tabellen in einer Transaktion mit konsistentem Snapshot.
- **Restore:** Ohne `--force` verweigert `restore` das Einspielen, sobald die Datenbank Daten oder das Volume Dateien enthält (frisch migrierte Tabellen und ein offener Setup-Code zählen als leer). Backups einer **neueren** App-Version (unbekannte Migrationen) werden abgelehnt – erst die App aktualisieren. Wurde umgekehrt die Datenbank schon von einer neueren Version migriert (Rollback), verlangt `restore` `--force` und baut die Tabellen dieser Version dann neu auf; Tabellen, die nur die neuere Version angelegt hat, bleiben unberührt. Backups älterer Versionen werden in das aktuelle Schema eingespielt. Vor jedem Schreiben wird das ganze Backup geprüft (Key, Formatversion, Migrationsstand, Prüfsummen, Manifest); ein falscher `MASTER_KEY`, eine beschädigte Datei oder ein Backup einer neueren Version lassen bestehende Daten also unangetastet (der Restore liest die Datei dafür zweimal).
- **Aufbewahrung:** Nach jedem `create` werden `fma-backup-*.fmabk` im Zielordner gelöscht, die älter als `BACKUP_KEEP_DAYS` Tage sind (Standard 14; `0` = nichts löschen). `scripts/backup.sh` erledigt das selbst (siehe unten).

## Backup erstellen

Im Projektverzeichnis (auf dem Pi `~/fastmail-alternative`):

```sh
./scripts/backup.sh        # oder: make backup
```

Das Skript stoppt kurz den Worker (die API im php-Container läuft weiter), schreibt das Backup nach `./backups/`, startet den Worker wieder und löscht Backups, die älter als `BACKUP_KEEP_DAYS` (Standard 14) Tage sind – außer dem in `upgrade-previous` als Rollback-Punkt festgehaltenen Backup ([Upgrade](upgrade.md#rollback)). Ein anderes Zielverzeichnis lässt sich mit `BACKUP_DIR` setzen (Standard `./backups`); beide Variablen kommen aus der Shell-Umgebung, nicht aus der `.env` (z. B. `BACKUP_KEEP_DAYS=30 ./scripts/backup.sh`). Händisch entspricht das:

```sh
docker compose stop worker
docker compose run --rm --no-deps --user root -e BACKUP_KEEP_DAYS=0 -v "$PWD/backups:/backups" php \
  php bin/console backup create --out=/backups
docker compose start worker
```

`--user root` ist bei rootless Docker der eigene Host-Benutzer: Die Backup-Datei gehört damit dem Betreiber, und das Volume ist lesbar. `--no-deps` setzt voraus, dass mariadb läuft.

### Automatisch per Cron (Raspberry Pi, rootless Docker)

`crontab -e` des Benutzers, unter dem Docker läuft:

```cron
XDG_RUNTIME_DIR=/run/user/1000
DOCKER_HOST=unix:///run/user/1000/docker.sock
# Täglich 03:17 Uhr, 14 Tage aufbewahren
17 3 * * * cd $HOME/fastmail-alternative && ./scripts/backup.sh >> backups/backup.log 2>&1
```

`1000` durch die eigene UID ersetzen (`id -u`). Damit rootless Docker ohne Anmeldung läuft, einmalig `loginctl enable-linger $USER`.

### Backups außer Haus bringen

Ein Backup auf derselben SD-Karte/SSD schützt nicht vor Hardwaredefekt. Die `.fmabk`-Dateien regelmäßig auf ein anderes Gerät kopieren, z. B.:

```sh
rsync -a --delete ~/fastmail-alternative/backups/ nas:/backup/fastmail-alternative/
```

Die Dateien sind verschlüsselt und dürfen auf fremdem Speicher liegen – **die `.env` nicht daneben legen.**

## Restore auf einer frischen Instanz

1. Installation vorbereiten (`git clone`, gleiche oder neuere App-Version) und die **gesicherte `.env`** übernehmen – nicht neu erzeugen, ein anderer `MASTER_KEY` macht das Backup unlesbar.
2. Images bauen (bzw. bei Release-Images `pull`) und nur die Datenbank starten (der php-Container würde sonst schon das Schema anlegen und die Einrichtung anbieten):

   ```sh
   docker compose build
   docker compose up -d --wait mariadb
   ```

3. Backup prüfen und einspielen:

   ```sh
   mkdir -p backups && cp /pfad/zu/fma-backup-….fmabk backups/
   docker compose run --rm --no-deps --user root -v "$PWD/backups:/backups" php \
     php bin/console backup verify /backups/fma-backup-….fmabk
   docker compose run --rm --no-deps --user root -v "$PWD/backups:/backups" php \
     php bin/console backup restore /backups/fma-backup-….fmabk
   ```

   Läuft `restore` als root (wie hier), übergibt es die wiederhergestellten Dateien selbst an den Besitzer des `mail-data`-Verzeichnisses (`www-data`, unter dem php-fpm und Worker laufen); ein `chown` von Hand ist nicht nötig.

4. Erst ohne Worker starten: `docker compose up -d --wait caddy web php mariadb`. Hat `restore` `warning: N unsent outbox message(s)` gemeldet, die ungesendeten Postausgangs-Einträge wie unter [Upgrade – Rollback](upgrade.md#rollback) prüfen und bereits Gesendetes entfernen – **der Worker würde sie sonst sofort (erneut) senden**. Läuft die alte Instanz noch, sie vorher stoppen, sonst senden beide.
5. Dann den Worker starten: `docker compose up -d --wait worker`. Anmeldung mit dem bisherigen Benutzer; Konten und Mails sind sofort da, der Worker holt Neues vom Anbieter nach.

Lief die Instanz schon (z. B. Einrichtung schon erledigt), ist die Datenbank nicht mehr leer: dann `restore … --force` verwenden (vorher `docker compose stop worker`) – das löscht die vorhandene Datenbank und den Inhalt von `mail-data` vollständig. Falscher Key, beschädigte Datei oder zu neue Version fallen bereits in der Prüfung vor dem Löschen auf. Bricht ein Restore danach ab (z. B. Platte voll), ist die Instanz eventuell halb befüllt; nach Behebung der Ursache mit `--force` wiederholen.

Domainwechsel, Push-Abos und Geräte: siehe [Umzug](migration.md#3-prüfen).

## Webspace (ohne Docker)

Auf Shared Hosting ([Installation](installation-php.md)) dieselben Befehle in `fma-app/` per SSH oder Cron:

- **Automatisch:** z. B. `17 3 * * * cd /pfad/zu/fma-app && php bin/console backup create >> backups/backup.log 2>&1`. Aufbewahrung über `BACKUP_KEEP_DAYS` in `config.php`. Zielordner außerhalb des Webroots wählen und die Dateien regelmäßig außer Haus kopieren (siehe oben).
- **Restore:** Den Cron-Eintrag (bzw. `bin/worker.php`) vorher deaktivieren, dann `php bin/console backup restore DATEI` (bzw. `--force`). Meldet `restore` `warning: N unsent outbox message(s)`, die Einträge wie unter [Upgrade – Rollback](upgrade.md#rollback) prüfen, bevor der Cron wieder läuft – sonst werden sie (erneut) gesendet.

## Restore regelmäßig testen

- **Automatisch:** `apps/server-php/tests/Integration/BackupTest.php` (Teil von `composer test:integration` bzw. `make check`, gegen echtes MariaDB): befüllte Tabellen inkl. Binärspalten und Dateien → Backup → Löschen → Restore → identisch; falscher Key, abgeschnittene und veränderte Datei schlagen fehl, ohne die Datenbank zu verändern; nicht leeres Ziel ohne `--force` wird abgelehnt.
- **Im Betrieb:** monatlich das neueste Backup mit `verify` prüfen (oben, Schritt 3) und mindestens einmal im Jahr einen vollständigen Restore auf einer Test-Instanz auf einem anderen Rechner durchspielen – mit dem **separat aufbewahrten** `MASTER_KEY`, nicht mit dem vom laufenden Server. Nur so ist sicher, dass Key-Backup und Daten-Backup zusammenpassen.
