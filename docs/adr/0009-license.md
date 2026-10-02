# ADR-0009: Lizenz

- **Status:** Accepted
- **Datum:** 2026-10-02
- **Roadmap:** 0.1

## Kontext

Das Projekt braucht eine Lizenz, bevor Code entsteht. Die Wahl beeinflusst, wer den Code wie nutzen darf und ob spätere Paid Services (Phase 8: Hosted Push Relay, Managed Hosting) durch die Lizenz geschützt sind.

## Optionen

1. **AGPL-3.0** – Copyleft auch für Netzwerkdienste: Wer eine geänderte Version als Dienst anbietet, muss den Quellcode offenlegen. Schützt vor geschlossenen Konkurrenzangeboten, schreckt aber manche Nutzer und Beitragende ab und ist aufwendiger in der Einhaltung.
2. **MIT / Apache-2.0** – permissiv. Apache-2.0 zusätzlich mit expliziter Patentlizenz, aber längerer Text.
3. **ISC** – permissiv, funktional gleichwertig zu MIT, kürzester Lizenztext. Verbreitet im Node-Ökosystem (Default von `npm init`).

## Entscheidung

**ISC** (Entscheidung Produktowner, 2026-10-02).

Begründung: so einfach wie möglich – kurz, verständlich, keine Pflichten für Self-Hoster außer dem Copyright-Hinweis, kompatibel mit praktisch allen Abhängigkeiten.

## Konsequenzen

- Jeder darf den Code nutzen, ändern, weiterverkaufen und auch als geschlossenen Hosted-Dienst anbieten. Paid Services (Phase 8) sind **nicht** durch die Lizenz geschützt, sondern nur durch Komfort, Betrieb und Vertrauen. Das passt zum Prinzip „keine künstliche Paywall".
- Keine explizite Patentklausel (anders als Apache-2.0); für dieses Projekt akzeptiert.
- Abhängigkeiten mit starkem Copyleft (GPL/AGPL) sind nicht verboten, machen aber das Gesamtpaket für Weiterverteiler restriktiver; bei neuen Abhängigkeiten prüfen (siehe Definition of Done). Bevorzugt: MIT, ISC, BSD, Apache-2.0.
- `package.json`-Dateien (bzw. Projektdateien) tragen `"license": "ISC"`.
