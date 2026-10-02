# ADR-0007: Deployment

- **Status:** Accepted
- **Datum:** 2026-10-02
- **Roadmap:** 0.2, 1.3, 7.2

## Kontext

Self-hosted first: Die Installation muss für technikaffine Einzelpersonen nachvollziehbar sein. iOS-Web-Push und Service Worker brauchen HTTPS mit gültigem Zertifikat.

## Optionen

1. **Docker Compose** mit getrennten Containern.
2. **All-in-one-Image**: einfachster Start, aber schlechter skalierbar.
3. **Kubernetes/Helm**: für das MVP überdimensioniert.

TLS:

- a. **Caddy im Compose**: automatische Let's-Encrypt-Zertifikate.
- b. Ein eigener Reverse Proxy des Betreibers.

## Entscheidung

**Docker Compose mit Caddy** auf einer eigenen Domain:

| Service    | Aufgabe                                                |
| ---------- | ------------------------------------------------------ |
| `caddy`    | TLS (Let's Encrypt), Reverse Proxy für `web` und `api` |
| `web`      | Nuxt-PWA                                               |
| `api`      | Fastify-API, führt beim Start Migrationen aus          |
| `worker`   | IMAP-Sync, SMTP-Versand, Push, Cleanup                 |
| `postgres` | Datenbank und Job-Queue                                |

Volumes: `postgres-data`, `mail-data` (verschlüsselte Bodies und Anhänge), `caddy-data`.

Konfiguration über **`.env`**: `DOMAIN`, `MASTER_KEY`, VAPID-Keys, OAuth-Client-IDs und -Secrets (ADR-0011). Ein Hilfsbefehl generiert `MASTER_KEY` und VAPID-Keys beim ersten Setup.

Betreiber mit eigenem Reverse Proxy können `caddy` per Compose-Profil weglassen. Das ist dokumentiert, aber nicht der Standardweg.

## Konsequenzen

- Healthchecks, automatische Migrationen, `.env.example` und multi-arch Release-Images sind Pflicht.
- **Der `MASTER_KEY` aus `.env` muss getrennt vom Backup gesichert werden.** Geht er verloren, sind alle Mails und Zugangsdaten unlesbar. Darauf weisen Setup und Doku deutlich hin.
- Es gibt keinen Redis- und keinen MinIO-Container.
