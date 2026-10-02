# Architekturüberblick

> Status: entschieden, siehe ADRs in [`../adr/`](../adr/README.md).

## Komponenten

```
                         ┌───────────────────────────────────────────────────────────┐
 iPhone-PWA / Browser    │ Docker Compose                                            │
 (später: native Apps)   │                                                           │
┌──────────────────────┐ │ ┌────────┐   ┌──────────────┐   ┌──────────────────────┐ │
│ Nuxt-PWA             │ │ │        │──►│ web (Nuxt)   │   │ api (Fastify)        │ │
│ - Service Worker     │◄┼►│ caddy  │   └──────────────┘   │ - Auth, Geräte       │ │
│ - IndexedDB-Cache    │ │ │  TLS   │──────────────────────►│ - Konten, Ordner,    │ │
│ - Offline-Queue      │ │ │        │                       │   Nachrichten, Suche │ │
└──────────▲───────────┘ │ └────────┘                       └──────────┬───────────┘ │
           │ Web Push    │                                             │             │
┌──────────┴───────────┐ │ ┌──────────────────────┐  ┌───────────────▼───────────┐ │
│ Push-Dienst (Apple,  │ │ │ worker               │  │ postgres                  │ │
│ Google, Mozilla)     │◄┼─│ - IMAP-Sync (IDLE)   │◄►│ Metadaten (verschlüsselt),│ │
└──────────────────────┘ │ │ - SMTP-Versand       │  │ job-Tabelle, Sessions     │ │
                         │ │ - Push, Cleanup      │  └───────────────────────────┘ │
                         │ └───────┬──────────┬───┘  ┌───────────────────────────┐ │
                         │         │          └─────►│ Volume mail-data          │ │
                         │         │                 │ Mails + Anhänge (verschl.)│ │
                         │         │                 └───────────────────────────┘ │
                         └─────────┼─────────────────────────────────────────────────┘
                                   │ IMAP/SMTP (Passwort oder OAuth2)
                         ┌─────────▼──────────────────────────────┐
                         │ Gmail · Outlook · Fastmail · eigener   │
                         └────────────────────────────────────────┘
```

| Komponente | Verantwortung |
| --- | --- |
| **caddy** | TLS über Let's Encrypt, Reverse Proxy (ADR-0007) |
| **web** | Nuxt/Vue-PWA: Service Worker, IndexedDB-Cache, Offline-Queue. Dünner Client ohne eigene Geschäftslogik (ADR-0010) |
| **api** | Fastify, REST/JSON mit OpenAPI-Vertrag (später ggf. SSE für Live-Updates). Keine IMAP-Verbindungen direkt aus Requests: Alles Langlaufende läuft über Jobs. Ausnahme ist die Suche über IMAP `SEARCH` (ADR-0006). |
| **worker** | IMAP-Sync (IDLE-Verbindungen pro Konto), SMTP-Versand, Push, Cleanup |
| **postgres** | Benutzer, Geräte, Konten, Ordner, Nachrichtenmetadaten (lesbare Felder verschlüsselt), Threads, Jobs, Push-Subscriptions |
| **mail-data** | Docker-Volume mit allen Mails und Anhängen, verschlüsselt pro Konto (ADR-0001) |

## Kernabläufe

### Neue Mail

1. Der IMAP-Sync-Worker erkennt eine neue Nachricht (IDLE oder Polling).
2. Er schreibt die Metadaten verschlüsselt in PostgreSQL und legt Rohmail und Anhänge verschlüsselt im Volume ab.
3. Der Worker erzeugt einen Push-Job: Web Push mit inhaltsfreiem Payload (siehe [push.md](push.md)).
4. Offene Clients werden live informiert; geschlossene Clients synchronisieren beim nächsten Start oder Fokuswechsel.

### Aktion (z. B. Archivieren)

1. Der Client aktualisiert die UI optimistisch und sendet die Aktion an die API, offline zuerst in die Offline-Queue.
2. Die API persistiert die Absicht und erzeugt einen Job.
3. Der Worker führt das IMAP-Kommando aus. Bei einem Fehler wird der Zustand zurückgesetzt und der Client informiert.

## Fehlerisolierung

- Jedes Konto hat einen eigenen Sync-Zustand, eigene Fehlerzähler und eigenen Backoff.
- Circuit Breaker pro Konto/Provider: Ein ausgefallener Provider blockiert keine Worker-Slots anderer Konten.
- Ein abgelaufener OAuth-Token setzt nur dieses Konto auf `auth_error` (ADR-0011).
- Der Kontostatus (ok / Auth-Fehler / Provider nicht erreichbar) ist in der UI sichtbar.

## Deployment

- Docker Compose (ADR-0007): `caddy`, `web`, `api`, `worker`, `postgres`; Volumes `postgres-data`, `mail-data`, `caddy-data`.
- Konfiguration über `.env` (Domain, `MASTER_KEY`, VAPID, OAuth-Client-Daten).
- Healthchecks für alle Services; Migrationen laufen beim Start der API.

## Observability

- Strukturierte JSON-Logs mit zentraler Redaction (Passwörter, Tokens, Betreff, Adressen).
- Metriken: Sync-Latenz, Fehlerraten pro Konto, Länge der Job-Tabelle, Push-Erfolgsrate, Speicherverbrauch pro Konto.
- Diagnoseseite mit Konto- und Worker-Status.
