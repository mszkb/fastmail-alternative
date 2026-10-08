/**
 * Appearance (#112): theme (follow the system, light, dark) and list
 * density (normal, compact), chosen per device. The web app maps them to
 * `data-theme` (daisyUI themes fma-light/fma-dark; none = follow the
 * system) and `data-density` on <html>; native clients map them to their
 * own settings.
 */

export type ThemeChoice = 'system' | 'light' | 'dark'
export type DensityChoice = 'normal' | 'compact'

export const THEME_CHOICES: { value: ThemeChoice; label: string }[] = [
  { value: 'system', label: 'Wie das System' },
  { value: 'light', label: 'Hell' },
  { value: 'dark', label: 'Dunkel' },
]

export const DENSITY_CHOICES: { value: DensityChoice; label: string }[] = [
  { value: 'normal', label: 'Normal' },
  { value: 'compact', label: 'Kompakt' },
]

export function parseTheme(value: unknown): ThemeChoice {
  return value === 'light' || value === 'dark' ? value : 'system'
}

export function parseDensity(value: unknown): DensityChoice {
  return value === 'compact' ? 'compact' : 'normal'
}

/** daisyUI theme for `data-theme`; null = follow prefers-color-scheme. */
export function themeAttribute(theme: ThemeChoice): string | null {
  return theme === 'light' ? 'fma-light' : theme === 'dark' ? 'fma-dark' : null
}
