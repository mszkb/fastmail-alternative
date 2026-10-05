# Externe Abhängigkeiten

Aufgaben mit 🔗 in der [`ROADMAP.md`](../../ROADMAP.md) hängen von Dritten ab. Diese Abhängigkeiten sind schwer planbar und brauchen Puffer.

| Abhängigkeit                            | Betroffene Aufgaben          | Risiko                                                                                                                                | Gegenmaßnahme                                                                                                 |
| --------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Apple Web Push (iOS-PWA)**            | 4.2, 4.3, 4.4                | Nur für installierte PWAs, Verhalten ändert sich mit iOS-Versionen, eingeschränkte Badging-Unterstützung                              | Sync bei Start/Fokus als Fallback; Testmatrix mit echten Geräten                                              |
| **Browser-Push-Dienste (FCM, Mozilla)** | 4.3                          | Rate Limits, Endpoint-Ablauf                                                                                                          | Endpoint-Cleanup, Retry mit Backoff                                                                           |
| **OAuth-Provider (Google, Microsoft)**  | 6.3                          | App-Verifizierung (Google: restricted scopes für Gmail), Client-Registrierung je Instanz nötig                                        | Doku für Self-Hoster zum Anlegen eigener OAuth-Clients; App-Passwörter als Fallback                           |
| **Mailserver-Kompatibilität**           | 0.5, 2.2, 3.3                | Unterschiedliche IMAP-Extensions (IDLE, CONDSTORE, QRESYNC, MOVE, SPECIAL-USE), Gmail-Labels, Exchange-Eigenheiten, Verbindungslimits | Kompatibilitätsmatrix, Feature-Detection, Integrationstests gegen mehrere Server                              |
| **Apple Developer Program / APNs**      | Ausblick native iOS-App, 8.1 | Kosten, Review, Zertifikate nicht self-hostbar                                                                                        | Hosted Push Relay                                                                                             |
| **Telemetrie-Collector (Projekt)**      | 7.10                         | Hosting und Domain nötig; Ausfall darf Instanzen nicht beeinträchtigen                                                                | Opt-in, `TELEMETRY_URL` konfigurierbar, ohne Collector folgenlos ([ADR-0012](../adr/0012-usage-telemetry.md)) |
| **S3-kompatibler Storage**              | 5.4                          | API-Unterschiede zwischen Anbietern                                                                                                   | Nur Kern-S3-API nutzen, gegen MinIO testen                                                                    |

## Unterstützte Mailanbieter

Liste, Zugangsdaten und Kompatibilitätsmatrix (IDLE, CONDSTORE, QRESYNC, MOVE, SPECIAL-USE): [Mailanbieter und Kompatibilität](../product/mail-providers.md).
