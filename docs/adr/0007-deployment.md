# ADR-0007: Deployment

- **Status:** Proposed
- **Datum:** 2026-10-02
- **Roadmap:** 0.2, 1.3, 7.2

## Kontext

Self-hosted first: Installation muss für technikaffine Einzelpersonen nachvollziehbar sein.

## Optionen

1. **Docker Compose** mit getrennten Containern (web, api, worker, postgres, optional queue/minio).
2. **All-in-one-Image** – einfachster Start, schlechter skalierbar.
3. **Kubernetes/Helm** – für größere Setups, für MVP überdimensioniert.

## Entscheidung

Vorschlag: **Docker Compose** als offizieller Weg; Helm-Chart optional nach Stable. Reverse Proxy/TLS wird dokumentiert (z. B. Caddy/Traefik), nicht erzwungen.

## Konsequenzen

- Healthchecks, automatische Migrationen, `.env.example`, multi-arch Release-Images.
- HTTPS ist Pflicht für Service Worker und Web Push → Doku muss TLS-Setup abdecken.
