# Umzug auf einen neuen Server

Es gibt zwei Wege, eine Instanz auf einen anderen Server zu bringen:

|                     | **A: Vollständiger Umzug** (Backup/Restore)                    | **B: Konfiguration exportieren/importieren**                          |
| ------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------- |
| Was wird übertragen | alles: Konten, Zugangsdaten, Mails, Postausgang, Geräte, Push  | Konten (Server, Ports, Benutzernamen), Identitäten, Ordnerzuordnungen |
| Passwörter          | bleiben erhalten (verschlüsselt)                               | **müssen je Konto neu eingegeben werden**                             |
| Mails               | sofort da                                                      | werden vom Mailanbieter neu synchronisiert                            |
| Voraussetzung       | Datenbank, Volume `mail-data` **und** derselbe `MASTER_KEY`    | nur die Exportdatei                                                   |
| Geeignet für        | Serverwechsel, Hardwaretausch, gleiche oder neuere App-Version | Neuanfang, verlorener `MASTER_KEY`, Aufräumen, Test-Instanz           |

Beide Wege setzen auf dem Zielserver eine laufende Installation voraus (`docker compose`, siehe [ADR-0007](../adr/0007-deployment.md)).

## A: Vollständiger Umzug (Datenbank + `mail-data` + `MASTER_KEY`)

Alle Inhalte und Zugangsdaten sind mit Data Keys verschlüsselt, die ihrerseits mit dem `MASTER_KEY` verpackt in der Datenbank liegen ([Datenmodell → Verschlüsselung](../architecture/data-model.md#verschlüsselung)). Datenbank und Volume sind deshalb **nur zusammen mit genau diesem `MASTER_KEY`** lesbar. Ohne ihn hilft nur Weg B.

> **Einfacher:** Mit dem Backup-Werkzeug ist der Umzug ein verschlüsseltes Backup auf dem alten und ein Restore auf dem neuen Server, siehe [Backup & Restore](backup-restore.md). Die folgenden Einzelschritte funktionieren weiterhin ohne das Werkzeug.

### 1. Alten Server sichern

Im Projektverzeichnis (z. B. `~/fastmail-alternative`):

```sh
# Schreibzugriffe stoppen (Worker und API), Datenbank läuft weiter
docker compose stop worker api

# Datenbank-Dump (Benutzer/DB-Name aus der .env, Standard: mail/mail)
docker compose exec -T postgres pg_dump -U mail -Fc mail > fma-db.dump

# Volume mit den verschlüsselten Rohmails; der Volume-Name trägt den
# Projektnamen als Präfix (prüfen mit: docker volume ls | grep mail-data)
docker run --rm -v fastmail-alternative_mail-data:/data:ro -v "$PWD":/backup \
  alpine tar czf /backup/fma-mail-data.tgz -C /data .
```

Zusätzlich die `.env` sichern – sie enthält `MASTER_KEY`, `MASTER_KEY_ID`, die VAPID-Schlüssel und das Datenbankpasswort. Die `.env` **getrennt** vom Dump und vom Volume-Archiv übertragen und aufbewahren (wer Dump und Key zusammen hat, kann alles entschlüsseln).

### 2. Neuen Server einrichten

```sh
git clone <repo> ~/fastmail-alternative && cd ~/fastmail-alternative
# .env vom alten Server übernehmen (NICHT neu erzeugen: anderer MASTER_KEY = Daten unlesbar)
cp /pfad/zur/gesicherten/.env .env

# Nur die Datenbank starten und den Dump einspielen
docker compose up -d postgres
docker compose exec -T postgres pg_restore -U mail -d mail --clean --if-exists < fma-db.dump

# Volume befüllen (Volume wird beim ersten Zugriff angelegt)
docker run --rm -v fastmail-alternative_mail-data:/data -v "$PWD":/backup \
  alpine sh -c 'tar xzf /backup/fma-mail-data.tgz -C /data && chown -R 1000:1000 /data'

# Alles starten; die API führt ausstehende Migrationen beim Start aus
docker compose up -d
```

Der Besitzer `1000:1000` entspricht dem Benutzer im Worker-Image; bei abweichenden Images den Besitzer des alten Volumes übernehmen (`ls -n` im Volume).

### 3. Prüfen

- Anmeldung mit dem bisherigen Benutzer, Konten zeigen „verbunden“, Mails sind sofort sichtbar.
- Ändert sich die Domain, auf jedem Gerät neu anmelden und die App neu installieren; Push-Abos sind an die alte Domain gebunden und müssen unter „Benachrichtigungen“ neu aktiviert werden.
- Danach den alten Server stilllegen (`docker compose down -v` löscht dort auch die Volumes).

## B: Konfiguration exportieren und importieren

Die Exportdatei enthält **keine Geheimnisse**: keine Passwörter, keine OAuth-Tokens, keine Schlüssel und keine Mailinhalte (geprüft durch Tests). Sie darf trotzdem nicht öffentlich geteilt werden – sie enthält Mailadressen, Servernamen, Benutzernamen und Signaturen.

### Export (alter Server)

**Einstellungen → Konfiguration übertragen → Exportieren** lädt `fma-config-JJJJ-MM-TT.json` herunter (API: `GET /api/export/config`). Inhalt je Konto:

- Anzeigename, Mailadresse, Reihenfolge, Anmeldeart, Initial-Sync-Grenze
- IMAP/SMTP: Host, Port, Benutzername
- Identitäten mit Anzeigename, Adresse, Signatur und Standard-Kennzeichen
- manuelle Ordnerzuordnungen (Gesendet, Entwürfe, Papierkorb, Archiv, Spam)

Das Format ist versioniert (`"format": "fma-config"`, `"version": 1`); eine Instanz importiert Dateien ihrer eigenen und älterer Versionen.

### Import (neuer Server)

1. Neue Instanz einrichten (`node scripts/setup-env.mjs`, `docker compose up -d`) und den Benutzer anlegen.
2. **Einstellungen → Konfiguration übertragen → Importieren …** und die Datei wählen (API: `POST /api/import/config`).
3. Die Konten erscheinen mit dem Hinweis **„Passwort fehlt“** (Status `auth_error`, Code `CREDENTIALS_REQUIRED`). Bis das Passwort eingegeben ist, läuft für diese Konten kein Abgleich.
4. Je Konto **Bearbeiten** wählen und das Passwort (bei abweichenden SMTP-Zugangsdaten auch das SMTP-Passwort) eingeben. Nach erfolgreichem Verbindungstest startet der Abgleich; die Ordnerzuordnungen bleiben erhalten.

Konten, deren Mailadresse auf der Zielinstanz schon existiert, werden übersprungen – ein wiederholter Import ist also gefahrlos.

Nicht übertragen werden: Mails (kommen vom Anbieter), der Postausgang, Geräte/Sitzungen und Push-Abos (je Gerät neu anmelden bzw. aktivieren) sowie der Login des Benutzers selbst.
