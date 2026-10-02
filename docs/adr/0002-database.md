# ADR-0002: Datenbank

- **Status:** Proposed
- **Datum:** 2026-10-02
- **Roadmap:** 0.2, 1.4

## Kontext

Persistenz für Benutzer, Geräte, Konten, Ordner, Nachrichtenmetadaten, Threads, Jobs und Push-Subscriptions. Muss einfach self-hostbar und backupbar sein.

## Optionen

1. **PostgreSQL** – robust, JSONB, Volltextsuche (`tsvector`), `SKIP LOCKED` für Jobqueues, breites Tooling.
2. **SQLite** – minimaler Betrieb, aber schwach bei parallelen Workern.
3. **MySQL/MariaDB** – verbreitet, aber weniger passende Features.

## Entscheidung

Vorschlag: **PostgreSQL** (wie in der Roadmap vorgesehen). Migrationstool hängt von ADR-0008 ab.

## Konsequenzen

- Postgres kann zugleich Queue (ADR-0003) und Suchindex (ADR-0006) abdecken → weniger Services im Compose-Setup.
