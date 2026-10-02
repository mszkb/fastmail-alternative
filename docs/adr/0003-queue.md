# ADR-0003: Job-Queue

- **Status:** Accepted
- **Datum:** 2026-10-02
- **Roadmap:** 0.2, 2.2, 2.7

## Kontext

Die Worker für IMAP-Sync, SMTP-Versand, Cleanup und Push brauchen eine zuverlässige Queue mit Retries, Backoff und Fehlerisolierung pro Konto.

## Optionen

1. **PostgreSQL-basiert mit eigener Tabelle**: kein zusätzlicher Service, transaktional mit den übrigen Daten.
2. **PostgreSQL-Bibliothek** (pg-boss, graphile-worker): fertige Features, aber ein eigenes Schema mit mehreren Tabellen.
3. **Redis/Valkey** (BullMQ): höherer Durchsatz, aber ein zusätzlicher Service und ein zusätzliches Backup-Thema.

## Entscheidung

**Eine eigene, einfache `job`-Tabelle in PostgreSQL.** Worker holen Jobs mit `SELECT … FOR UPDATE SKIP LOCKED`; Retries laufen über `run_at` und `attempts`. Der Zugriff liegt hinter einer kleinen Abstraktion, damit Redis/Valkey später möglich bleibt. Schema: [`../architecture/data-model.md`](../architecture/data-model.md).

Begründung: so einfach wie möglich (Entscheidung Produktowner, 2026-10-02).

## Konsequenzen

- Lang laufende IMAP-IDLE-Verbindungen sind keine Queue-Jobs, sondern vom Worker verwaltete Verbindungen. Nur Ereignisse daraus werden zu Jobs.
- Retry, Backoff und das Aufräumen alter Jobs müssen selbst implementiert werden (überschaubar, siehe 5.5).
- Job-Payloads enthalten nur IDs; Fehlertexte werden vor dem Speichern redacted.
