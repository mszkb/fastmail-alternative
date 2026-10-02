# Architekturüberblick

> Status: Vorschlag. Offene Entscheidungen sind als ADR in [`../adr/`](../adr/README.md) erfasst.

## Komponenten

```
┌──────────────────────────┐        ┌─────────────────────────────────────────────┐
│  PWA (Nuxt/Vue)          │ HTTPS  │  API (Fastify oder .NET)                    │
│  - Service Worker        │◄──────►│  - Auth, Sessions, Geräte                   │
│  - IndexedDB UI-Cache    │        │  - Konten, Ordner, Nachrichten, Threads     │
│  - Offline-Queue (opt.)  │        │  - Push-Subscriptions                       │
└──────────▲───────────────┘        └───────┬───────────────────────┬─────────────┘
           │ Web Push                       │                       │ Jobs
           │                        ┌───────▼────────┐      ┌───────▼──────────────┐
┌──────────┴───────────────┐        │  PostgreSQL    │      │  Queue               │
│ Push-Service (Apple,     │        │  Metadaten,    │      │  Redis/Valkey oder   │
│ Google, Mozilla)         │        │  Jobs, Subs    │      │  Postgres-basiert    │
└──────────▲───────────────┘        └───────▲────────┘      └───────┬──────────────┘
           │                                │                       │
           │                        ┌───────┴───────────────────────▼─────────────┐
           └────────────────────────┤  Worker                                     │
                                    │  - IMAP-Sync (pro Konto isoliert)           │
                                    │  - SMTP-Versand                             │
                                    │  - Indexierung                              │
                                    │  - Cleanup                                  │
                                    └───────┬─────────────────────┬───────────────┘
                                            │ IMAP/SMTP           │
                                    ┌───────▼────────┐    ┌───────▼────────────────┐
                                    │ Externe        │    │ S3-kompatibler Storage │
                                    │ Mailanbieter   │    │ (optional: Anhänge,    │
                                    └────────────────┘    │  Mail-Cache)           │
                                                          └────────────────────────┘
```

| Komponente | Verantwortung |
| --- | --- |
| **Frontend** | Nuxt/Vue als responsive PWA, Service Worker, IndexedDB für UI-Cache, optional lokale Offline-Queue |
| **API** | REST/JSON (ggf. später SSE/WebSocket für Live-Updates). Keine IMAP-Verbindungen direkt aus Requests – alles Langlaufende geht über Jobs |
| **PostgreSQL** | Benutzer, Geräte, Konten (verschlüsselte Credentials), Ordner, Nachrichtenmetadaten, Threads, Jobs, Push-Subscriptions |
| **Object Storage** | S3-kompatibel, optional für Anhänge und serverseitigen Mail-Cache (abhängig vom Cache-Modus, ADR-0001) |
| **Worker** | Getrennte Prozesse für IMAP-Sync, SMTP-Versand, Indexierung, Cleanup. Horizontal skalierbar |
| **Queue** | Redis/Valkey oder PostgreSQL-basiert (ADR-0003) |

## Kernabläufe

### Neue Mail

1. IMAP-Sync-Worker erkennt neue Nachricht (IDLE oder Polling).
2. Metadaten werden in PostgreSQL geschrieben; je nach Cache-Modus auch Body/Anhänge.
3. Worker erzeugt Push-Job → Web Push mit inhaltsfreiem Payload (siehe [push.md](push.md)).
4. Offene Clients werden live informiert; geschlossene Clients synchronisieren beim nächsten Start/Fokus.

### Aktion (z. B. Archivieren)

1. Client aktualisiert UI optimistisch und sendet Aktion an API (bzw. Offline-Queue).
2. API persistiert Absicht und erzeugt Job.
3. Worker führt IMAP-Kommando aus; bei Fehler wird der Zustand zurückgesetzt und der Client informiert.

## Fehlerisolierung

- Jedes Konto hat eigenen Sync-Zustand, eigene Fehlerzähler und Backoff.
- Circuit Breaker pro Konto/Provider; ein ausgefallener Provider blockiert keine Worker-Slots anderer Konten.
- Kontostatus (ok / Auth-Fehler / Provider nicht erreichbar) ist in der UI sichtbar.

## Mail-Cache-Modi

Siehe ADR-0001. Kurz:

| Modus | Server speichert | Vorteil | Nachteil |
| --- | --- | --- | --- |
| **Proxy** | nur Metadaten | minimal Daten auf Server | Suche/Offline eingeschränkt, langsamer |
| **Index** | Metadaten + Suchindex | Volltextsuche | Index enthält Inhaltsfragmente |
| **Cache** | Metadaten + Bodies/Anhänge | schnell, offline-fähig | meiste Daten auf Server |

## Deployment

- Docker Compose für Einzelserver (ADR-0007): `web`, `api`, `worker`, `postgres`, `queue`, optional `minio`.
- Healthchecks für alle Services; Migrationen beim API-Start.
- Spätere Container-Orchestrierung (Kubernetes) optional.

## Observability

- Strukturierte JSON-Logs mit zentraler Redaction (Passwörter, Tokens, Betreff, Adressen je nach Log-Level).
- Metriken (Sync-Latenz, Fehlerraten pro Konto, Queue-Länge, Push-Erfolgsrate).
- Traces über API → Queue → Worker.
- Admin-Diagnoseseite mit Konto- und Worker-Status.
