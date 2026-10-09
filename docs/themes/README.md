# Eigene Themes erstellen

Ein Theme passt Farben, Abstände, Schriftgrößen und die Anordnung der Oberfläche an (#126). Es ist **eine JSON-Datei** (`<id>.fmatheme.json`) ohne Code: Erlaubt sind nur Werte, die das [Schema](schema.json) kennt. Skripte, freies CSS, `url()`, Schriften oder Bilder von außen gibt es nicht – so kann ein Theme weder Code ausführen noch Daten abfließen lassen oder Aufrufe verfolgen.

Installiert wird ein Theme unter **Einstellungen → Darstellung → Theme installieren**. Der Server prüft die Datei und speichert sie für den Benutzer; die App hält sie zusätzlich offline vor. Welches Theme aktiv ist, gilt pro Gerät. Zurück zum Standard geht immer über „Standard“ in den Einstellungen oder, falls ein Theme die Oberfläche unbrauchbar macht, über die Adresse mit `?theme=default` (z. B. `https://mail.example.org/?theme=default`).

## Aufbau

```json
{
  "format": 1,
  "id": "mein-theme",
  "name": "Mein Theme",
  "version": "1.0.0",
  "author": "Name",
  "license": "ISC",
  "minAppVersion": "0.1.0",
  "description": "Kurzbeschreibung (optional)",
  "colors": {
    "light": { "primary": "#1f5fa8", "base-200": "#f2f5f9" },
    "dark": { "primary": "#8ab4f0", "primary-content": "#0b1a2e" }
  },
  "sizes": { "radius": "1rem", "text-md": "0.875rem" },
  "layout": { "readingPane": "off", "density": "compact", "accountRail": "icons" }
}
```

| Feld                                       | Inhalt                                                                                                                                                                                                                                                                            |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `format`                                   | immer `1`                                                                                                                                                                                                                                                                         |
| `id`                                       | Kleinbuchstaben, Ziffern, Bindestriche (max. 48). Eine Datei mit derselben `id` ersetzt das installierte Theme (Update).                                                                                                                                                          |
| `name`, `author`, `license`, `description` | Text ohne `<`, `>`, `{`, `}`, `\` (Name max. 60, Beschreibung max. 300 Zeichen)                                                                                                                                                                                                   |
| `version`, `minAppVersion`                 | Version wie `1.0.0`                                                                                                                                                                                                                                                               |
| `colors.light`, `colors.dark`              | Farben als `#rrggbb` (Kleinbuchstaben) für `base-100`, `base-200`, `base-300`, `base-content`, `primary`, `secondary`, `accent`, `neutral`, `info`, `success`, `warning`, `error` und je `…-content` (Textfarbe auf dieser Farbe). Nicht gesetzte Farben bleiben wie im Standard. |
| `sizes`                                    | `space-1` … `space-5`, `radius`, `radius-box`, `text-xs` … `text-lg` in `rem`; die erlaubten Bereiche stehen im Schema                                                                                                                                                            |
| `layout.readingPane`                       | `right`, `bottom` oder `off` – wird beim Aktivieren als Lesebereich übernommen                                                                                                                                                                                                    |
| `layout.density`                           | `normal` oder `compact`                                                                                                                                                                                                                                                           |
| `layout.accountRail`                       | `icons` (nur Symbole) oder `list` (mit Namen)                                                                                                                                                                                                                                     |

Die Layout-Optionen werden beim Aktivieren einmal als Einstellungen dieses Geräts übernommen; danach lassen sie sich wie gewohnt ändern.

## Prüfungen

- Unbekannte Felder, falsche Werte und Dateien über 32 KB werden abgelehnt; die Fehlermeldung nennt das Feld.
- **Kontrast:** Text auf Hintergrund (`base-content` auf `base-100/200/300`, jedes `…-content` auf seiner Farbe, `primary` auf `base-100`) muss in hell und dunkel mindestens 4.5:1 erreichen (WCAG AA). Fehlt eine Farbe, zählt die des Standard-Themes. Ein Theme mit zu wenig Kontrast wird abgelehnt.
- Höchstens 20 installierte Themes pro Benutzer.

Selbst prüfen: Die Datei in den Einstellungen installieren – die Fehlermeldung zeigt alle Probleme auf einmal. Editoren mit JSON-Schema-Unterstützung (z. B. VS Code über `json.schemas` mit dem Muster `*.fmatheme.json`) prüfen schon beim Schreiben; ein Feld `$schema` in der Datei selbst ist nicht erlaubt.

## Umsteiger-Themes

Im Ordner [`themes/`](../../themes/README.md) liegen drei Vorlagen als eigenes Paket: „Kompakt (wie Gmail)“, „Klassisch (wie Outlook)“ und „Übersichtlich (wie Fastmail)“. Sie übernehmen Anordnung und Dichte, nicht Logos, Symbole, Markenschriften oder Markenfarben, und stehen in keiner Verbindung zu den genannten Marken.
