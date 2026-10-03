# Backup & Restore

Ein Backup ist **eine verschlüsselte Datei** (`fma-backup-JJJJMMTT-HHMMSS.fmabk`) mit allem, was eine Instanz ausmacht: Datenbank (`pg_dump`) und der komplette Inhalt des Volumes `mail-data` (verschlüsselte Rohmails und Uploads). Wiederhergestellt wird es in eine **leere** Instanz; danach laufen fehlende Migrationen automatisch.

> **Der `MASTER_KEY` ist nie im Backup.** Ohne genau diesen Key ist ein Backup wertlos – sowohl die Backup-Datei als auch die Data Keys darin sind damit verschlüsselt. Die `.env` (bzw. mindestens `MASTER_KEY` und `MASTER_KEY_ID`) **getrennt** von den Backups aufbewahren, z. B. im Passwortmanager oder ausgedruckt im Safe. Wer Backup und Key zusammen hat, kann alles lesen.

## Format und Sicherheit

| Bestandteil  | Inhalt                                                                                                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kopf         | `fma.bk1` + zufälliges Salt (16 Byte) – sonst nichts im Klartext                                                                                                                |
| Schlüssel    | pro Backup per HKDF-SHA256 aus `MASTER_KEY` und Salt abgeleitet; kein zusätzliches Secret                                                                                       |
| Verschlüss.  | AES-256-GCM in 64-KiB-Blöcken (Zähler als Nonce, letzter Block markiert) – Reihenfolge und Ende geschützt                                                                       |
| Inhalt       | Manifest (Formatversion, Zeitstempel, angewandte Migrationen), `pg_dump -Fc`, alle Dateien aus mail-data                                                                        |
| Prüfsummen   | SHA-256 und Größe je Eintrag, am Ende ein Manifest aller Einträge (in Blöcken zu je 1000 Einträgen, damit auch sehr viele Dateien restorebar bleiben); der Restore prüft beides |
| Speicherlast | alles gestreamt, nur wenige Blöcke im RAM (Raspberry Pi)                                                                                                                        |

Mailinhalte und Zugangsdaten sind in der Datenbank ohnehin mit Konto-DEKs verschlüsselt. Die zusätzliche Verschlüsselung schützt die Metadaten, die im Klartext in der DB liegen (Hostnamen, Benutzernamen, Mailadressen, Ordnerstruktur, Zeitstempel). Ein falscher Key, eine veränderte oder abgeschnittene Datei führt zu einem Abbruch mit klarer Meldung; Logs enthalten nur Zähler, Größen und den Dateinamen des Backups.

**Key-Rotation:** Backups sind an den `MASTER_KEY` gebunden, mit dem sie erstellt wurden. Nach einer [Rotation](../process/key-rotation.md) den alten Key so lange (getrennt) aufbewahren, wie alte Backups aufgehoben werden – oder direkt nach der Rotation ein neues Backup erstellen.

## Werkzeug

Das Backup-Werkzeug steckt im Worker-Image (`dist/backup.js`, inkl. `pg_dump`/`pg_restore` 17) und nutzt dessen Umgebung (`MASTER_KEY`, `POSTGRES_*`, Volume `mail-data`):

| Befehl                                        | Wirkung                                                                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `node dist/backup.js create [datei\|ordner]`  | Backup schreiben (Standard: `/backups/fma-backup-<zeit>.fmabk`, Modus `0600`)                                                        |
| `node dist/backup.js verify <datei>`          | entschlüsseln und alle Prüfsummen prüfen, ohne etwas zu schreiben                                                                    |
| `node dist/backup.js restore <datei>`         | in leere Datenbank + leeres mail-data wiederherstellen, dann Migrationen                                                             |
| `node dist/backup.js restore <datei> --force` | bestehende Datenbank und mail-data **ersetzen** (alles Vorhandene wird gelöscht – erst nachdem das Backup vollständig geprüft wurde) |

