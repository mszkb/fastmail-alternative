# ADR-0007: Deployment

- **Status:** Accepted
- **Datum:** 2026-10-02 (Ergänzung 2026-10-04: kein eigener `web`-Container)
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

| Service    | Aufgabe                                                                 |
| ---------- | ----------------------------------------------------------------------- |
| `caddy`    | TLS (Let's Encrypt), Reverse Proxy für `api`                            |
| `api`      | Fastify-API und Auslieferung der statischen PWA, Migrationen beim Start |
| `worker`   | IMAP-Sync, SMTP-Versand, Push, Cleanup                                  |
| `postgres` | Datenbank und Job-Queue                                                 |

Volumes: `postgres-data`, `mail-data` (verschlüsselte Bodies und Anhänge), `caddy-data`.

Konfiguration über **`.env`**: `DOMAIN`, `MASTER_KEY`, VAPID-Keys, OAuth-Client-IDs und -Secrets (ADR-0011). Ein Hilfsbefehl generiert `MASTER_KEY` und VAPID-Keys beim ersten Setup.

Betreiber mit eigenem Reverse Proxy können `caddy` per Compose-Profil weglassen und alles an `api:3001` weiterleiten. Das ist dokumentiert, aber nicht der Standardweg.

### Ergänzung 2026-10-04: Vier statt fünf Container

Ursprünglich lieferte ein eigener `web`-Container (nginx) die PWA aus. Die PWA ist rein statisch (`nuxt generate`, kein SSR), deshalb liefert jetzt die **API** sie mit aus (`apps/api/src/web-app.ts`). Das `api`-Image baut die PWA mit; Security-Header und CSP kommen weiterhin aus `apps/web/scripts/build-csp.mjs` (jetzt als JSON).

- **Gewonnen:** ein Container, ein Image und ein Build weniger. Der Reverse Proxy hat nur noch ein Ziel, ein eigener Proxy des Betreibers ebenso. Die Header gelten weiter unabhängig vom Proxy.
- **Nicht der Grund:** RAM. nginx brauchte im Leerlauf nur ~5 MB.
- **Kosten:** Statische Anfragen laufen durch Node und zählen zum globalen Rate Limit der API (600/min pro IP). Das reicht für den ersten Aufruf; danach kommt die App-Shell aus dem Service Worker.

**Bewusst getrennt bleiben `api` und `worker`:** Die API bindet `mail-data` nur lesend ein, und Speicherspitzen des Syncs (bis 384 MB) können die Oberfläche nicht per OOM mitreißen. Ein gemeinsamer Container würde nur eine Node-Runtime (~50–80 MB) sparen.

## Konsequenzen

- Healthchecks, automatische Migrationen, `.env.example` und multi-arch Release-Images sind Pflicht.
- **Der `MASTER_KEY` aus `.env` muss getrennt vom Backup gesichert werden.** Geht er verloren, sind alle Mails und Zugangsdaten unlesbar. Darauf weisen Setup und Doku deutlich hin.
- Es gibt keinen Redis- und keinen MinIO-Container.
