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

Offen. Vorschlag: **PostgreSQL-basiert für das MVP, als eine eigene, einfache `job`-Tabelle** (Abholung per `SELECT … FOR UPDATE SKIP LOCKED`, Retry mit `run_at`/`attempts`), keine Queue-Bibliothek mit eigenem Schema. Queue-Zugriff hinter einer kleinen Abstraktion, damit Redis/Valkey später möglich bleibt. Schema: [`../architecture/data-model.md`](../architecture/data-model.md).

Begründung: so einfach wie möglich (Entscheidung Produktowner, 2026-10-02) – kein zusätzlicher Service, keine fremden Tabellen, transaktional mit den übrigen Daten.

## Konsequenzen

- Retry, Backoff und Aufräumen alter Jobs müssen selbst implementiert werden (überschaubar, siehe 5.5).
- Job-Payloads enthalten nur IDs; Fehlertexte werden vor dem Speichern redacted.

- Lang laufende IMAP-IDLE-Verbindungen sind keine Queue-Jobs, sondern vom Worker verwaltete Verbindungen; nur Ereignisse daraus werden zu Jobs.