Ohne `--force` verweigert `restore` das Einspielen, sobald die Datenbank Tabellen oder das Volume Dateien enthält. Backups einer **neueren** App-Version (unbekannte Migrationen) werden abgelehnt – erst die App aktualisieren. Backups älterer Versionen werden eingespielt und anschließend migriert. Mit `--force` auf ein nicht leeres Ziel wird das Backup zuerst komplett geprüft (wie `verify`: Key, Formatversion, Migrationsstand, Prüfsummen, Manifest); erst danach werden Datenbank und mail-data gelöscht. Ein falscher `MASTER_KEY`, eine beschädigte Datei oder ein Backup einer neueren Version lassen die bestehenden Daten also unangetastet (der Restore dauert dafür etwa doppelt so lange).

## Backup erstellen

Im Projektverzeichnis (auf dem Pi `~/fastmail-alternative`):

```sh
./scripts/backup.sh
```

Das Skript stoppt kurz den Worker (damit Datenbank und `mail-data` zusammenpassen; die API läuft weiter), schreibt das Backup nach `./backups/`, startet den Worker wieder und löscht Backups, die älter als `BACKUP_KEEP_DAYS` (Standard 14) Tage sind. Händisch entspricht das:

```sh
docker compose stop worker
docker compose run --rm --user root -v "$PWD/backups:/backups" worker node dist/backup.js create /backups
docker compose start worker
```

`--user root` ist bei rootless Docker der eigene Host-Benutzer: Die Backup-Datei gehört damit dem Betreiber, und das Volume ist lesbar.

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
2. Nur die Datenbank starten (die API würde sonst schon Tabellen anlegen):

   ```sh
   docker compose up -d postgres
   ```

3. Backup prüfen und einspielen:

   ```sh
   mkdir -p backups && cp /pfad/zu/fma-backup-….fmabk backups/
   docker compose run --rm --user root -v "$PWD/backups:/backups:ro" worker \
     node dist/backup.js verify /backups/fma-backup-….fmabk
   docker compose run --rm --user root -v "$PWD/backups:/backups:ro" worker \
     node dist/backup.js restore /backups/fma-backup-….fmabk
   ```

   Dateien im Volume bekommen dabei den Besitzer `1000:1000` (Benutzer `node` im Worker-Image).

4. Alles starten: `docker compose up -d`. Anmeldung mit dem bisherigen Benutzer; Konten und Mails sind sofort da, der Worker holt Neues vom Anbieter nach.

Lief die Instanz schon (z. B. API einmal gestartet), ist die Datenbank nicht mehr leer: dann `restore … --force` verwenden – das löscht die vorhandene Datenbank und den Inhalt von `mail-data` vollständig. Falscher Key, beschädigte Datei oder zu neue Version fallen bereits in der Prüfung vor dem Löschen auf. Bricht ein Restore danach ab (z. B. Platte voll), ist die Instanz eventuell halb befüllt; nach Behebung der Ursache mit `--force` wiederholen.

Domainwechsel, Push-Abos und Geräte: siehe [Umzug](migration.md#3-prüfen).

## Restore regelmäßig testen

- **Automatisch in CI:** `apps/worker/test/backup.test.ts` legt bei jedem Lauf gegen echtes PostgreSQL eine befüllte Instanz an (Konto mit verschlüsselten Zugangsdaten, Nachricht, verschlüsselte Rohmail, größere Datei), erstellt ein Backup, stellt es in eine frisch angelegte Datenbank und ein leeres Verzeichnis wieder her und prüft, dass alles identisch und entschlüsselbar ist. Außerdem: falscher Key, abgeschnittene Datei, nicht leeres Ziel und Backups einer neueren Version schlagen sauber fehl; `restore --force` mit falschem Key oder beschädigter Datei lässt ein befülltes Ziel unverändert; ein auf viele Manifest-Blöcke verteiltes Manifest bleibt restorebar.
- **Im Betrieb:** monatlich das neueste Backup mit `verify` prüfen (oben, Schritt 3) und mindestens einmal im Jahr einen vollständigen Restore auf einer Test-Instanz auf einem anderen Rechner durchspielen – mit dem **separat aufbewahrten** `MASTER_KEY`, nicht mit dem vom laufenden Server. Nur so ist sicher, dass Key-Backup und Daten-Backup zusammenpassen.
