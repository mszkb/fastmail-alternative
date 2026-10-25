## Was und warum

<!-- Kurze Beschreibung; verlinkte Issues mit "Refs #N" bzw. "Closes #N". -->

## Checkliste ([Definition of Done](../docs/process/definition-of-done.md))

- [ ] Lint, Format, Typecheck, Tests und Build grün
- [ ] Tests für neue Logik/Endpunkte (inkl. Fehlerpfade)
- [ ] Keine Zugangsdaten oder Mailinhalte in Logs, Fehlermeldungen oder Push-Payloads
- [ ] Doku und `ROADMAP.md` aktualisiert
- [ ] Funktion geändert: `docs/product/features.yaml` für Web **und** App nachgezogen (`pnpm features`), gemeinsame Logik unter `logic` auf beiden Seiten angepasst – oder keine Funktionsänderung
- [ ] `CHANGELOG.md` unter `[Unreleased]` ergänzt (Migrationen/Breaking Changes für Betreiber markiert) – oder nicht nutzerrelevant
