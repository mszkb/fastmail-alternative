import { describe, expect, it } from 'vitest'
import {
  INSTALL_BANNER_SNOOZE_MS,
  canInstall,
  detectInstallPlatform,
  shouldShowInstallBanner,
} from '../src/install'

const UA = {
  iphoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  iphoneChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/138.0.7204.156 Mobile/15E148 Safari/604.1',
  iphoneFirefox:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/141.0 Mobile/15E148 Safari/605.1.15',
  iphoneInstagram:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 390.0.0.0',
  ipadDesktopMode:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15',
  androidChrome:
    'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36',
  androidSamsung:
    'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36',
  androidFirefox: 'Mozilla/5.0 (Android 15; Mobile; rv:141.0) Gecko/141.0 Firefox/141.0',
  androidWebView:
    'Mozilla/5.0 (Linux; Android 15; Pixel 9; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/138.0.0.0 Mobile Safari/537.36',
  windowsChrome:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
  windowsEdge:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 Edg/138.0.0.0',
  macSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15',
  linuxFirefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:141.0) Gecko/20100101 Firefox/141.0',
}

describe('detectInstallPlatform', () => {
  it.each([
    ['iphoneSafari', 0, 'ios-safari'],
    ['iphoneChrome', 5, 'ios-other'],
    ['iphoneFirefox', 5, 'ios-other'],
    ['iphoneInstagram', 5, 'ios-other'],
    ['ipadDesktopMode', 5, 'ios-safari'],
    ['androidChrome', 5, 'android-chromium'],
    ['androidSamsung', 5, 'android-chromium'],
    ['androidFirefox', 5, 'android-firefox'],
    ['androidWebView', 5, 'android-other'],
    ['windowsChrome', 0, 'desktop-chromium'],
    ['windowsEdge', 0, 'desktop-chromium'],
    ['macSafari', 0, 'desktop-safari'],
    ['linuxFirefox', 0, 'desktop-firefox'],
  ] as const)('%s -> %s', (name, touchPoints, platform) => {
    expect(detectInstallPlatform(UA[name], touchPoints)).toBe(platform)
  })

  it('unknown agents fall back to other', () => {
    expect(detectInstallPlatform('curl/8.0')).toBe('other')
    expect(canInstall('other')).toBe(false)
    expect(canInstall('desktop-firefox')).toBe(false)
    expect(canInstall('ios-safari')).toBe(true)
  })
})

describe('shouldShowInstallBanner', () => {
  const now = Date.UTC(2026, 9, 3)
  const base = { platform: 'android-chromium' as const, standalone: false, dismissedAt: null, now }

  it('shows in a browser tab that can install', () => {
    expect(shouldShowInstallBanner(base)).toBe(true)
    // iOS browsers other than Safari get the "open in Safari" hint.
    expect(shouldShowInstallBanner({ ...base, platform: 'ios-other' })).toBe(true)
  })

  it('hides in the installed app and where installing is impossible', () => {
    expect(shouldShowInstallBanner({ ...base, standalone: true })).toBe(false)
    expect(shouldShowInstallBanner({ ...base, platform: 'desktop-firefox' })).toBe(false)
  })

  it('stays hidden during the snooze period after "Später"', () => {
    expect(shouldShowInstallBanner({ ...base, dismissedAt: now - 1000 })).toBe(false)
    expect(
      shouldShowInstallBanner({ ...base, dismissedAt: now - INSTALL_BANNER_SNOOZE_MS - 1 }),
    ).toBe(true)
  })
})
