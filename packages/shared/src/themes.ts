/**
 * Installable themes (#126): a declarative file (`*.fmatheme.json`) with a
 * manifest, color and size tokens (#112) and layout options the app already
 * knows (#113, #120). No code, no free CSS, no URLs: only values from an
 * allowlist pass (colors `#rrggbb`, sizes in `rem` within limits, fixed
 * choices), anything else is rejected - so a theme cannot run script,
 * exfiltrate via CSS or track. Text/background pairs must reach WCAG AA
 * (4.5:1) in light and dark, otherwise the theme is rejected.
 *
 * The same rules are checked by the server (apps/server-php ThemeValidator)
 * and described as JSON schema in docs/themes/schema.json.
 */
import { contrastRatio } from './account-avatar'
import type { DensityChoice } from './appearance'
import type { ReadingPane } from './layout'

export const THEME_FORMAT = 1
/** Bytes of a theme file (UTF-8 JSON). */
export const THEME_MAX_BYTES = 32 * 1024
/** Installed themes per user. */
export const THEME_MAX_INSTALLED = 20
export const THEME_MIN_CONTRAST = 4.5

/** Colors a theme may set (daisyUI theme variables `--color-<name>`). */
export const THEME_COLORS = [
  'base-100',
  'base-200',
  'base-300',
  'base-content',
  'primary',
  'primary-content',
  'secondary',
  'secondary-content',
  'accent',
  'accent-content',
  'neutral',
  'neutral-content',
  'info',
  'info-content',
  'success',
  'success-content',
  'warning',
  'warning-content',
  'error',
  'error-content',
] as const
export type ThemeColor = (typeof THEME_COLORS)[number]

/** Size tokens (`--fma-<name>`, #112) and their allowed range in rem. */
export const THEME_SIZES = {
  'space-1': [0, 1],
  'space-2': [0, 1.5],
  'space-3': [0, 2],
  'space-4': [0, 2.5],
  'space-5': [0, 3],
  radius: [0, 1.5],
  'radius-box': [0, 2],
  'text-xs': [0.625, 1],
  'text-sm': [0.7, 1.15],
  'text-md': [0.8, 1.3],
  'text-lg': [0.9, 1.6],
} as const satisfies Record<string, readonly [number, number]>
export type ThemeSize = keyof typeof THEME_SIZES

export type AccountRailStyle = 'icons' | 'list'

export interface ThemeLayout {
  readingPane?: ReadingPane
  density?: DensityChoice
  /** Account bar with icons only or with names. */
  accountRail?: AccountRailStyle
}

export interface Theme {
  format: typeof THEME_FORMAT
  /** Lower-case letters, digits and hyphens; unique per user. */
  id: string
  name: string
  version: string
  author: string
  license: string
  minAppVersion: string
  description?: string
  colors?: {
    light?: Partial<Record<ThemeColor, string>>
    dark?: Partial<Record<ThemeColor, string>>
  }
  /** Sizes as `<number>rem`. */
  sizes?: Partial<Record<ThemeSize, string>>
  layout?: ThemeLayout
}

/** An installed theme as listed by `GET /api/themes`. */
export interface InstalledTheme {
  id: string
  name: string
  version: string
  installedAt: string
  theme: Theme
}

export interface ThemeListResponse {
  themes: InstalledTheme[]
}

/** The built-in palettes (assets/css/main.css): fallback for the contrast check. */
export const DEFAULT_THEME_COLORS: Record<'light' | 'dark', Record<ThemeColor, string>> = {
  light: {
    'base-100': '#ffffff',
    'base-200': '#f5f7fa',
    'base-300': '#e3e8ee',
    'base-content': '#1f2933',
    primary: '#0f5cb5',
    'primary-content': '#ffffff',
    secondary: '#6d3fc0',
    'secondary-content': '#ffffff',
    accent: '#0f766e',
    'accent-content': '#ffffff',
    neutral: '#2f3b47',
    'neutral-content': '#f5f7fa',
    info: '#1d6fd6',
    'info-content': '#ffffff',
    success: '#127146',
    'success-content': '#ffffff',
    warning: '#c27a06',
    'warning-content': '#1f1400',
    error: '#b42318',
    'error-content': '#ffffff',
  },
  dark: {
    'base-100': '#161b22',
    'base-200': '#1d242d',
    'base-300': '#2a333e',
    'base-content': '#dfe5ec',
    primary: '#5ea2f2',
    'primary-content': '#06182c',
    secondary: '#b18cf0',
    'secondary-content': '#1a0c33',
    accent: '#3cc3b4',
    'accent-content': '#04201d',
    neutral: '#cfd7e0',
    'neutral-content': '#161b22',
    info: '#6aaaf5',
    'info-content': '#06182c',
    success: '#4cc38a',
    'success-content': '#04200f',
    warning: '#e6a73a',
    'warning-content': '#231600',
    error: '#f2726a',
    'error-content': '#2b0503',
  },
}

