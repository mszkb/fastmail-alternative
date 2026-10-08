# Umzug auf einen neuen Server

Es gibt zwei Wege, eine Instanz auf einen anderen Server zu bringen:

|                     | **A: Vollständiger Umzug** (Backup/Restore)                    | **B: Konfiguration exportieren/importieren**                          |
| ------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------- |
| Was wird übertragen | alles: Konten, Zugangsdaten, Mails, Postausgang, Geräte, Push  | Konten (Server, Ports, Benutzernamen), Identitäten, Ordnerzuordnungen |
| Passwörter          | bleiben erhalten (verschlüsselt)                               | **müssen je Konto neu eingegeben werden**                             |
| Mails               | sofort da                                                      | werden vom Mailanbieter neu synchronisiert                            |
| Voraussetzung       | Datenbank, Volume `mail-data` **und** derselbe `MASTER_KEY`    | nur die Exportdatei                                                   |
| Geeignet für        | Serverwechsel, Hardwaretausch, gleiche oder neuere App-Version | Neuanfang, verlorener `MASTER_KEY`, Aufräumen, Test-Instanz           |

Beide Wege setzen auf dem Zielserver eine Installation voraus ([Docker](installation.md) oder [Webspace](installation-php.md)).

## A: Vollständiger Umzug (Datenbank + `mail-data` + `MASTER_KEY`)

Alle Inhalte und Zugangsdaten sind mit Data Keys verschlüsselt, die ihrerseits mit dem `MASTER_KEY` verpackt in der Datenbank liegen ([Datenmodell → Verschlüsselung](../architecture/data-model.md#verschlüsselung)). Datenbank und Volume sind deshalb **nur zusammen mit genau diesem `MASTER_KEY`** lesbar. Ohne ihn hilft nur Weg B.

Der Umzug ist ein verschlüsseltes Backup auf dem alten und ein Restore auf dem neuen Server ([Backup & Restore](backup-restore.md)). Das Backup enthält Datenbank und `mail-data` in einer Datei; es funktioniert ebenso zwischen Docker und Webspace in beide Richtungen.

### 1. Alten Server sichern

Im Projektverzeichnis (z. B. `~/fastmail-alternative`):

```sh
./scripts/backup.sh                 # schreibt backups/fma-backup-<zeit>.fmabk
docker compose stop worker          # ab jetzt nichts mehr abgleichen oder senden
```

Zusätzlich die `.env` sichern – sie enthält `MASTER_KEY`, `MASTER_KEY_ID`, die VAPID-Schlüssel und das Datenbankpasswort. Die `.env` **getrennt** von der Backup-Datei übertragen und aufbewahren (wer Backup und Key zusammen hat, kann alles entschlüsseln).

### 2. Neuen Server einrichten

```sh
git clone <repo> ~/fastmail-alternative && cd ~/fastmail-alternative
# .env vom alten Server übernehmen (NICHT neu erzeugen: anderer MASTER_KEY = Daten unlesbar)
cp /pfad/zur/gesicherten/.env .env
```

Dann das Backup einspielen wie unter [Restore auf einer frischen Instanz](backup-restore.md#restore-auf-einer-frischen-instanz) beschrieben (nur mariadb starten, `backup restore`, `mail-data` an `www-data` übergeben, Postausgang prüfen, dann alles starten). Die App-Version auf dem neuen Server muss gleich oder neuer sein.

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

1. Neue Instanz einrichten (`./scripts/setup-env.sh`, `docker compose up -d --build --wait`, siehe [Installation](installation.md)) und den Benutzer anlegen.
2. **Einstellungen → Konfiguration übertragen → Importieren …** und die Datei wählen (API: `POST /api/import/config`).
3. Die Konten erscheinen mit dem Hinweis **„Passwort fehlt“** (Status `auth_error`, Code `CREDENTIALS_REQUIRED`). Bis das Passwort eingegeben ist, läuft für diese Konten kein Abgleich.
4. Je Konto **Bearbeiten** wählen und das Passwort (bei abweichenden SMTP-Zugangsdaten auch das SMTP-Passwort) eingeben. Nach erfolgreichem Verbindungstest startet der Abgleich; die Ordnerzuordnungen bleiben erhalten.

Konten, deren Mailadresse auf der Zielinstanz schon existiert, werden übersprungen – ein wiederholter Import ist also gefahrlos.

Nicht übertragen werden: Mails (kommen vom Anbieter), der Postausgang, Geräte/Sitzungen und Push-Abos (je Gerät neu anmelden bzw. aktivieren) sowie der Login des Benutzers selbst.
