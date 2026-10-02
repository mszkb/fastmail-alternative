# Externe Abhängigkeiten

Aufgaben mit 🔗 in der [`ROADMAP.md`](../../ROADMAP.md) hängen von Dritten ab. Diese Abhängigkeiten sind schwer planbar und brauchen Puffer.

| Abhängigkeit | Betroffene Aufgaben | Risiko | Gegenmaßnahme |
| --- | --- | --- | --- |
| **Apple Web Push (iOS-PWA)** | 4.2, 4.3, 4.4 | Nur für installierte PWAs, Verhalten ändert sich mit iOS-Versionen, eingeschränkte Badging-Unterstützung | Sync bei Start/Fokus als Fallback; Testmatrix mit echten Geräten |
| **Browser-Push-Dienste (FCM, Mozilla)** | 4.3 | Rate Limits, Endpoint-Ablauf | Endpoint-Cleanup, Retry mit Backoff |
| **OAuth-Provider (Google, Microsoft)** | 6.3 | App-Verifizierung (Google: restricted scopes für Gmail), Client-Registrierung je Instanz nötig | Doku für Self-Hoster zum Anlegen eigener OAuth-Clients; App-Passwörter als Fallback |
| **Mailserver-Kompatibilität** | 0.5, 2.2, 3.3 | Unterschiedliche IMAP-Extensions (IDLE, CONDSTORE, QRESYNC, MOVE, SPECIAL-USE), Gmail-Labels, Exchange-Eigenheiten, Verbindungslimits | Kompatibilitätsmatrix, Feature-Detection, Integrationstests gegen mehrere Server |
| **Apple Developer Program / APNs** | Ausblick native iOS-App, 8.1 | Kosten, Review, Zertifikate nicht self-hostbar | Hosted Push Relay |
| **S3-kompatibler Storage** | 5.4 | API-Unterschiede zwischen Anbietern | Nur Kern-S3-API nutzen, gegen MinIO testen |

## Unterstützte Mailanbieter (Entwurf, zu prüfen in Phase 0)

| Anbieter | IMAP/SMTP | Auth | Bemerkung |
| --- | --- | --- | --- |
| Generischer IMAP-Server (Dovecot, Cyrus) | ✓ | Passwort | Referenz für Tests |
| Fastmail | ✓ | App-Passwort | |
| Gmail / Google Workspace | ✓ | OAuth2 (XOAUTH2), App-Passwort | Labels ≠ Ordner |
| Microsoft 365 / Outlook.com | ✓ | OAuth2 (Basic Auth abgeschaltet) | OAuth Pflicht → frühestens Beta |
| iCloud Mail | ✓ | App-Passwort | |
| GMX / Web.de | ✓ | Passwort | IMAP muss ggf. aktiviert werden |
| Posteo / mailbox.org | ✓ | Passwort | |
