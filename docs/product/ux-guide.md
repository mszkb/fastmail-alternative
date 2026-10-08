# UX-Leitfaden: Bedienmuster und Design-Tokens

Ziel aus Epic #111: Wer von Fastmail kommt, findet sich sofort zurecht. Dafür übernehmen wir **Bedienmuster** – Aufbau, Abläufe, Tastenkürzel, Begriffe, Dichte –, aber **keine Markenelemente**.

## Leitplanke

- Übernommen werden Bedienmuster: Aufbau der Oberfläche, Abläufe, Tastenkürzel, Begriffe, Informationsdichte.
- Nicht übernommen werden Logos, Icons, Illustrationen, Screenshots, Texte, lizenzierte Schriften und das Farbschema als Erkennungszeichen.
- Der Name „Fastmail“ erscheint in der Oberfläche nur, wo es um Umstieg/Import geht (z. B. Anbieter-Vorlage in „Konto hinzufügen“).
- Icons kommen aus Tabler Icons (MIT), Farben aus den eigenen Themes `fma-light`/`fma-dark` ([ADR-0014](../adr/0014-styling-tailwind-daisyui.md)).

## Bedienmuster

| Bekanntes Muster                                | Unsere Umsetzung                                                                                         | Issue      |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------- |
| Volle Fensterbreite, durchgehende Kopfzeile     | App-Rahmen mit Kopfzeile (Name, Suche, Hilfe, Profil-Menü)                                               | #120       |
| Schmale Leiste ganz links zum Wechseln          | Kontoleiste: ein Initialen-Icon je **Konto** (statt je App), Badge, Fehlerpunkt, Sync-Ring               | #120, #119 |
| Ordner \| Liste \| Lesebereich                  | Dreispaltig auf breiten Bildschirmen; Lesebereich rechts/unten/aus, Spaltenbreiten ziehbar               | #113       |
| Kompakte Liste mit Absender, Betreff, Vorschau  | Zeile mit Absender, Datum, Betreff, Symbolen, Vorschau; Dichte „Kompakt“ ohne Vorschauzeile              | #114, #112 |
| Gruppierung nach Datum                          | „Heute / Gestern / Diese Woche / Älter“                                                                  | #114       |
| Mehrfachauswahl und Aktionen beim Überfahren    | Checkbox, Shift-Klick, `x`; Auswahlleiste; Archivieren/Löschen/Gelesen/Markieren beim Überfahren         | #114       |
| Werkzeugleiste über der Nachricht               | Antworten, Allen antworten, Weiterleiten, Gelesen, Markieren, Archivieren, Löschen, Verschieben          | 2.4        |
| Einbuchstaben-Tastenkürzel, Übersicht unter `?` | `j`/`k`, `Enter`/`o`, `Esc`/`u`, `e`/`y`, `#`, `r`/`a`/`f`, `c`, `/`, `s`/`!`, `Shift+I`/`U`, `g`+Ordner | #115       |
| Kontoeinrichtung mit App-Passwort               | Anbieter-Vorlagen mit Hinweis, wo das App-Passwort entsteht                                              | #117       |
| Hell/Dunkel nach System                         | „Wie das System / Hell / Dunkel“ pro Gerät                                                               | #112       |

## Design-Tokens

Alle Farben stammen aus den daisyUI-Themes und wenigen abgeleiteten App-Tokens in `apps/web/app/assets/css/main.css`; Komponenten verwenden keine festen Farbwerte.

| Token                                                         | Zweck                                                         |
| ------------------------------------------------------------- | ------------------------------------------------------------- |
| `--color-base-100/200/300`, `--color-base-content`            | Flächen (Inhalt, Seitenleisten, Trenner) und Text             |
| `--color-primary`, `--color-primary-content`                  | Hauptaktion, Auswahl, Links                                   |
| `--color-success/warning/error` (+ `-content`)                | Status                                                        |
| `--fma-muted`, `--fma-border`, `--fma-border-strong`          | Nebentext, Rahmen                                             |
| `--fma-*-soft`, `--fma-warning-text`, `--fma-shadow`          | Hinterlegungen, Warnhinweise, Schatten                        |
| `--fma-space-1…5`, `--fma-radius`, `--fma-radius-box`         | Abstände (0,25–1,5 rem), Radien                               |
| `--fma-text-xs/sm/md/lg`                                      | Schriftgrößen                                                 |
| `--fma-row-py/px`, `--fma-folder-py`, `--fma-snippet-display` | Dichte von Nachrichtenliste und Ordnerspalte (normal/kompakt) |

- **Hell/Dunkel:** ohne Auswahl folgt `fma-dark` der Systemeinstellung (`prefers-color-scheme`); die Einstellung „Darstellung“ setzt `data-theme` auf `<html>`.
- **Dichte:** `data-density="compact"` auf `<html>` verringert die Zeilenabstände und blendet die Vorschauzeile aus.
- **Kontrast:** Text mindestens WCAG AA (4,5:1) in beiden Themes; Kontofarben werden per Unit-Test gegen weiße Initialen geprüft.
- **Komponenten:** Farben, Abstände (Stufen 0,25/0,5/0,75/1/1,5 rem), Schriftgrößen und Radien nur über diese Tokens bzw. Tailwind/daisyUI-Klassen. Einzelne Zwischenwerte (z. B. 0,6 rem Zeilenabstand, 1,25 rem Karteninnenabstand) bleiben bewusst lokal, solange sie nur an einer Stelle gelten.
- HTML-Mails im Lesebereich bleiben hell, weil ihre Farben vom Absender stammen.