/** Text/background pairs that must reach THEME_MIN_CONTRAST. */
export const THEME_CONTRAST_PAIRS: [ThemeColor, ThemeColor][] = [
  ['base-content', 'base-100'],
  ['base-content', 'base-200'],
  ['base-content', 'base-300'],
  ['primary-content', 'primary'],
  ['secondary-content', 'secondary'],
  ['accent-content', 'accent'],
  ['neutral-content', 'neutral'],
  ['info-content', 'info'],
  ['success-content', 'success'],
  ['warning-content', 'warning'],
  ['error-content', 'error'],
  // Links and primary text on the page background.
  ['primary', 'base-100'],
]

const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/
const SEMVER_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/
const COLOR_RE = /^#[0-9a-f]{6}$/
const REM_RE = /^(\d{1,2}(?:\.\d{1,4})?)rem$/
const TOP_KEYS = new Set([
  'format',
  'id',
  'name',
  'version',
  'author',
  'license',
  'minAppVersion',
  'description',
  'colors',
  'sizes',
  'layout',
])
const TEXT_LIMITS: Record<string, number> = {
  name: 60,
  author: 100,
  license: 60,
  description: 300,
}
const LAYOUT_VALUES: Record<string, readonly string[]> = {
  readingPane: ['right', 'bottom', 'off'],
  density: ['normal', 'compact'],
  accountRail: ['icons', 'list'],
}

