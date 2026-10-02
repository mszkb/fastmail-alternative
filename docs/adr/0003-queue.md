# ADR-0003: Job-Queue

- **Status:** Proposed
- **Datum:** 2026-10-02
- **Roadmap:** 0.2, 2.2, 2.7

## Kontext

Worker für IMAP-Sync, SMTP-Versand, Indexierung, Cleanup und Push brauchen eine zuverlässige Queue mit Retries, Backoff und Fehlerisolierung pro Konto.

## Optionen

1. **PostgreSQL-basiert** (z. B. pg-boss / graphile-worker bzw. Hangfire/Quartz bei .NET) – ein Service weniger, transaktional mit Daten, ausreichend für Einzelserver.
2. **Redis/Valkey** (z. B. BullMQ) – höherer Durchsatz, Pub/Sub für Live-Updates, aber zusätzlicher Service und Backup-Thema.

## Entscheidung

Offen. Vorschlag: **PostgreSQL-basiert für das MVP**, Queue-Zugriff hinter einer Abstraktion, damit Redis/Valkey später möglich bleibt.

## Konsequenzen

- Lang laufende IMAP-IDLE-Verbindungen sind keine Queue-Jobs, sondern vom Worker verwaltete Verbindungen; nur Ereignisse daraus werden zu Jobs.
