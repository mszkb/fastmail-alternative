# Mailanbieter und Kompatibilität

Welche Anbieter die App ansprechen kann, mit welchen Zugangsdaten, und welche IMAP-Erweiterungen sie nutzt. Grundlage für Roadmap 0.5 (#18); Risiken siehe [Externe Abhängigkeiten](../process/external-dependencies.md).

## Was die App von einem Server braucht

| Erweiterung  | Wofür in der App                                                                       | Ohne die Erweiterung                                                                                |
| ------------ | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| IDLE         | Neue Mails im Posteingang binnen Sekunden (`apps/server-php/src/Jobs/IdleManager.php`) | Nur der periodische Abgleich (`SYNC_INTERVAL_SECONDS`, Standard 120 s)                              |
| CONDSTORE    | Nur geänderte Flags abgleichen (`CHANGEDSINCE`, #28)                                   | Vollständiger Flag-Abgleich je Lauf – funktioniert, kostet bei großen Ordnern mehr Zeit und Traffic |
| QRESYNC      | Derzeit **nicht genutzt** (Löschungen werden über den UID-Abgleich erkannt)            | –                                                                                                   |
| MOVE         | Verschieben, Archivieren, Löschen in den Papierkorb (`messageMove`)                    | Ausweichen auf `UID COPY` + `\Deleted` + `EXPUNGE`                                                  |
| SPECIAL-USE  | Ordnerrollen (Posteingang, Gesendet, Entwürfe, Papierkorb, Archiv, Spam)               | Rollen über übliche Ordnernamen; sonst manuelle Zuordnung in den Einstellungen                      |
| STARTTLS/TLS | **Pflicht** – Port 993/465 mit TLS oder STARTTLS auf 143/587/25                        | Verbindung wird vor dem Login abgebrochen (`TLS_REQUIRED`)                                          |

Erlaubte Ports: IMAP 143/993, SMTP 25/465/587/2525; weitere nur mit `MAIL_EXTRA_PORTS` ([Konfiguration](../operations/configuration.md)).

## Anbieter

**Stand der Matrix:** Die Erweiterungs-Spalten geben den öffentlich dokumentierten bzw. allgemein bekannten Stand wieder und sind **noch nicht gegen echte Konten geprüft** (Spalte „Geprüft“). ✓ = vorhanden, ✗ = fehlt, ? = unklar. Die App erkennt die Fähigkeiten zur Laufzeit selbst und hängt nicht von dieser Tabelle ab.

| Anbieter                    | IMAP / SMTP                                                                   | Anmeldung                                   | IDLE | CONDSTORE | QRESYNC | MOVE | SPECIAL-USE | Geprüft | Hinweise                                                                            |
| --------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------- | ---- | --------- | ------- | ---- | ----------- | ------- | ----------------------------------------------------------------------------------- |
| Dovecot (eigener Server)    | eigener Host, 993 / 465 oder 587                                              | Passwort                                    | ✓    | ✓         | ✓       | ✓    | ✓           | –       | Referenz; SPECIAL-USE nur, wenn in der Konfiguration gesetzt                        |
| Cyrus (eigener Server)      | eigener Host, 993 / 465 oder 587                                              | Passwort                                    | ✓    | ✓         | ✓       | ✓    | ✓           | –       |                                                                                     |
| Fastmail                    | `imap.fastmail.com` 993 / `smtp.fastmail.com` 465                             | App-Passwort                                | ✓    | ✓         | ✓       | ✓    | ✓           | –       | Cyrus-basiert                                                                       |
| Posteo                      | `posteo.de` 993 / `posteo.de` 465 oder 587                                    | Passwort                                    | ✓    | ✓         | ✓       | ✓    | ✓           | –       | Dovecot-basiert                                                                     |
| mailbox.org                 | `imap.mailbox.org` 993 / `smtp.mailbox.org` 465 oder 587                      | Passwort                                    | ✓    | ✓         | ✓       | ✓    | ✓           | –       | Dovecot-basiert                                                                     |
| Gmail / Google Workspace    | `imap.gmail.com` 993 / `smtp.gmail.com` 465 oder 587                          | OAuth2 oder App-Passwort (nur mit 2-Faktor) | ✓    | ✓         | ✗       | ✓    | ✓           | –       | Labels erscheinen als Ordner; „Alle Nachrichten“ enthält Duplikate; OAuth2 seit #36 |
| iCloud Mail                 | `imap.mail.me.com` 993 / `smtp.mail.me.com` 587                               | App-spezifisches Passwort                   | ✓    | ?         | ?       | ?    | ?           | –       |                                                                                     |
| Yahoo Mail                  | `imap.mail.yahoo.com` 993 / `smtp.mail.yahoo.com` 465 oder 587                | App-Passwort                                | ✓    | ?         | ?       | ✓    | ?           | –       |                                                                                     |
| GMX / Web.de                | `imap.gmx.net` bzw. `imap.web.de` 993 / `mail.gmx.net` bzw. `smtp.web.de` 587 | Passwort                                    | ?    | ?         | ?       | ?    | ?           | –       | IMAP-Zugriff muss im Webmail erst eingeschaltet werden                              |
| Microsoft 365 / Outlook.com | `outlook.office365.com` 993 / `smtp.office365.com` 587                        | **nur OAuth2** (Basic Auth abgeschaltet)    | ✓    | ✗         | ✗       | ✓    | ✓           | –       | Nur mit eingerichteter OAuth-App ([oauth.md](../operations/oauth.md))               |
| GreenMail (nur Tests)       | lokal, 3143 / 3025                                                            | Passwort                                    | ✓    | ?         | ?       | ?    | ?           | CI      | Nur mit `MAIL_INSECURE_TRANSPORT=1`; Grundlage der Integrations- und E2E-Tests      |

## Vorlagen in der Kontoeinrichtung

„Konto hinzufügen“ bietet für die Anbieter oben eine Vorlage (#117, `PROVIDER_PRESETS` in `packages/shared/src/provider-presets.ts`): Auswahl unter „Anbieter“ oder automatisch nach der Domain der Adresse. Die Vorlage füllt IMAP-/SMTP-Server und Ports (993 bzw. 465/587, TLS), setzt die Adresse als Benutzer und erklärt, welches Passwort der Anbieter erwartet (App-Passwort bei Fastmail, Gmail, iCloud, Yahoo; Hinweis auf den IMAP-Schalter bei GMX/Web.de). Bei Gmail und Microsoft bietet sie „Mit Google/Microsoft anmelden“, wenn der Betreiber die OAuth-App eingerichtet hat ([Anleitung](../operations/oauth.md), #36); Microsoft geht nur so. Ändern sich Serverdaten eines Anbieters, hier und in der Vorlage nachziehen. Der Verbindungstest beim Speichern prüft die Daten wie bei manueller Eingabe.

**Stand der Prüfung gegen echte Konten:** Die Felder sind per Unit- und Playwright-Test abgedeckt; ein Verbindungstest mit einem echten Fastmail-Konto (App-Passwort) steht noch aus und wird hier mit Datum eingetragen.

## Suche beim Anbieter

Die Suche (pro Konto und global über alle Konten, [ADR-0006](../adr/0006-search-index.md)) nutzt `UID SEARCH` des Anbieters. Was dabei je Anbieter abweichen kann – bei der Prüfung gegen echte Konten mit festhalten:

- **Teilstrings:** RFC 3501 verlangt Teilstring-Suche für `TEXT`, `FROM`, `TO`, `SUBJECT`. Manche Server vergleichen Adressen nur vollständig (z. B. GreenMail bei `FROM`), Server mit Volltextindex finden in `TEXT` je nach Konfiguration nur ganze Wörter (z. B. Dovecot mit FTS-Plugin).
- **Umlaute:** Nicht-ASCII-Begriffe gehen als Literal mit `CHARSET UTF-8`. Server ohne UTF-8-Unterstützung antworten mit `NO [BADCHARSET]`; der Ordner zählt dann als „nicht durchsuchbar“.
- **`has:attachment`:** IMAP kennt kein Anhang-Kriterium. Die App sucht `HEADER Content-Type "multipart/mixed"`; das trifft die üblichen Mails mit Anhang, aber nicht z. B. ein einzelnes PDF ohne Text oder `multipart/related` mit eingebetteten Bildern.
- **`is:unread`:** `UNSEEN` – zuverlässig, solange der Anbieter das `\Seen`-Flag führt.
- **Geschwindigkeit:** Ohne Index beim Anbieter wird `TEXT` in großen Ordnern langsam; die globale Suche hat je Konto 10 s und insgesamt 25 s Zeit, langsamere Konten erscheinen mit „Zeitüberschreitung“.

## Prüfen, was ein Server wirklich kann

Beim Anlegen eines Kontos und beim Ändern seiner Verbindung liest das Backend im Verbindungstest die IMAP-Fähigkeiten und speichert sie unverschlüsselt (keine Mailinhalte) in `mail_account.capabilities`. Auf der eigenen Instanz:

```sh
docker compose exec mariadb sh -c 'mariadb -u"$MARIADB_USER" -p"$MARIADB_PASSWORD" "$MARIADB_DATABASE" -e "
  SELECT imap_host, capabilities FROM mail_account ORDER BY imap_host"'
```

Ein geprüfter Anbieter bekommt in der Spalte „Geprüft“ das Datum; abweichende Werte in der Tabelle korrigieren.
