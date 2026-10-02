# Definition of Done

Ein Issue/PR gilt als erledigt, wenn alle zutreffenden Punkte erfüllt sind.

## Code

- [ ] Akzeptanzkriterien des Issues erfüllt
- [ ] Lint, Format und Typecheck grün
- [ ] Code reviewt (mindestens ein Review)
- [ ] Keine neuen TODOs ohne verlinktes Issue

## Tests

- [ ] Unit-Tests für neue Logik
- [ ] Integrationstests für API-Endpunkte, Worker-Jobs und IMAP/SMTP-Interaktion (gegen Test-Mailserver, z. B. GreenMail/Dovecot im Container)
- [ ] Fehlerpfade getestet (ungültige Zugangsdaten, Provider down, Timeouts)
- [ ] CI grün

## Security

- [ ] Keine Zugangsdaten, Mailinhalte oder Betreffzeilen in Logs, Fehlermeldungen oder Push-Payloads
- [ ] Eingaben validiert; Ausgaben (insbesondere HTML-Mails) sanitisiert
- [ ] Neue Endpunkte: Auth, Autorisierung, Rate Limit und CSRF geprüft
- [ ] Neue Abhängigkeiten auf bekannte Schwachstellen und Lizenz geprüft

## Dokumentation

- [ ] Nutzer- bzw. Betreiber-Doku aktualisiert, falls Verhalten oder Konfiguration sich ändert
- [ ] ADR angelegt/aktualisiert, falls eine Architekturentscheidung getroffen wurde
- [ ] Status in `ROADMAP.md` aktualisiert
- [ ] Changelog-Eintrag (ab Phase 7)

## Deployment

- [ ] Datenbankmigrationen vorwärts lauffähig und idempotent
- [ ] Neue Konfigurationsoptionen mit sicheren Defaults und in `.env.example` dokumentiert
- [ ] `docker compose up` auf frischer Instanz funktioniert, Healthchecks grün
- [ ] Upgrade von der vorherigen Version funktioniert
