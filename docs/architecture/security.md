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
| Brute Force / Missbrauch       | Rate Limits auf Login, Konto-Test, Versand, Suche beim Provider                                                                                                         |
| CSRF                           | CSRF-Token bzw. SameSite + Origin-Prüfung                                                                                                                               |
| Session-Diebstahl              | Rotation, Gerätebindung, Widerruf                                                                                                                                       |
| SSRF über Mailserver-Hostnamen | Auflösung prüfen, private/Loopback/Link-Local-Adressen standardmäßig blockieren (für Self-Hoster mit internem Mailserver konfigurierbar freigebbar), nur erlaubte Ports |
| Bösartige HTML-Mails           | Sanitizing, strikte CSP, Rendering in sandboxed iframe, Remote-Content opt-in                                                                                           |
| Bösartige Anhänge              | Auslieferung mit `Content-Disposition: attachment`, eigener Origin/Sandbox, Größenlimits                                                                                |
| Datenabfluss über Logs         | Zentrale Redaction, Tests dafür; Request-URLs ohne Query-String (Suchbegriffe, ADR-0006)                                                                                |
| Datenabfluss über Push         | Inhaltsfreie Payloads (siehe [push.md](push.md))                                                                                                                        |

## HTML-Mails

Umgesetzt in Roadmap 2.9. Drei unabhängige Schichten, jede für sich soll Script-Ausführung und ungewolltes Nachladen verhindern:

1. **Sanitizing auf dem Server** (`apps/api/src/mail/html-sanitizer.ts`, sanitize-html): strikte Tag-/Attribut-Allowlist (kein `script`, `iframe`, `object`/`embed`, Formulare, `meta`/`base`/`link`, `svg`/`math`, keine Event-Handler). Links nur `http(s)`/`mailto`, immer `target="_blank" rel="noopener noreferrer nofollow"`. CSS (`style`-Attribute und `<style>`-Blöcke) wird nach dem Dekodieren von Escapes gefiltert: `@import`, `expression()`, `image-set()` u. ä. entfernt, `url()` über dieselbe URL-Policy wie Bilder.
2. **Remote-Content opt-in:** Bilder/Hintergründe aus dem Netz werden standardmäßig entfernt (`remoteContentBlocked: true`); erst nach Klick auf „Laden" (pro Nachricht, `?remote=1`) bleiben absolute `http(s)`-Bild-URLs erhalten. Inline-Bilder (`cid:`) werden als `data:`-URL eingebettet (nur Rasterformate, kein SVG, größenbegrenzt). Relative URLs werden nie geladen.
3. **Sandboxed iframe + CSP im Client:** Darstellung per `srcdoc` mit `sandbox="allow-popups allow-popups-to-escape-sandbox"` (ohne `allow-scripts`, ohne `allow-same-origin` → opaker Origin) und CSP `default-src 'none'; img-src data: [http: https:]; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'`, kein Referrer.

Da der Parent ohne Scripts/Same-Origin die Höhe des iframes nicht messen kann (und Mail-HTML nicht zum Messen ins App-DOM gerendert wird), hat der Rahmen eine feste, vom Nutzer veränderbare Höhe und scrollt intern. `position: fixed` u. ä. bleibt erlaubt, wirkt aber nur innerhalb des iframes. Die API liefert `Cache-Control: no-store` und loggt keine Inhalte.

## Offline-Cache im Client

Umgesetzt in Roadmap 4.6. Damit gelesene Mails offline sichtbar bleiben, legt die PWA Daten auf dem Gerät ab. Regeln:

- **Ablage nur in IndexedDB** (`apps/web/app/utils/offline-store.ts`), nie im Cache Storage des Service Workers: `/api/*` bleibt im Service Worker network-only.
- **Inhalt:** Kontoliste, Ordner, die ersten Listenseiten je Ordner (bis 150 Nachrichten), vom Benutzer geöffnete Nachrichten (Text), Unterhaltungen, sanitisiertes HTML **ohne** Remote-Content (mit `?remote=1` geladenes HTML wird nie gespeichert), Identitäten, die Entwurfsliste und die Offline-Queue (inkl. offline geschriebener Nachrichten und offline gespeicherter Entwürfe). Keine Anhänge, keine Zugangsdaten.
- **Verschlüsselt:** Jeder Eintrag ist mit AES-256-GCM verschlüsselt (eigener IV, Eintragsschlüssel als AAD). Der Schlüssel ist ein **nicht exportierbarer** WebCrypto-Key, der auf dem Gerät erzeugt und in derselben Datenbank abgelegt wird. Skripte können ihn benutzen, aber nie auslesen.
- **Grenzen dieser Verschlüsselung (bewusst einfach gehalten):** Der Key liegt im Browserprofil neben den Daten. Gegen jemanden, der das entsperrte Gerät oder das Browserprofil samt Browser nutzt, oder gegen XSS in der App schützt sie nicht – dafür sind Geräte-Sperre/Festplattenverschlüsselung des Betriebssystems und die CSP zuständig. Sie sorgt dafür, dass Inhalte nicht als Klartext in Profil-Kopien oder Datenträger-Resten liegen und dass **Löschen des Keys** alles Übrige unlesbar macht (Crypto-Shredding), auch wenn der Browser die Datenbank verzögert löscht. Ein vom Server abgeleiteter Schlüssel kam nicht infrage, weil der Cache gerade dann lesbar sein muss, wenn der Server nicht erreichbar ist.
- **Löschen:** Abmelden, eine abgelaufene oder widerrufene Sitzung (jede `401`-Antwort, auch beim Nachreichen der Queue) und eine Anmeldung mit anderem Benutzer löschen Key, Cache und Queue des Geräts vollständig. Danach sind bis zur nächsten Anmeldung keine Zugriffe auf die Datenbank mehr möglich, so dass verspätete Antworten den Cache nicht neu anlegen. Ein gelöschtes Konto entfernt seine Einträge beim nächsten Laden der Kontoliste.
- **Widerruf eines Geräts**, das offline bleibt: Der Cache bleibt bis zur nächsten Verbindung lesbar (der Server kann ein Gerät nicht aus der Ferne löschen). Ausstehende Aktionen werden in diesem Fall verworfen; die App meldet das bei der neuen Anmeldung.
- **Größe:** höchstens ca. 50 MB bzw. 3000 Einträge, Einträge über 5 MB werden nicht gespeichert; verdrängt wird nach LRU (`selectEvictions` in `@fma/shared`). Kontoliste, Ordner, Identitäten, Sitzungsmarke und Queue werden nie verdrängt.
- Ohne IndexedDB oder WebCrypto (privates Fenster, Instanz per `http://` unter einer LAN-Adresse) arbeitet die App ohne Offline-Ablage.

## Backups

- Backups werden **verschlüsselt**.
- Wiederherstellung wird **regelmäßig getestet** (automatisierter Restore-Test in CI, Phase 6).
- Restore auf einer frischen Installation muss mit dokumentierten Schritten funktionieren.

## Offene Punkte

- Bedrohungsmodell ausarbeiten → `docs/architecture/threat-model.md` (Phase 0, Aufgabe 0.3).
