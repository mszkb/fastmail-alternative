# ADR-0010: Client-Strategie

- **Status:** Accepted
- **Datum:** 2026-10-02
- **Roadmap:** Phase 4, Ausblick

## Kontext

Zuerst werden das iPhone (PWA) und der Browser genutzt, später kommen Android und Desktop dazu. Vorgabe des Produktowners: **Ein universeller Client ist nicht nötig. Jede Plattform soll die beste native Einbindung bekommen. Logik und Design müssen aber überall gleich sein.**

## Optionen

1. **Ein universeller Client** (PWA überall, oder Capacitor/Tauri als Hülle): ein Code, aber nicht überall die beste native Einbindung.
2. **Native Clients pro Plattform** mit gemeinsamer Logik auf dem Server und einem gemeinsamen Design-System.

## Entscheidung

**Option 2**, schrittweise:

1. **MVP:** die Nuxt-PWA für iPhone (Home-Bildschirm, Web Push) und Browser.
2. **Später:** native Clients pro Plattform (iOS zuerst, dann Android und Desktop) in der jeweils besten Technologie.

Damit Logik und Design überall gleich bleiben:

- **Die Logik liegt auf dem Server.** Sync, Threading, Sanitizing, Ordner-Mapping und Fehlerbehandlung macht die API. Clients sind dünn: anzeigen, cachen, Aktionen senden.
- **Ein API-Vertrag (OpenAPI)** ist die einzige Quelle für alle Clients (ADR-0008).
- **Design-Tokens** (Farben, Typografie, Abstände, Icons) liegen plattformneutral im Repo (z. B. `packages/design-tokens`, JSON) und werden für CSS, Swift und Kotlin generiert.
- **Offline-first auf jedem Client:** lokaler Cache und Offline-Queue für Aktionen, die Wahrheit liegt beim Server. Die Regeln dafür werden einmal dokumentiert und pro Client gleich umgesetzt.

## Konsequenzen

- Die API muss von Anfang an vollständig und clientneutral sein. Keine Logik, die nur in der PWA lebt.
- Native Clients brauchen gerätegebundene Tokens (ADR-0004) und für iOS APNs (ADR-0005, Relay-Frage).
- Etwas mehr Aufwand bei der Pflege des Design-Systems, dafür ein einheitliches Erscheinungsbild.