export type ThemeValidation = { ok: true; theme: Theme } | { ok: false; errors: string[] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Plain text: printable, no markup characters (names are shown in the UI). */
function plainText(value: string): boolean {
  return !/[\u0000-\u001f\u007f<>{}\\]/.test(value)
}

/**
 * Validates a parsed theme file. Errors are German and name the field;
 * they never echo the rejected values.
 */
export function validateTheme(input: unknown): ThemeValidation {
  const errors: string[] = []
  if (!isRecord(input))
    return { ok: false, errors: ['Die Datei ist kein Theme (JSON-Objekt erwartet).'] }
  for (const key of Object.keys(input)) {
    if (!TOP_KEYS.has(key)) errors.push(`Unbekanntes Feld „${safeKey(key)}“.`)
  }
  if (input.format !== THEME_FORMAT) errors.push(`„format“ muss ${THEME_FORMAT} sein.`)
  if (typeof input.id !== 'string' || !ID_RE.test(input.id))
    errors.push('„id“: nur Kleinbuchstaben, Ziffern und Bindestriche (max. 48).')
  for (const key of ['version', 'minAppVersion']) {
    if (typeof input[key] !== 'string' || !SEMVER_RE.test(input[key]))
      errors.push(`„${key}“ muss eine Version wie 1.0.0 sein.`)
  }
  for (const [key, max] of Object.entries(TEXT_LIMITS)) {
    const value = input[key]
    if (value === undefined && key === 'description') continue
    if (typeof value !== 'string' || value.trim() === '' || value.length > max || !plainText(value))
      errors.push(`„${key}“: Text mit 1–${max} Zeichen ohne Sonderzeichen wie < > { } erwartet.`)
  }

  if (input.colors !== undefined) {
    if (!isRecord(input.colors)) errors.push('„colors“ muss ein Objekt sein.')
    else {
      for (const [mode, palette] of Object.entries(input.colors)) {
        if (mode !== 'light' && mode !== 'dark') {
          errors.push(`Unbekanntes Farbschema „${safeKey(mode)}“ (erlaubt: light, dark).`)
          continue
        }
        if (!isRecord(palette)) {
          errors.push(`„colors.${mode}“ muss ein Objekt sein.`)
          continue
        }
        for (const [name, value] of Object.entries(palette)) {
          if (!(THEME_COLORS as readonly string[]).includes(name))
            errors.push(`Unbekannte Farbe „colors.${mode}.${safeKey(name)}“.`)
          else if (typeof value !== 'string' || !COLOR_RE.test(value))
            errors.push(`„colors.${mode}.${name}“ muss eine Farbe wie #1a2b3c sein.`)
        }
      }
    }
  }
  if (input.sizes !== undefined) {
    if (!isRecord(input.sizes)) errors.push('„sizes“ muss ein Objekt sein.')
    else {
      for (const [name, value] of Object.entries(input.sizes)) {
        const range = (THEME_SIZES as Record<string, readonly [number, number]>)[name]
        const match = typeof value === 'string' ? REM_RE.exec(value) : null
        if (!range) errors.push(`Unbekannte Größe „sizes.${safeKey(name)}“.`)
        else if (!match || Number(match[1]) < range[0] || Number(match[1]) > range[1])
          errors.push(`„sizes.${name}“ muss zwischen ${range[0]}rem und ${range[1]}rem liegen.`)
      }
    }
  }
  if (input.layout !== undefined) {
    if (!isRecord(input.layout)) errors.push('„layout“ muss ein Objekt sein.')
    else {
      for (const [name, value] of Object.entries(input.layout)) {
        const allowed = LAYOUT_VALUES[name]
        if (!allowed) errors.push(`Unbekannte Layout-Option „layout.${safeKey(name)}“.`)
        else if (typeof value !== 'string' || !allowed.includes(value))
          errors.push(`„layout.${name}“: erlaubt sind ${allowed.join(', ')}.`)
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors }

  const theme = input as unknown as Theme
  for (const mode of ['light', 'dark'] as const) {
    const palette = themePalette(theme, mode)
    for (const [text, background] of THEME_CONTRAST_PAIRS) {
      const ratio = contrastRatio(palette[text], palette[background])
      if (ratio < THEME_MIN_CONTRAST)
        errors.push(
          `Zu wenig Kontrast (${mode === 'light' ? 'hell' : 'dunkel'}): ${text} auf ${background} ` +
            `${ratio.toFixed(2)}:1, mindestens ${THEME_MIN_CONTRAST}:1.`,
        )
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, theme }
}

/** Parses and validates the text of a theme file (size limit included). */
export function parseThemeFile(text: string): ThemeValidation {
  if (new TextEncoder().encode(text).length > THEME_MAX_BYTES)
    return { ok: false, errors: [`Die Datei ist größer als ${THEME_MAX_BYTES / 1024} KB.`] }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, errors: ['Die Datei ist kein gültiges JSON.'] }
  }
  return validateTheme(parsed)
}

/** Full palette of a mode: the theme's colors over the built-in ones. */
export function themePalette(theme: Theme, mode: 'light' | 'dark'): Record<ThemeColor, string> {
  return { ...DEFAULT_THEME_COLORS[mode], ...(theme.colors?.[mode] ?? {}) }
}

/**
 * Style sheet of a validated theme: its variables for `:root[data-user-theme]`
 * in light, dark (explicit) and dark (system). Values passed the validator,
 * so they can only be colors and rem sizes.
 */
export function themeStyleSheet(theme: Theme): string {
  const declarations = (entries: [string, string][]) =>
    entries.map(([name, value]) => `${name}:${value};`).join('')
  const colors = (mode: 'light' | 'dark') =>
    Object.entries(theme.colors?.[mode] ?? {})
      .filter(
        ([name, value]) =>
          (THEME_COLORS as readonly string[]).includes(name) && COLOR_RE.test(String(value)),
      )
      .map(([name, value]): [string, string] => [`--color-${name}`, String(value)])
  const sizes = Object.entries(theme.sizes ?? {})
    .filter(([name, value]) => name in THEME_SIZES && REM_RE.test(String(value)))
    .map(([name, value]): [string, string] => [`--fma-${name}`, String(value)])
  const light = declarations([...colors('light'), ...sizes])
  const dark = declarations(colors('dark'))
  return (
    `:root[data-user-theme]{${light}}` +
    `:root[data-user-theme][data-theme=fma-dark]{${dark}}` +
    `@media (prefers-color-scheme: dark){:root[data-user-theme]:not([data-theme=fma-light]){${dark}}}`
  )
}

/** `?theme=default` in the URL: always back to the built-in look. */
export function wantsDefaultTheme(search: string): boolean {
  return new URLSearchParams(search).get('theme') === 'default'
}

function safeKey(key: string): string {
  return key.replace(/[^\w.-]/g, '?').slice(0, 40)
}
