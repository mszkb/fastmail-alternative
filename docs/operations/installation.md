# Installation

Diese Anleitung führt von einem leeren Linux-Server bis zum ersten verbundenen Mailkonto auf dem Handy. Der komplette Stack (caddy, web, php, worker, mariadb) läuft per `docker compose` auf einem eigenen Server ([ADR-0007](../adr/0007-deployment.md), Backend nach [ADR-0013](../adr/0013-php-backend.md)); es wird kein Cloud-Dienst benötigt.

Ohne eigenen Server, auf Webspace mit PHP und MySQL/MariaDB (FTP + Cron): [Installation auf Shared Hosting](installation-php.md). Bestehende Installation mit dem früheren Node-Backend (PostgreSQL): siehe [Upgrade](upgrade.md#installationen-mit-dem-früheren-node-backend).

> **Stand:** Es gibt noch keine fertigen Release-Images (Roadmap 7.2). Die Images werden bei der Installation aus dem Quellcode gebaut – das dauert auf einem Raspberry Pi einige Minuten.

## 1. Voraussetzungen

| Was          | Anforderung                                                                                                                                                 |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Betriebssys. | Linux, `linux/arm64` (z. B. Raspberry Pi 4/5 mit 64-Bit-OS) oder `linux/amd64`                                                                              |
| Hardware     | min. 1 vCPU, 1 GB RAM (+ Swap/zram), 8 GB Disk **+ Postfachgröße**; empfohlen 2 GB RAM, 32 GB Disk – Details: [Systemanforderungen](system-requirements.md) |
| Software     | Docker Engine mit **Compose v2** (`docker compose version` funktioniert), `git`, `openssl` (für `scripts/setup-env.sh`). Rootless Docker ist getestet       |
| Domain       | ein DNS-Name (z. B. `mail.example.org`) mit A- bzw. AAAA-Eintrag auf die öffentliche IP des Servers                                                         |
| Netzwerk     | Ports **80** und **443** aus dem Internet erreichbar (Let's Encrypt prüft über Port 80/443, Caddy holt das Zertifikat automatisch)                          |

**Ohne Domain (nur Test im LAN):** Mit `DOMAIN=:80` läuft die Instanz per HTTP ohne TLS. Das reicht zum Ausprobieren im Browser am Rechner, aber **nicht** für den Alltag: Browser aktivieren Service Worker, App-Installation, Offline-Modus und Web Push nur über HTTPS (Ausnahme: `localhost`). Auf iPhone/iPad funktionieren Push und Installation also nur mit Domain und TLS.

**Speicherlimits:** Jeder Dienst hat in der `docker-compose.yml` ein festes `mem_limit` (caddy 64 MB, web 64 MB, php 256 MB, worker 384 MB, mariadb 256 MB). Auf Systemen mit 1 GB RAM `MAX_RAW_MESSAGE_BYTES` senken, siehe [Konfiguration](configuration.md#sync-und-limits).

### Rootless Docker

Rootless Docker wird empfohlen (Referenz-Deployment: Raspberry Pi, Debian 13). Zwei Punkte sind dabei zu beachten:

- **Ports unter 1024:** Ein rootless Docker darf Ports 80/443 standardmäßig nicht öffnen (`docker compose up` bricht mit „permission denied“ beim Binden ab). Einmalig als root erlauben:

  ```sh
  echo 'net.ipv4.ip_unprivileged_port_start=80' | sudo tee /etc/sysctl.d/99-rootless-ports.conf
  sudo sysctl --system
  ```

- **Start ohne Anmeldung:** Damit die Container nach einem Neustart ohne SSH-Login laufen: `loginctl enable-linger $USER` und `systemctl --user enable docker`.

### Raspberry Pi

- 64-Bit-OS verwenden (`uname -m` zeigt `aarch64`).
- Viele Pi-Images booten mit `cgroup_disable=memory`; dann sind die Speicherlimits wirkungslos (der Stack läuft trotzdem). Aktivierung optional, siehe [Systemanforderungen](system-requirements.md#hinweis-zu-memory-limits-auf-raspberry-pi-systemen).
- Der Image-Build braucht den meisten Arbeitsspeicher – vorher Swap prüfen (`free -h`). Eine SSD statt SD-Karte ist für das Volume `mail-data` deutlich robuster.

## 2. Code holen

```sh
git clone https://github.com/mszkb/fastmail-alternative.git ~/fastmail-alternative
cd ~/fastmail-alternative
```

Alle weiteren Befehle laufen in diesem Verzeichnis.

## 3. Konfiguration erzeugen (`.env`)

```sh
./scripts/setup-env.sh        # oder: make env
```

Das Skript braucht nur `openssl` und schreibt eine `.env` (Rechte `0600`) mit:

| Variable                                | Inhalt                                                        |
| --------------------------------------- | ------------------------------------------------------------- |
| `DOMAIN`                                | `:80` (HTTP ohne TLS) – im nächsten Schritt anpassen          |
| `MASTER_KEY`                            | zufälliger 32-Byte-Schlüssel (base64) für die Verschlüsselung |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | Schlüsselpaar für Web Push                                    |
| `VAPID_SUBJECT`                         | `mailto:admin@example.com` – eigene Kontaktadresse eintragen  |
| `MARIADB_PASSWORD`                      | zufälliges Datenbankpasswort                                  |

Eine vorhandene `.env` wird nie überschrieben. Alle weiteren Einstellungen haben sinnvolle Standardwerte; die vollständige Liste steht in [Konfiguration](configuration.md) und in `.env.example`.

> **Den `MASTER_KEY` jetzt sichern – getrennt vom Server und von den Backups** (Passwortmanager, Ausdruck im Safe). Alle Mails und Zugangsdaten sind damit verschlüsselt. Geht er verloren, sind Datenbank und Backups wertlos; es gibt keine Hintertür. Die `.env` nie in Git committen.

## 4. Domain eintragen

In der `.env`:

```sh
DOMAIN=mail.example.org
VAPID_SUBJECT=mailto:du@example.org
```

`DOMAIN` ist die Site-Adresse für Caddy. Mit einem Domainnamen holt Caddy beim Start automatisch ein Let's-Encrypt-Zertifikat und leitet HTTP auf HTTPS um; außerdem setzt das Backend dann das Session-Cookie mit `Secure`. Nur für einen Test im LAN `DOMAIN=:80` stehen lassen.

## 5. Starten

```sh
docker compose up -d --build --wait     # oder: make up
```

Das baut die Images (web und php; der worker nutzt das php-Image), startet alle Dienste und wartet, bis alle (caddy, web, php, worker, mariadb) `healthy` sind. Beim Start legt der php-Container das Datenbankschema an (`php bin/migrate.php`, danach php-fpm).

| Dienst    | Image                        | Aufgabe                                                                                   |
| --------- | ---------------------------- | ----------------------------------------------------------------------------------------- |
| `caddy`   | `caddy:2-alpine`             | TLS (Let's Encrypt), `/api/*` per FastCGI an `php:9000`, alles andere an `web`            |
| `web`     | `apps/web/Dockerfile`        | PWA (statisch, nginx, Sicherheitsheader)                                                  |
| `php`     | `apps/server-php/Dockerfile` | php-fpm für `/api/*`; wendet beim Start ausstehende Migrationen an                        |
| `worker`  | dasselbe Image wie `php`     | `php bin/worker.php`: Hintergrundjobs (Sync, Versand, Push, Aufräumen) und IMAP IDLE      |
| `mariadb` | `mariadb:11`                 | Datenbank (Volume `mariadb-data`), nur im Compose-Netz erreichbar, kein Port auf dem Host |

Verschlüsselte Rohmails liegen im Volume `mail-data`.

**Port belegt?** Sind 80/443 belegt, in der `.env` andere Host-Ports setzen (`HTTP_PORT`, `HTTPS_PORT`, siehe [Konfiguration](configuration.md#fest-eingestellt)) – für Let's Encrypt müssen 80/443 von außen aber beim Server ankommen (z. B. per Portweiterleitung).

**Optional: fertige Images statt lokal bauen.** Wenn ein Release veröffentlicht und signiert ist, gibt es dafür Multi-Arch-Images (amd64, arm64) in der GitHub Container Registry. Das spart auf schwacher Hardware den Build; lokal bauen bleibt der Standard und braucht keine Registry. Dauerhaft einschalten über zwei Zeilen in der `.env` (die Versionsnummer ist nur ein Beispiel – vorhandene Releases stehen auf der Release-Seite des Repositorys):

```sh
# in .env ergänzen
COMPOSE_FILE=docker-compose.yml:docker-compose.release.yml
FMA_VERSION=0.1.0   # gewünschtes Release ohne "v"
```

```sh
docker compose pull
docker compose up -d --wait
```

Mit `COMPOSE_FILE` in der `.env` nutzen alle weiteren `docker compose`-Befehle (auch `scripts/backup.sh`) die Release-Images. Eine eigene `docker-compose.override.yml` (z. B. für andere caddy-Ports) wird dann **nicht mehr automatisch geladen** und muss angehängt werden: `COMPOSE_FILE=docker-compose.yml:docker-compose.release.yml:docker-compose.override.yml`. Upgrades mit Release-Images: [Upgrade](upgrade.md#fertige-images-statt-lokal-bauen).

Signatur vorher prüfen und weitere Details: [Release-Prozess](../process/release.md).

Kontrolle:

```sh
docker compose ps                                  # alle Dienste "healthy"
docker compose logs php | grep "migrations applied" # Schema angelegt
docker compose exec php php bin/check.php          # Einrichtungs-Check: PHP, MASTER_KEY, Datenbank, Mail-Ports
docker compose logs --tail=50 worker               # keine Fehler, kein Neustart-Loop
docker compose logs --tail=50 caddy                # nur mit Domain: Zertifikat erhalten ("certificate obtained")
```

`bin/check.php` meldet jede Prüfung mit `[ok]`, `[warn]` oder `[FAIL]`; Werte wie der `MASTER_KEY` werden nie ausgegeben. Der Worker wird `healthy`, sobald seine Job-Schleife den ersten Durchlauf geschafft hat (Heartbeat, bis zu 2 min nach dem Start). Bei Problemen: [Troubleshooting](troubleshooting.md).

## 6. Benutzer anlegen (Ersteinrichtung)

Die Instanz im Browser öffnen: `https://<deine-domain>` (z. B. `https://mail.example.org`) bei echter Domain, `http://<server-ip>` beim LAN-Test mit `DOMAIN=:80`. Solange noch kein Benutzer existiert, erscheint **„Einrichtung“**: Setup-Code, E-Mail-Adresse (dient nur als Login-Name) und Passwort (mindestens 10 Zeichen) eingeben, **„Konto erstellen“**.

Den **Setup-Code** gibt dieser Befehl aus, solange noch kein Benutzer existiert:

```bash
docker compose exec php php bin/setup-code.php     # oder: make setup-code
```

Er sieht aus wie `ABCD-EFGH-IJKL-MNOP-QRST-UVWX` (Groß-/Kleinschreibung und Bindestriche egal). Jeder Aufruf erzeugt einen neuen Code und macht den vorherigen ungültig; gespeichert wird nur sein Hash. Ohne diesen Befehl erzeugt das Backend beim ersten Aufruf der Einrichtungsseite einen Code und schreibt ihn einmalig ins Log (`docker compose logs php | grep "FIRST-RUN SETUP CODE"`). Wer lieber einen eigenen Code festlegt, setzt vor dem Start `SETUP_TOKEN` in der `.env` ([Konfiguration](configuration.md#sicherheit-und-verschlüsselung)); der wird nie geloggt, und `bin/setup-code.php` verweist dann auf ihn.

> **Warum?** Sobald Caddy ein Zertifikat geholt hat, ist die Domain öffentlich bekannt (Certificate-Transparency-Logs). Ohne Setup-Code könnte ein Scanner die frische Instanz übernehmen. Die Instanz ist Single-User ([ADR-0004](../adr/0004-auth.md)): Nach der Einrichtung ist sie gesperrt, ein weiterer Benutzer ist nicht möglich, und der Code ist wertlos.

Das Passwort lässt sich später unter **Einstellungen** ändern; dort stehen auch die angemeldeten **Geräte**, die einzeln abgemeldet werden können.

## 7. Erstes Mailkonto verbinden

**„Konto hinzufügen“** (bzw. **Einstellungen → Konto hinzufügen**):

1. E-Mail-Adresse des Kontos, optional ein Anzeigename (z. B. „Privat“).
2. **Mails synchronisieren:** Alle, 30 Tage, 90 Tage oder 1 Jahr. Für große Postfächer auf kleiner Hardware zuerst einen kürzeren Zeitraum wählen; ältere Mails lassen sich später mit „Ältere Mails laden“ holen.
3. **IMAP** und **SMTP**: Host, Port und Benutzer/Passwort vom Mailanbieter (typisch IMAP 993, SMTP 465 oder 587). „Gleiche Zugangsdaten wie IMAP“ ist voreingestellt.
4. **„Verbinden“**: Die Verbindung wird vor dem Speichern getestet (IMAP + SMTP). Danach startet der Abgleich im Hintergrund.

Hinweise:

- Anbieter mit Zwei-Faktor-Anmeldung (z. B. Gmail, iCloud, GMX/Web.de je nach Einstellung) brauchen ein **App-Passwort**. Die Anmeldung per OAuth2 (Microsoft/Google) ist geplant (Roadmap 2.10), aber noch nicht verfügbar.
- Mailserver mit privater IP-Adresse (z. B. im eigenen LAN) werden aus Sicherheitsgründen abgelehnt (SSRF-Schutz, Meldung „Interner Host ist blockiert“).
- Weitere Konten auf dieselbe Weise hinzufügen. Jedes Konto bleibt getrennt; gewechselt wird über den Kontowechsler.

## 8. App installieren und Push aktivieren

Unter **Einstellungen → App installieren** zeigt die App eine passende Anleitung für das aktuelle Gerät.

- **Android / Chrome / Edge (Desktop):** Schaltfläche „App installieren“ bzw. Browser-Menü „App installieren“.
- **iPhone / iPad (Safari, ab iOS 16.4):** Teilen-Menü → **„Zum Home-Bildschirm“**, die App **vom Home-Bildschirm aus** öffnen und anmelden. Benachrichtigungen und App-Badge gibt es auf iOS **nur** in der installierten App, nicht im Safari-Tab.

Dann **Einstellungen → Benachrichtigungen → „Benachrichtigungen aktivieren“** und die Abfrage des Browsers bestätigen. Push muss auf jedem Gerät einzeln aktiviert werden.

Push-Nachrichten enthalten bewusst **keinen Betreff, Absender oder Inhalt** – nur den Hinweis auf neue Mail. Die App lädt die Nachrichten beim Öffnen selbst vom Server. Push ist nur ein Hinweis; auch ohne Push synchronisiert die App beim Start und bei jedem Wechsel in den Vordergrund.

## 9. Nach der Installation

1. **Backup einrichten** (Cron, Offsite-Kopie): [Backup & Restore](backup-restore.md) – und ein erstes Backup mit `verify` prüfen.
2. **`.env`/`MASTER_KEY`** liegt an einem zweiten, sicheren Ort (siehe Schritt 3).
3. **Upgrades** immer mit `./scripts/upgrade.sh`: [Upgrade](upgrade.md).
4. Bei Problemen: [Troubleshooting](troubleshooting.md).

## Deinstallation

```sh
docker compose down       # Container stoppen und entfernen, Daten bleiben erhalten
docker compose down -v    # zusätzlich alle Volumes löschen (Datenbank, Mails, Zertifikate) – endgültig!
```

Die Mails beim Mailanbieter bleiben in beiden Fällen unverändert.
