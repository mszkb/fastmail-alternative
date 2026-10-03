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

Der Server speichert **alle Mails vollständig** (ADR-0001). Lesbare Inhalte in der DB und alle Dateien im Volume `mail-data` sind mit einem Data Key pro Konto verschlüsselt (siehe [data-model.md](data-model.md#verschlüsselung)). Ohne `MASTER_KEY` sind DB-Dump und Volume unlesbar. Die Betreiber-Doku muss das Sichern des Keys getrennt vom Backup klar beschreiben.

## Schutzmaßnahmen

| Bedrohung                      | Maßnahme                                                                                                                                                                |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Brute Force / Missbrauch       | Rate Limits auf Login, Konto-Test, Versand                                                                                                                              |
| CSRF                           | CSRF-Token bzw. SameSite + Origin-Prüfung                                                                                                                               |
| Session-Diebstahl              | Rotation, Gerätebindung, Widerruf                                                                                                                                       |
| SSRF über Mailserver-Hostnamen | Auflösung prüfen, private/Loopback/Link-Local-Adressen standardmäßig blockieren (für Self-Hoster mit internem Mailserver konfigurierbar freigebbar), nur erlaubte Ports |
| Bösartige HTML-Mails           | Sanitizing, strikte CSP, Rendering in sandboxed iframe, Remote-Content opt-in                                                                                           |
| Bösartige Anhänge              | Auslieferung mit `Content-Disposition: attachment`, eigener Origin/Sandbox, Größenlimits                                                                                |
| Datenabfluss über Logs         | Zentrale Redaction, Tests dafür                                                                                                                                         |
| Datenabfluss über Push         | Inhaltsfreie Payloads (siehe [push.md](push.md))                                                                                                                        |

## HTML-Mails

Umgesetzt in Roadmap 2.9. Drei unabhängige Schichten, jede für sich soll Script-Ausführung und ungewolltes Nachladen verhindern:

1. **Sanitizing auf dem Server** (`apps/api/src/mail/html-sanitizer.ts`, sanitize-html): strikte Tag-/Attribut-Allowlist (kein `script`, `iframe`, `object`/`embed`, Formulare, `meta`/`base`/`link`, `svg`/`math`, keine Event-Handler). Links nur `http(s)`/`mailto`, immer `target="_blank" rel="noopener noreferrer nofollow"`. CSS (`style`-Attribute und `<style>`-Blöcke) wird nach dem Dekodieren von Escapes gefiltert: `@import`, `expression()`, `image-set()` u. ä. entfernt, `url()` über dieselbe URL-Policy wie Bilder.
2. **Remote-Content opt-in:** Bilder/Hintergründe aus dem Netz werden standardmäßig entfernt (`remoteContentBlocked: true`); erst nach Klick auf „Laden" (pro Nachricht, `?remote=1`) bleiben absolute `http(s)`-Bild-URLs erhalten. Inline-Bilder (`cid:`) werden als `data:`-URL eingebettet (nur Rasterformate, kein SVG, größenbegrenzt). Relative URLs werden nie geladen.
3. **Sandboxed iframe + CSP im Client:** Darstellung per `srcdoc` mit `sandbox="allow-popups allow-popups-to-escape-sandbox"` (ohne `allow-scripts`, ohne `allow-same-origin` → opaker Origin) und CSP `default-src 'none'; img-src data: [http: https:]; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'`, kein Referrer.

Da der Parent ohne Scripts/Same-Origin die Höhe des iframes nicht messen kann (und Mail-HTML nicht zum Messen ins App-DOM gerendert wird), hat der Rahmen eine feste, vom Nutzer veränderbare Höhe und scrollt intern. `position: fixed` u. ä. bleibt erlaubt, wirkt aber nur innerhalb des iframes. Die API liefert `Cache-Control: no-store` und loggt keine Inhalte.

## Backups

- Backups werden **verschlüsselt**.
- Wiederherstellung wird **regelmäßig getestet** (automatisierter Restore-Test in CI, Phase 6).
- Restore auf einer frischen Installation muss mit dokumentierten Schritten funktionieren.

## Offene Punkte

- Bedrohungsmodell ausarbeiten → `docs/architecture/threat-model.md` (Phase 0, Aufgabe 0.3).
