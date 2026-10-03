// Install hints (roadmap 4.2): browser state for the install banner and
// guide. Chromium browsers fire `beforeinstallprompt` once per page load;
// the event is kept so an "Installieren" button can show the native dialog
// later (only inside a user gesture). Platform rules: @fma/shared install.ts.
import { detectInstallPlatform, type InstallPlatform } from '@fma/shared'

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

const DISMISSED_KEY = 'fma.install.dismissedAt'

/** Pending native install dialog (Chromium only), null when unavailable. */
export const installPrompt = shallowRef<BeforeInstallPromptEvent | null>(null)
/** Set after `appinstalled` (the tab itself stays a browser tab). */
export const appInstalled = ref(false)

let listening = false

/** Registers the install listeners once; call early (app start). */
export function listenForInstallPrompt(): void {
  if (listening || typeof window === 'undefined') return
  listening = true
  window.addEventListener('beforeinstallprompt', (event) => {
    // Keep the browser's mini-infobar from showing; our banner offers it.
    event.preventDefault()
    installPrompt.value = event as BeforeInstallPromptEvent
  })
  window.addEventListener('appinstalled', () => {
    installPrompt.value = null
    appInstalled.value = true
  })
}

/** Shows the native install dialog; true when the user accepted. */
export async function promptInstall(): Promise<boolean> {
  const event = installPrompt.value
  if (!event) return false
  installPrompt.value = null // a prompt event can only be used once
  await event.prompt()
  return (await event.userChoice).outcome === 'accepted'
}

export function isStandalone(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean }
  return window.matchMedia('(display-mode: standalone)').matches || nav.standalone === true
}

export function currentInstallPlatform(): InstallPlatform {
  return detectInstallPlatform(navigator.userAgent, navigator.maxTouchPoints)
}

/** "Später" of the banner, per browser (localStorage may be unavailable). */
export function installDismissedAt(): number | null {
  try {
    const value = Number(localStorage.getItem(DISMISSED_KEY))
    return Number.isFinite(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

export function dismissInstallBanner(): void {
  try {
    localStorage.setItem(DISMISSED_KEY, String(Date.now()))
  } catch {
    // private mode: the banner simply shows again next time
  }
}
