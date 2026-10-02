# ADR-0006: Suche

- **Status:** Accepted
- **Datum:** 2026-10-02
- **Roadmap:** 0.2, 5.1, 5.2

## Kontext

Suche nach Absender, Betreff, Text und Datum. Betreff, Adressen und Bodies liegen verschlüsselt auf dem Server (siehe [`../architecture/data-model.md`](../architecture/data-model.md#verschlüsselung)). Ein Klartext-Index würde diese Verschlüsselung unterlaufen.

## Optionen

1. **PostgreSQL Full-Text Search**: kein zusätzlicher Service, braucht aber Klartext in der DB.
2. **Meilisearch / Typesense**: sehr gute Relevanz, aber ein zusätzlicher Service, ebenfalls mit Klartext-Index.
3. **IMAP `SEARCH` beim Provider**: kein Index nötig, aber langsamer und je nach Provider uneinheitlich.

## Entscheidung

**IMAP `SEARCH` beim Provider im MVP**, pro Konto, hinter einer Such-Schnittstelle. Es gibt keinen eigenen Index.

Ein eigener Index wird erst erwogen, wenn IMAP `SEARCH` in der Praxis nicht reicht, und muss dann mit verschlüsselten Inhalten verträglich sein (z. B. ein verschlüsselter Index oder eine Suche über den Offline-Cache auf dem Gerät).

## Konsequenzen

- Im MVP gibt es keinen Indexierungs-Worker und keinen zusätzlichen Speicher.
- Suchqualität und -geschwindigkeit hängen vom Provider ab. Die Unterschiede werden in der Kompatibilitätsmatrix (0.5) erfasst.
- Die Suche funktioniert nur online und jeweils in einem Konto. Das passt zu den getrennten Konten.
