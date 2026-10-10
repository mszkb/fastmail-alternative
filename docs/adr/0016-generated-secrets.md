# ADR-0016: Secrets beim ersten Start erzeugen

- **Status:** Accepted (Owner-Entscheidung 2026-10-10)
- **Datum:** 2026-10-10
- **Roadmap:** #164 (ergänzt [ADR-0007](0007-deployment.md) und [ADR-0013](0013-php-backend.md))

## Kontext

Die Vision verlangt ein minimales Setup: Was sich automatisch erzeugen lässt, wird automatisch erzeugt, idealerweise reicht `docker compose up`. Heute muss vorher `./scripts/setup-env.sh` laufen. Es schreibt `MASTER_KEY`, das VAPID-Schlüsselpaar und `MARIADB_PASSWORD` in `.env`. Ohne `.env` bricht `docker compose` sofort ab (`${MASTER_KEY:?…}`, `${MARIADB_PASSWORD:?…}`).

Rahmenbedingungen:

- **Prinzip 5:** Der Master-Key kommt nur aus Secret-Management bzw. Umgebung, nie in Repo, DB oder Logs. Er muss getrennt vom Backup gesichert werden; Backups (`bin/console backup create`) enthalten ihn bewusst nicht.
- **Werte aus Umgebung, `.env` und `config.php` haben Vorrang** und werden nie überschrieben.
- **MariaDB braucht das Passwort beim allerersten Start.** Der `mariadb`-Container legt den Benutzer an, bevor `php` startet (`depends_on: service_healthy`). Ein Passwort, das erst `php` erzeugt, kommt zu spät.
- **Web-Installer (#109):** `public/install.php` schlägt heute ein `config.php` mit frischem `MASTER_KEY` und VAPID-Keys vor, schreibt aber nichts auf die Platte. Den Setup-Code gibt er erst heraus, wenn der `MASTER_KEY` eingegeben wird. Das beweist die Kontrolle über `config.php`: Wer eine frische Instanz zufällig findet, kann sie nicht übernehmen. Erzeugt der Server den Key selbst, fällt dieser Nachweis weg.
- **Backup des Keys:** Ein Key, den der Betreiber nie gesehen hat, sichert er auch nicht. Das automatische Erzeugen braucht einen sicheren Weg, den Key einmal anzuzeigen bzw. zu exportieren.

## Optionen

1. **Status quo:** `setup-env.sh` bleibt Pflicht, der Installer schlägt `config.php` vor. Einfach und erprobt, aber ein zusätzlicher Schritt, und `docker compose up` allein scheitert.
2. **Docker: Init-Dienst mit Secrets-Volume.** Ein einmaliger Dienst `secrets` (gleiches Image wie `php`, `bin/secrets.php init`) läuft vor `mariadb`. Er erzeugt fehlende Werte in einem eigenen Volume `app-secrets`, getrennt von `mail-data` und den Backups. `mariadb` liest das Passwort über `MARIADB_PASSWORD_FILE`. `php` und `worker` lesen die Datei mit der niedrigsten Priorität (nach Umgebung und `config.php`). Gesetzte `.env`-Werte gewinnen. Die Compose-Datei verlangt `MASTER_KEY`/`MARIADB_PASSWORD` nicht mehr.
   - **Vorteile:** `docker compose up` reicht, bestehende Installationen bleiben unverändert (ihre `.env` gewinnt).
   - **Nachteile:**
     - Dateirechte über zwei Images: `mysql` (UID 999) und `www-data` (UID 82). Der Init-Dienst muss als root laufen und je Datei passend `chown`en.
     - Rootless Docker auf dem Pi ist zu testen.
     - Der Key steckt in einem Docker-Volume. Beim Sichern muss der Betreiber ihn ausdrücklich exportieren (`bin/secrets.php export`), mit klarem Hinweis in Log und Ersteinrichtung.
3. **Nur PHP erzeugt (`MASTER_KEY`, VAPID), das DB-Passwort bleibt in `.env`.** Weniger Umbau, aber `docker compose up` ohne `.env` scheitert weiter. Für Docker bringt das kaum etwas.
4. **Shared Hosting: Installer schreibt `config.php` selbst**, wenn das Verzeichnis beschreibbar ist (Rechte `0600`), und zeigt den Key einmal zum Sichern an. Dafür muss der Kontrollnachweis ersetzt werden, z. B. durch einen einmaligen Installer-Code im Server-Log oder in einer Datei, die per FTP zu lesen ist. Ohne Ersatz kann die Instanz übernehmen, wer sie zuerst aufruft.

## Entscheidung

- **Docker: Option 2.** `bin/secrets.php init` (Dienst `secrets`, als root) erzeugt nur fehlende Werte und schreibt sie atomar mit `umask 077`:
  - `secrets.json`: Eigentümer `www-data`, Rechte `0600`.
  - `mariadb_password`: Eigentümer root, Rechte `0400`. Ist `MARIADB_PASSWORD` in `.env` gesetzt, steht dieser Wert darin. MariaDB liest die Datei über `MARIADB_PASSWORD_FILE` als root, bevor der Container zum Benutzer `mysql` wechselt.

  Das Skript loggt nur Namen und Pfad, nie Werte. Weicht der `MASTER_KEY` in `.env` vom erzeugten ab, warnt es. Das Volume `app-secrets` gehört nicht ins Backup. `bin/secrets.php export` gibt die erzeugten Werte zum Sichern aus, und die Einrichtungsseite erinnert daran (`masterKeyGenerated` in `GET /api/auth/status`). `setup-env.sh` bleibt als optionaler Weg.

- **Shared Hosting: vorerst Option 1.** Der Installer bleibt, wie er ist, bis eine Ersatzlösung für den Kontrollnachweis entschieden ist. Danach folgt Option 4 als eigenes Issue.

## Konsequenzen

- Neue Datei `bin/secrets.php` (`init`, `export`), `Config::load` liest eine dritte Quelle (`SECRETS_FILE`, niedrigste Priorität), Volume `app-secrets`, Dienst `secrets` in `docker-compose.yml` und `docker-compose.release.yml`.
- Upgrade-Doku: Bestehende `.env` bleibt maßgeblich, kein Umzug nötig.
- Backup-Doku: `app-secrets` gehört nicht ins gleiche Backup wie die Datenbank. `bin/secrets.php export` zeigt den Key zum separaten Sichern.
- Vor dem Merge testen: frische Instanz auf dem Pi (rootless Docker, arm64) mit leerer `.env`, dann Neustart (nichts wird neu erzeugt), Upgrade einer Instanz mit `.env`.
