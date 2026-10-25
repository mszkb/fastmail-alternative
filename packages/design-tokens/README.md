# @fma/design-tokens

Plattformneutrale Design-Tokens (#141, [ADR-0010](../../docs/adr/0010-client-strategy.md), [ADR-0015](../../docs/adr/0015-mobile-kotlin-multiplatform.md)): eine Quelle für Web und native Apps.

`tokens.json` enthält:

- `colors` – die daisyUI-Theme-Farben (ADR-0014) für hell und dunkel
- `shape` – Radien, Feldgrößen und Rahmen der daisyUI-Themes
- `sizes` – Abstände, Radien und Schriftgrößen der App (`--fma-*`, #112)
- `density` – Zeilenabstände für „Normal“ und „Kompakt“
- `accountColors` – Farben der Konto-Icons (weiße Initialen erreichen WCAG AA)
- `icons` – die Tabler-Icons, die die App nutzt (Web: `@tabler/icons-vue`, App: dieselben SVGs)

Nach einer Änderung `pnpm tokens` ausführen. Das Skript schreibt:

| Datei                                         | Nutzt                                                    |
| --------------------------------------------- | -------------------------------------------------------- |
| `apps/web/app/assets/css/tokens.css`          | PWA, eingebunden in `main.css`                           |
| `packages/shared/src/design-tokens.ts`        | `@fma/shared` (Kontofarben, Kontrastprüfung der Themes)  |
| `apps/server-php/src/Themes/DesignTokens.php` | Kontrastprüfung installierbarer Themes im Backend (#126) |
| `generated/FmaTokens.kt`                      | Compose-Theme der Apps (`apps/mobile`, #142)             |

Die erzeugten Dateien nie von Hand ändern. `pnpm test` schlägt fehl, wenn sie nicht zur JSON-Datei passen, wenn eine Kontofarbe zu wenig Kontrast hat oder wenn die Icon-Liste nicht genau den Imports der PWA entspricht.

Größen stehen in `rem`; in der App gilt 1 rem = 16 dp (Schrift: sp).
