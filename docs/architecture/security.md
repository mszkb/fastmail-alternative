# Daten- und Sicherheitsmodell

## Zugangsdaten

- IMAP-/SMTP-Passwörter und OAuth-Tokens werden **verschlüsselt at rest** gespeichert (Envelope-Encryption: pro Datensatz ein Data Key, verschlüsselt mit dem Master-Key; AEAD wie AES-256-GCM oder XChaCha20-Poly1305).
- Der **Master-Key** wird ausschließlich über Secret-Management bzw. Umgebungs-Secret (z. B. Docker Secret) eingebracht. Er liegt nie im Repo, nie in der Datenbank, nie in Backups.
- Key-Rotation muss möglich und dokumentiert sein.
- Zugangsdaten erscheinen **niemals** in Logs, Fehlertexten, Push-Payloads oder Support-Exports.

## Benutzer, Geräte, Sessions

- Pro Benutzer mehrere Geräte und Push-Subscriptions.
- Sessions sind an Geräte gebunden und einzeln widerrufbar.
- Sichere Session-Rotation (nach Login, Rechteänderung, periodisch).
- Cookies: `HttpOnly`, `Secure`, `SameSite=Lax/Strict`.

## Serverseitige Mailkopie

Explizit konfigurierbarer Modus: **Proxy**, **Index** oder **Cache** (ADR-0001). Der Modus und seine Datenschutzfolgen müssen in der Betreiber-Doku klar beschrieben sein.

## Schutzmaßnahmen

| Bedrohung | Maßnahme |
| --- | --- |
| Brute Force / Missbrauch | Rate Limits auf Login, Konto-Test, Versand |
| CSRF | CSRF-Token bzw. SameSite + Origin-Prüfung |
| Session-Diebstahl | Rotation, Gerätebindung, Widerruf |
| SSRF über Mailserver-Hostnamen | Auflösung prüfen, private/Loopback/Link-Local-Adressen standardmäßig blockieren (für Self-Hoster mit internem Mailserver konfigurierbar freigebbar), nur erlaubte Ports |
| Bösartige HTML-Mails | Sanitizing, strikte CSP, Rendering in sandboxed iframe, Remote-Content opt-in |
| Bösartige Anhänge | Auslieferung mit `Content-Disposition: attachment`, eigener Origin/Sandbox, Größenlimits |
| Datenabfluss über Logs | Zentrale Redaction, Tests dafür |
| Datenabfluss über Push | Inhaltsfreie Payloads (siehe [push.md](push.md)) |

## Backups

- Backups werden **verschlüsselt**.
- Wiederherstellung wird **regelmäßig getestet** (automatisierter Restore-Test in CI, Phase 6).
- Restore auf einer frischen Installation muss mit dokumentierten Schritten funktionieren.

## Offene Punkte

- Bedrohungsmodell ausarbeiten → `docs/architecture/threat-model.md` (Phase 0, Aufgabe 0.3).
