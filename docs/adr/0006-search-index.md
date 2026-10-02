# ADR-0006: Suchindex

- **Status:** Proposed
- **Datum:** 2026-10-02
- **Roadmap:** 0.2, 5.1, 5.2

## Kontext

Metadaten- und Volltextsuche. Abhängig vom Cache-Modus (ADR-0001).

**Neu (2026-10-02):** Betreff, Adressen, Snippet und Bodies werden in der DB verschlüsselt gespeichert (siehe [`../architecture/data-model.md`](../architecture/data-model.md#verschlüsselung)). Ein Klartext-Index in PostgreSQL oder einem Suchdienst würde diese Verschlüsselung unterlaufen.

## Optionen

1. **PostgreSQL Full-Text Search** (`tsvector`, ggf. `pg_trgm`) – kein zusätzlicher Service.
2. **Meilisearch / Typesense** – sehr gute Relevanz und Geschwindigkeit, zusätzlicher Service.
3. **IMAP `SEARCH` serverseitig beim Provider** – kein Index nötig, aber langsam und uneinheitlich.

## Entscheidung

Offen. Vorschlag: **IMAP `SEARCH` beim Provider für das MVP**, pro Konto, Suchzugriff hinter einer Schnittstelle. Kein eigener Index. Ein eigener Index (Option 1 oder 2) wird erst erwogen, wenn IMAP `SEARCH` in der Praxis nicht reicht, und muss dann mit verschlüsselten Inhalten verträglich sein.

## Konsequenzen

- Kein Indexierungs-Worker, kein zusätzlicher Speicher im MVP.
- Suchqualität und -geschwindigkeit hängen vom Provider ab; Unterschiede in der Kompatibilitätsmatrix (0.5) erfassen.
- Suche funktioniert nur online und nicht kontoübergreifend in einem Schritt (passt zu getrennten Konten).
