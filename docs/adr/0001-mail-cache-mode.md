# ADR-0001: Mail-Cache-Modus

- **Status:** Accepted
- **Datum:** 2026-10-02
- **Roadmap:** 0.2, 2.2, 5.4

## Kontext

Wie viel Mailinhalt speichert der Server? Das bestimmt Geschwindigkeit, Offline-Fähigkeit, Suchqualität, Speicherbedarf und Datenschutz.

## Optionen

1. **Proxy**: Der Server speichert nur Metadaten; Bodies werden on demand vom IMAP-Server geladen.
2. **Index**: Metadaten und ein Volltextindex; Bodies on demand.
3. **Cache**: Metadaten, Bodies und Anhänge liegen vollständig auf dem Server.
4. **Konfigurierbar**: alle Modi als Instanz-Einstellung.

## Entscheidung

**Nur Cache-Modus: Der Server speichert alle Mails vollständig, also Texte und Anhänge, verschlüsselt.** (Entscheidung Produktowner, 2026-10-02: „Server soll Mails speichern, ist ja der Sinn am Self-hosted.")

- Bodies und Anhänge werden beim Sync geladen und verschlüsselt im **lokalen Docker-Volume** abgelegt (siehe ADR-0007, [`../architecture/data-model.md`](../architecture/data-model.md)).
- Wie weit die Historie beim ersten Sync zurückreicht, ist **pro Konto einstellbar** (z. B. 3 Monate, 1 Jahr, alles). Synchronisiert wird von neu nach alt.
- Es gibt keine weiteren Modi, keinen Moduswechsel und keinen Reindex-Pfad.

## Konsequenzen

- Der Server ist unabhängig vom Provider schnell, und die Clients können offline-first arbeiten, weil der Server die vollständige Quelle ist.
- Der Speicherbedarf entspricht ungefähr der Größe aller synchronisierten Postfächer. Betreiber-Doku und Statusseite müssen ihn sichtbar machen.
- Backups umfassen Datenbank **und** Volume. Ohne Master-Key sind beide unlesbar.
- Cleanup (5.5) betrifft nur verwaiste Dateien, nicht die Eviction.
