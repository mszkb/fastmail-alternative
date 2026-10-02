# ADR-0001: Mail-Cache-Modus

- **Status:** Proposed
- **Datum:** 2026-10-02
- **Roadmap:** 0.2, 5.4

## Kontext

Wie viel Mailinhalt speichert der Server? Das bestimmt Geschwindigkeit, Offline-Fähigkeit, Suchqualität, Speicherbedarf und Datenschutz. Die Roadmap verlangt einen explizit konfigurierbaren Modus.

## Optionen

1. **Proxy** – nur Metadaten (Header, Flags, Struktur); Bodies werden on demand vom IMAP-Server geladen. Minimaler Datenbestand, aber langsamer und Volltextsuche nur über IMAP `SEARCH`.
2. **Index** – Metadaten + Volltextindex; Bodies on demand. Gute Suche, Index enthält jedoch Inhaltsfragmente.
3. **Cache** – Metadaten + Bodies (+ optional Anhänge) in DB/S3. Schnellste UX, offline-freundlich, größter Datenbestand.

## Entscheidung

Offen. Vorschlag: alle drei Modi als Instanz-Einstellung, **Default „Index"**, Cache mit Größen-/Altersgrenzen. Das Datenmodell muss so gebaut sein, dass Bodies optional sind.

**Hinweis (2026-10-02):** Da lesbare Inhalte in der DB verschlüsselt werden und im MVP kein eigener Suchindex vorgesehen ist (ADR-0006), verliert der Modus „Index“ vorerst seinen Zweck. Der Default ist bei der Entscheidung (0.2) neu zu bewerten – naheliegend: **Proxy** als einfachster Startpunkt, **Cache** (verschlüsselt) für Offline/Geschwindigkeit.

## Konsequenzen

- Cleanup-Jobs (5.5) und Betreiber-Doku zu Datenschutzfolgen je Modus nötig.
- Modus-Wechsel braucht einen Migrations-/Reindex-Pfad.
