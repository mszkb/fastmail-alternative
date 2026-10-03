/**
 * Install hints (roadmap 4.2): which "add to home screen / install" guide
 * fits this browser. Pure functions on the user agent, so the rules are
 * testable without a browser; the web app adds display-mode detection and
 * the beforeinstallprompt event.
 */
import { isIosUserAgent } from './push'

export type InstallPlatform =
  /** iPhone/iPad Safari: share menu -> "Zum Home-Bildschirm". */
  | 'ios-safari'
  /** Other iOS browsers and in-app browsers: open the page in Safari. */
  | 'ios-other'
  /** Chrome, Edge, Samsung Internet ... on Android: install prompt/menu. */
  | 'android-chromium'
  | 'android-firefox'
  | 'android-other'
  /** Chrome/Edge (and other Chromium browsers) on Windows, macOS, Linux. */
  | 'desktop-chromium'
  | 'desktop-safari'
  | 'desktop-firefox'
  | 'other'

/** Browser tokens of iOS browsers that are not Safari (all use WebKit). */
const IOS_NON_SAFARI_RE = /CriOS|FxiOS|EdgiOS|OPiOS|OPT\/|YaBrowser|DuckDuckGo|GSA\/|Brave/i
/** In-app browsers (Facebook, Instagram, LinkedIn ...) cannot install. */
const IN_APP_RE = /FBAN|FBAV|Instagram|LinkedInApp|Line\/|MicroMessenger|; wv\)/i

export function detectInstallPlatform(userAgent: string, maxTouchPoints = 0): InstallPlatform {
  if (isIosUserAgent(userAgent, maxTouchPoints)) {
    if (IOS_NON_SAFARI_RE.test(userAgent) || IN_APP_RE.test(userAgent)) return 'ios-other'
    // Safari carries "Version/x Safari/y"; web views lack the Safari token.
    return /Version\/[\d.]+.*Safari\//.test(userAgent) ? 'ios-safari' : 'ios-other'
  }
  if (/Android/i.test(userAgent)) {
    if (/Firefox\//i.test(userAgent)) return 'android-firefox'
    if (IN_APP_RE.test(userAgent)) return 'android-other'
    if (/Chrome\/|SamsungBrowser|EdgA\//i.test(userAgent)) return 'android-chromium'
    return 'android-other'
  }
  if (/Firefox\//i.test(userAgent)) return 'desktop-firefox'
  if (/Edg\/|Chrome\/|Chromium\//i.test(userAgent)) return 'desktop-chromium'
  if (/Macintosh/i.test(userAgent) && /Version\/[\d.]+.*Safari\//.test(userAgent)) {
    return 'desktop-safari'
  }
  return 'other'
}

/** Platforms where this browser can install the app at all. */
export function canInstall(platform: InstallPlatform): boolean {
  return (
    platform === 'ios-safari' ||
    platform === 'android-chromium' ||
    platform === 'android-firefox' ||
    platform === 'desktop-chromium' ||
    platform === 'desktop-safari'
  )
}

/** How long "Später" hides the install banner. */
export const INSTALL_BANNER_SNOOZE_MS = 30 * 24 * 60 * 60 * 1000

/**
 * The install banner shows in a browser tab (not in the installed app),
 * when this browser can install or should switch to Safari (iOS), and not
 * within the snooze period after "Später".
 */
export function shouldShowInstallBanner(input: {
  platform: InstallPlatform
  standalone: boolean
  dismissedAt: number | null
  now: number
}): boolean {
  if (input.standalone) return false
  if (!canInstall(input.platform) && input.platform !== 'ios-other') return false
  if (input.dismissedAt !== null && input.now - input.dismissedAt < INSTALL_BANNER_SNOOZE_MS) {
    return false
  }
  return true
}
