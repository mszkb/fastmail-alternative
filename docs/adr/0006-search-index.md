# ADR-0006: Suchindex

- **Status:** Proposed
- **Datum:** 2026-10-02
- **Roadmap:** 0.2, 5.1, 5.2

## Kontext

Metadaten- und Volltextsuche über alle Konten. Abhängig vom Cache-Modus (ADR-0001).

## Optionen

1. **PostgreSQL Full-Text Search** (`tsvector`, ggf. `pg_trgm`) – kein zusätzlicher Service.
2. **Meilisearch / Typesense** – sehr gute Relevanz und Geschwindigkeit, zusätzlicher Service.
3. **IMAP `SEARCH` serverseitig beim Provider** – kein Index nötig, aber langsam und uneinheitlich.

## Entscheidung

Offen. Vorschlag: **PostgreSQL FTS für das MVP**, Suchzugriff hinter einer Schnittstelle; IMAP `SEARCH` als Fallback im Proxy-Modus.

## Konsequenzen

- Mehrsprachigkeit (Deutsch/Englisch) bei Stemming beachten.
- Index-Größe in Lasttests (6.6) messen.
