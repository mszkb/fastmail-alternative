# ADR-0002: Datenbank

- **Status:** Accepted
- **Datum:** 2026-10-02
- **Roadmap:** 0.2, 1.4

## Kontext

Persistenz für Benutzer, Geräte, Konten, Ordner, Nachrichtenmetadaten, Threads, Jobs und Push-Subscriptions. Die Datenbank muss einfach self-hostbar und backupbar sein.

## Optionen

1. **PostgreSQL**: robust, JSONB, `SKIP LOCKED` für Jobqueues, breites Tooling.
2. **SQLite**: minimaler Betrieb, aber schwach bei parallelen Workern.
3. **MySQL/MariaDB**: verbreitet, aber mit weniger passenden Features.

## Entscheidung

**PostgreSQL.** Bodies und Anhänge liegen **nicht** in der DB, sondern als verschlüsselte Dateien im Volume (ADR-0001), damit die DB klein und das Backup schnell bleibt.

Das Migrationstool folgt aus ADR-0008 (TypeScript). Es wird in Phase 1 (1.4) gewählt und muss reine SQL-Migrationen unterstützen.

## Konsequenzen

- PostgreSQL deckt zugleich die Queue ab (ADR-0003). Es gibt keinen weiteren Datendienst im Compose-Setup.
