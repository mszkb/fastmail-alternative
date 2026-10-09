# Umsteiger-Themes

Zusatzpaket mit drei Themes für die Oberfläche (#126), getrennt vom Kern und mit eigener Version (Feld `version` je Datei):

| Datei                                       | Name                         | Anordnung                                                  |
| ------------------------------------------- | ---------------------------- | ---------------------------------------------------------- |
| `kompakt-wie-gmail.fmatheme.json`           | Kompakt (wie Gmail)          | ohne Lesebereich, kompakte Liste, Kontoleiste mit Symbolen |
| `klassisch-wie-outlook.fmatheme.json`       | Klassisch (wie Outlook)      | Lesebereich rechts, Kontoleiste mit Namen, kantige Formen  |
| `uebersichtlich-wie-fastmail.fmatheme.json` | Übersichtlich (wie Fastmail) | Lesebereich rechts, kompakte Liste, Kontoleiste mit Namen  |

Installation: Datei herunterladen, dann in der App **Einstellungen → Darstellung → Theme installieren**. Format und eigene Themes: [docs/themes](../docs/themes/README.md).

Die Themes übernehmen nur Bedienmuster, Anordnung und Dichte. Sie enthalten keine Logos, Symbole, Illustrationen, Markenschriften oder markenprägenden Farbschemata; die Farben sind eigene Paletten. Es besteht keine Verbindung zu Google, Microsoft oder Fastmail. Alle drei erreichen WCAG AA in hell und dunkel (geprüft in `packages/shared/test/themes.test.ts`).
