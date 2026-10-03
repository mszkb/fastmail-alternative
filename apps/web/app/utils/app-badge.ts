// App badge (roadmap 4.4): unread count on the app icon via the Badging API
// (installed PWA; on iOS only with notification permission), and as a
// "(3) " title prefix in a browser tab, where the icon badge is not visible.
// The rules live in @fma/shared (badge.ts); the service worker sets the
// same count from push payloads.
import { formatBadgeTitle } from '@fma/shared'

type BadgeNavigator = Navigator & {
  setAppBadge?: (count?: number) => Promise<void>
  clearAppBadge?: () => Promise<void>
}

export function updateAppBadge(count: number): void {
  const nav = navigator as BadgeNavigator
  if (typeof nav.setAppBadge === 'function' && typeof nav.clearAppBadge === 'function') {
    // Rejected e.g. on iOS without notification permission: title only.
    const update = count > 0 ? nav.setAppBadge(count) : nav.clearAppBadge()
    update.catch(() => {})
  }
  const standalone = window.matchMedia('(display-mode: standalone)').matches
  document.title = formatBadgeTitle(document.title, standalone ? 0 : count)
}
