// Installable themes (#126), per device: the active theme file is kept in
// localStorage (applied by plugins/appearance.client.ts before the app
// renders, also offline) and re-validated on every load. Applying writes a
// <style> with the theme's variables only (themeStyleSheet) and marks
// <html data-user-theme>. `?theme=default` in the URL always switches back
// to the built-in look.
import { themeStyleSheet, validateTheme, wantsDefaultTheme } from '@fma/shared'
import type { Theme } from '@fma/shared'

const ACTIVE_KEY = 'fma.appearance.userTheme'
const STYLE_ID = 'fma-user-theme'

/** Id of the active theme on this device ('' = built-in). */
export const activeThemeId = ref('')
/** Id of a theme shown as preview (not saved). */
export const previewThemeId = ref('')

function applyStyle(theme: Theme | null): void {
  const root = document.documentElement
  let style = document.getElementById(STYLE_ID)
  if (!theme) {
    style?.remove()
    root.removeAttribute('data-user-theme')
    return
  }
  if (!style) {
    style = document.createElement('style')
    style.id = STYLE_ID
    document.head.appendChild(style)
  }
  style.textContent = themeStyleSheet(theme)
  root.setAttribute('data-user-theme', theme.id)
}

function storedTheme(): Theme | null {
  try {
    const raw = localStorage.getItem(ACTIVE_KEY)
    if (!raw) return null
    const result = validateTheme(JSON.parse(raw))
    return result.ok ? result.theme : null
  } catch {
    return null
  }
}

/** Activates a theme on this device (null = built-in) and remembers it. */
export function activateTheme(theme: Theme | null): void {
  previewThemeId.value = ''
  activeThemeId.value = theme?.id ?? ''
  try {
    if (theme) localStorage.setItem(ACTIVE_KEY, JSON.stringify(theme))
    else localStorage.removeItem(ACTIVE_KEY)
  } catch {
    // Private mode: only for this session.
  }
  applyStyle(theme)
}

/** Shows a theme without saving it; null ends the preview. */
export function previewTheme(theme: Theme | null): void {
  previewThemeId.value = theme?.id ?? ''
  applyStyle(theme ?? storedTheme())
}

/**
 * Startup: `?theme=default` resets (returns true: the caller removes the
 * parameter once the router is ready), otherwise the stored theme applies.
 */
export function initUserTheme(): boolean {
  if (wantsDefaultTheme(location.search)) {
    activateTheme(null)
    return true
  }
  const theme = storedTheme()
  activeThemeId.value = theme?.id ?? ''
  applyStyle(theme)
  return false
}
