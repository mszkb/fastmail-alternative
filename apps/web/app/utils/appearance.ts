// Appearance per device (#112): theme and density on <html>, remembered in
// localStorage. Applied by plugins/appearance.client.ts before the app
// renders, so the chosen theme shows without a flash.
import { parseDensity, parseTheme, themeAttribute } from '@fma/shared'
import type { DensityChoice, ThemeChoice } from '@fma/shared'

const THEME_KEY = 'fma.appearance.theme'
const DENSITY_KEY = 'fma.appearance.density'

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export const themeChoice = ref<ThemeChoice>(
  import.meta.client ? parseTheme(stored(THEME_KEY)) : 'system',
)
export const densityChoice = ref<DensityChoice>(
  import.meta.client ? parseDensity(stored(DENSITY_KEY)) : 'normal',
)

export function applyAppearance(): void {
  const root = document.documentElement
  const theme = themeAttribute(themeChoice.value)
  if (theme) root.setAttribute('data-theme', theme)
  else root.removeAttribute('data-theme')
  root.setAttribute('data-density', densityChoice.value)
}

export function setAppearance(theme: ThemeChoice, density: DensityChoice): void {
  themeChoice.value = theme
  densityChoice.value = density
  try {
    localStorage.setItem(THEME_KEY, theme)
    localStorage.setItem(DENSITY_KEY, density)
  } catch {
    // Private mode: only for this session.
  }
  applyAppearance()
}
