# Installation

Diese Anleitung führt von einem leeren Linux-Server bis zum ersten verbundenen Mailkonto auf dem Handy. Der komplette Stack (caddy, web, api, worker, postgres) läuft per `docker compose` auf einem eigenen Server ([ADR-0007](../adr/0007-deployment.md)); es wird kein Cloud-Dienst benötigt.

> **Stand:** Es gibt noch keine fertigen Release-Images (Roadmap 7.2). Die Images werden bei der Installation aus dem Quellcode gebaut – das dauert auf einem Raspberry Pi einige Minuten.

## 1. Voraussetzungen

| Was          | Anforderung                                                                                                                                                                                   |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Betriebssys. | Linux, `linux/arm64` (z. B. Raspberry Pi 4/5 mit 64-Bit-OS) oder `linux/amd64`                                                                                                                |
| Hardware     | min. 1 vCPU, 1 GB RAM (+ Swap/zram), 8 GB Disk **+ Postfachgröße**; empfohlen 2 GB RAM, 32 GB Disk – Details: [Systemanforderungen](system-requirements.md)                                   |
| Software     | Docker Engine mit **Compose v2** (`docker compose version` funktioniert), `git`; für `scripts/setup-env.mjs` Node.js (oder ein Node-Container, siehe Schritt 3). Rootless Docker ist getestet |
| Domain       | ein DNS-Name (z. B. `mail.example.org`) mit A- bzw. AAAA-Eintrag auf die öffentliche IP des Servers                                                                                           |
| Netzwerk     | Ports **80** und **443** aus dem Internet erreichbar (Let's Encrypt prüft über Port 80/443, Caddy holt das Zertifikat automatisch)                                                            |

**Ohne Domain (nur Test im LAN):** Mit `DOMAIN=:80` läuft die Instanz per HTTP ohne TLS. Das reicht zum Ausprobieren im Browser am Rechner, aber **nicht** für den Alltag: Browser aktivieren Service Worker, App-Installation, Offline-Modus und Web Push nur über HTTPS (Ausnahme: `localhost`). Auf iPhone/iPad funktionieren Push und Installation also nur mit Domain und TLS.

**Speicherlimits:** Jeder Dienst hat in der `docker-compose.yml` ein festes `mem_limit` (caddy 64 MB, web 64 MB, api 192 MB, worker 384 MB, postgres 256 MB). Auf Systemen mit 1 GB RAM `MAX_RAW_MESSAGE_BYTES` und/oder `WORKER_CONCURRENCY` senken, siehe [Konfiguration](configuration.md#sync-und-limits).

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
node scripts/setup-env.mjs
```

Ohne Node auf dem Host geht es auch mit einem Wegwerf-Container:

```sh
docker run --rm -v "$PWD":/app -w /app node:24-alpine node scripts/setup-env.mjs
```

(Bei rootful Docker gehört die `.env` dann root: `sudo chown $USER .env`.)

Das Skript schreibt eine `.env` (Rechte `0600`) mit:

| Variable                                | Inhalt                                                        |
| --------------------------------------- | ------------------------------------------------------------- |
| `DOMAIN`                                | `:80` (HTTP ohne TLS) – im nächsten Schritt anpassen          |
| `MASTER_KEY`                            | zufälliger 32-Byte-Schlüssel (base64) für die Verschlüsselung |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | Schlüsselpaar für Web Push                                    |
| `VAPID_SUBJECT`                         | `mailto:admin@example.com` – eigene Kontaktadresse eintragen  |
| `POSTGRES_USER`, `POSTGRES_DB`          | `mail`                                                        |
| `POSTGRES_PASSWORD`                     | zufälliges Datenbankpasswort                                  |

Eine vorhandene `.env` wird nie überschrieben. Alle weiteren Einstellungen haben sinnvolle Standardwerte; die vollständige Liste steht in [Konfiguration](configuration.md) und in `.env.example`.

> **Den `MASTER_KEY` jetzt sichern – getrennt vom Server und von den Backups** (Passwortmanager, Ausdruck im Safe). Alle Mails und Zugangsdaten sind damit verschlüsselt. Geht er verloren, sind Datenbank und Backups wertlos; es gibt keine Hintertür. Die `.env` nie in Git committen.

## 4. Domain eintragen

In der `.env`:

```sh
DOMAIN=mail.example.org
VAPID_SUBJECT=mailto:du@example.org
```

`DOMAIN` ist die Site-Adresse für Caddy. Mit einem Domainnamen holt Caddy beim Start automatisch ein Let's-Encrypt-Zertifikat und leitet HTTP auf HTTPS um; außerdem setzt die API dann das Session-Cookie mit `Secure`. Nur für einen Test im LAN `DOMAIN=:80` stehen lassen.

## 5. Starten

```sh
docker compose up -d --build --wait
```

Das baut die Images (web, api, worker), startet alle Dienste und wartet, bis caddy, web, api und postgres `healthy` sind. Beim ersten Start legt die API das Datenbankschema an (Migrationen).

Kontrolle:

```sh
docker compose ps                    # alle Dienste "running" bzw. "healthy"
docker compose logs --tail=50 api    # "migrations applied"
docker compose logs --tail=50 worker # keine Fehler, kein Neustart-Loop
docker compose logs --tail=50 caddy  # Zertifikat erhalten ("certificate obtained")
```

Der Worker hat keinen Healthcheck; er sollte dauerhaft `running` sein (nicht `restarting`). Bei Problemen: [Troubleshooting](troubleshooting.md).

## 6. Benutzer anlegen (Ersteinrichtung)

`https://mail.example.org` im Browser öffnen. Solange noch kein Benutzer existiert, erscheint **„Einrichtung“**: E-Mail-Adresse (dient nur als Login-Name) und Passwort (mindestens 10 Zeichen) eingeben, **„Konto erstellen“**.

> **Direkt nach dem ersten Start erledigen.** Die Instanz ist Single-User ([ADR-0004](../adr/0004-auth.md)): Wer die Seite als Erster aufruft, legt den Benutzer an. Danach ist die Einrichtung gesperrt; ein weiterer Benutzer ist nicht möglich.

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
