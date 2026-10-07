# ADR-0014: Styling mit Tailwind CSS und daisyUI, Icons von Tabler

- **Status:** Accepted (Entscheidung des Owners in #120)
- **Datum:** 2026-10-07
- **Roadmap:** Epic #111 (#120, Vorgriff auf #112)

## Kontext

Die PWA hatte nur komponentenlokale Styles mit fest codierten Farben, keinen Dunkelmodus und keine Icon-Bibliothek. Der App-Rahmen aus #120 (Kontoleiste, Kopfzeile, Profil-Menü) braucht Icons, ein helles und ein dunkles Erscheinungsbild und einheitliche Farben. Leitplanke aus Epic #111: Bedienmuster übernehmen, aber keine Markenelemente (Logos, Icons, Farben) anderer Produkte.

## Optionen

1. **Eigene CSS-Variablen, eigene SVG-Icons** – keine Abhängigkeit, aber Themes, Komponenten und Icons komplett selbst pflegen.
2. **Tailwind CSS + daisyUI, Tabler Icons** – Utility-CSS und fertige, themefähige Komponenten (MIT), großes freies Icon-Set (MIT, tree-shakeable); alles nur Build-Zeit bzw. als statisches CSS/JS ausgeliefert.
3. **Komponentenbibliothek mit eigenem JS (z. B. Vuetify)** – deutlich größer, eigenes Komponentenmodell, schwerer an bestehende Komponenten anzupassen.

## Entscheidung

Option 2, für die ganze App: Tailwind CSS v4 (über `@tailwindcss/vite`) mit daisyUI v5 und zwei eigenen Themes (`fma-light` Standard, `fma-dark` bei `prefers-color-scheme: dark`) in `apps/web/app/assets/css/main.css`. Bestehende Komponenten behalten ihre Styles, nutzen aber nur noch die Theme-Variablen (`--color-base-*`, `--color-primary`, … und wenige App-Token `--fma-*`); neue Komponenten nutzen daisyUI/Tailwind direkt. Icons kommen aus `@tabler/icons-vue` (benannte Imports, nur genutzte Icons im Bundle). Eigene Farben, Kontrast WCAG AA (Kontofarben per Unit-Test geprüft).

## Konsequenzen

- Dunkelmodus für die ganze App; Farben zentral änderbar (Design-Tokens werden mit #112 verfeinert).
- Neue Abhängigkeiten: `tailwindcss`, `@tailwindcss/vite`, `daisyui` (Dev, MIT), `@tabler/icons-vue` (MIT). CSS-Bundle ca. 17 KB gzip.
- CSP unverändert (`style-src 'self'`; das CSS ist eine statische Datei).
- HTML-Mails im Lesebereich bleiben hell (eigenes Dokument im Sandbox-iframe), weil ihre Farben vom Absender stammen.
- Native Clients (ADR-0010) übernehmen nur die Farbwerte der Themes, nicht die Technik.
