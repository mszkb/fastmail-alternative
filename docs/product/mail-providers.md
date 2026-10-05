# Mailanbieter und Kompatibilität

Welche Anbieter die App ansprechen kann, mit welchen Zugangsdaten, und welche IMAP-Erweiterungen sie nutzt. Grundlage für Roadmap 0.5 (#18); Risiken siehe [Externe Abhängigkeiten](../process/external-dependencies.md).

## Was die App von einem Server braucht

| Erweiterung  | Wofür in der App                                                            | Ohne die Erweiterung                                                                                |
| ------------ | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| IDLE         | Neue Mails im Posteingang binnen Sekunden (`apps/worker/src/idle.ts`)       | Nur der periodische Abgleich (`SYNC_INTERVAL_SECONDS`, Standard 120 s)                              |
| CONDSTORE    | Nur geänderte Flags abgleichen (`CHANGEDSINCE`, #28)                        | Vollständiger Flag-Abgleich je Lauf – funktioniert, kostet bei großen Ordnern mehr Zeit und Traffic |
| QRESYNC      | Derzeit **nicht genutzt** (Löschungen werden über den UID-Abgleich erkannt) | –                                                                                                   |
| MOVE         | Verschieben, Archivieren, Löschen in den Papierkorb (`messageMove`)         | imapflow weicht auf `COPY` + `\Deleted` + `EXPUNGE` aus                                             |
| SPECIAL-USE  | Ordnerrollen (Posteingang, Gesendet, Entwürfe, Papierkorb, Archiv, Spam)    | Rollen über übliche Ordnernamen; sonst manuelle Zuordnung in den Einstellungen                      |
| STARTTLS/TLS | **Pflicht** – Port 993/465 mit TLS oder STARTTLS auf 143/587/25             | Verbindung wird vor dem Login abgebrochen (`TLS_REQUIRED`)                                          |

Erlaubte Ports: IMAP 143/993, SMTP 25/465/587/2525; weitere nur mit `MAIL_EXTRA_PORTS` ([Konfiguration](../operations/configuration.md)).

## Anbieter

**Stand der Matrix:** Die Erweiterungs-Spalten geben den öffentlich dokumentierten bzw. allgemein bekannten Stand wieder und sind **noch nicht gegen echte Konten geprüft** (Spalte „Geprüft“). ✓ = vorhanden, ✗ = fehlt, ? = unklar. Die App erkennt die Fähigkeiten zur Laufzeit selbst und hängt nicht von dieser Tabelle ab.

| Anbieter                    | IMAP / SMTP                                                                   | Anmeldung                                      | IDLE | CONDSTORE | QRESYNC | MOVE | SPECIAL-USE | Geprüft | Hinweise                                                                                 |
| --------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------- | ---- | --------- | ------- | ---- | ----------- | ------- | ---------------------------------------------------------------------------------------- |
| Dovecot (eigener Server)    | eigener Host, 993 / 465 oder 587                                              | Passwort                                       | ✓    | ✓         | ✓       | ✓    | ✓           | –       | Referenz; SPECIAL-USE nur, wenn in der Konfiguration gesetzt                             |
| Cyrus (eigener Server)      | eigener Host, 993 / 465 oder 587                                              | Passwort                                       | ✓    | ✓         | ✓       | ✓    | ✓           | –       |                                                                                          |
| Fastmail                    | `imap.fastmail.com` 993 / `smtp.fastmail.com` 465                             | App-Passwort                                   | ✓    | ✓         | ✓       | ✓    | ✓           | –       | Cyrus-basiert                                                                            |
| Posteo                      | `posteo.de` 993 / `posteo.de` 465 oder 587                                    | Passwort                                       | ✓    | ✓         | ✓       | ✓    | ✓           | –       | Dovecot-basiert                                                                          |
| mailbox.org                 | `imap.mailbox.org` 993 / `smtp.mailbox.org` 465 oder 587                      | Passwort                                       | ✓    | ✓         | ✓       | ✓    | ✓           | –       | Dovecot-basiert                                                                          |
| Gmail / Google Workspace    | `imap.gmail.com` 993 / `smtp.gmail.com` 465 oder 587                          | App-Passwort (nur mit 2-Faktor), später OAuth2 | ✓    | ✓         | ✗       | ✓    | ✓           | –       | Labels erscheinen als Ordner; „Alle Nachrichten“ enthält Duplikate; OAuth2 kommt mit #36 |
| iCloud Mail                 | `imap.mail.me.com` 993 / `smtp.mail.me.com` 587                               | App-spezifisches Passwort                      | ✓    | ?         | ?       | ?    | ?           | –       |                                                                                          |
| Yahoo Mail                  | `imap.mail.yahoo.com` 993 / `smtp.mail.yahoo.com` 465 oder 587                | App-Passwort                                   | ✓    | ?         | ?       | ✓    | ?           | –       |                                                                                          |
| GMX / Web.de                | `imap.gmx.net` bzw. `imap.web.de` 993 / `mail.gmx.net` bzw. `smtp.web.de` 587 | Passwort                                       | ?    | ?         | ?       | ?    | ?           | –       | IMAP-Zugriff muss im Webmail erst eingeschaltet werden                                   |
| Microsoft 365 / Outlook.com | `outlook.office365.com` 993 / `smtp.office365.com` 587                        | **nur OAuth2** (Basic Auth abgeschaltet)       | ✓    | ✗         | ✗       | ✓    | ✓           | –       | Ohne OAuth2 (#36) **nicht nutzbar**                                                      |
| GreenMail (nur Tests)       | lokal, 3143 / 3025                                                            | Passwort                                       | ✓    | ?         | ?       | ?    | ?           | CI      | Nur mit `MAIL_INSECURE_TRANSPORT=1`; Grundlage der Integrations- und E2E-Tests           |

## Prüfen, was ein Server wirklich kann

Beim Anlegen eines Kontos und beim Ändern seiner Verbindung liest die api im Verbindungstest die IMAP-Fähigkeiten und speichert sie unverschlüsselt (keine Mailinhalte) in `mail_account.capabilities`. Auf der eigenen Instanz:

```sh
docker compose exec postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
  SELECT imap_host, capabilities FROM mail_account ORDER BY imap_host"'
```

Ein geprüfter Anbieter bekommt in der Spalte „Geprüft“ das Datum; abweichende Werte in der Tabelle korrigieren.
