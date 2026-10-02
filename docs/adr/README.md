# Architecture Decision Records

Neue ADR: `0000-template.md` kopieren, fortlaufend nummerieren, Status zunächst „Proposed".

| ADR                                | Thema                                                         | Status   |
| ---------------------------------- | ------------------------------------------------------------- | -------- |
| [0001](0001-mail-cache-mode.md)    | Mail-Cache-Modus: Server speichert alles (verschlüsselt)      | Accepted |
| [0002](0002-database.md)           | Datenbank: PostgreSQL                                         | Accepted |
| [0003](0003-queue.md)              | Job-Queue: eigene Tabelle in PostgreSQL                       | Accepted |
| [0004](0004-auth.md)               | Authentifizierung: Single-User, Passwort, Sessions            | Accepted |
| [0005](0005-push.md)               | Push-Zustellung: direkter Web Push                            | Accepted |
| [0006](0006-search-index.md)       | Suche: IMAP `SEARCH`                                          | Accepted |
| [0007](0007-deployment.md)         | Deployment: Docker Compose mit Caddy                          | Accepted |
| [0008](0008-backend-framework.md)  | Backend: Fastify (TypeScript), Frontend Nuxt                  | Accepted |
| [0009](0009-license.md)            | Lizenz: ISC                                                   | Accepted |
| [0010](0010-client-strategy.md)    | Client-Strategie: native Clients, gemeinsame Logik und Design | Accepted |
| [0011](0011-mail-provider-auth.md) | Anmeldung an Mailanbietern: OAuth2 + Passwort im MVP          | Accepted |
