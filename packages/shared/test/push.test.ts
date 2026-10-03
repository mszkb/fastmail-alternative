import { describe, expect, it } from 'vitest'
import {
  PUSH_PAYLOAD_FIELDS,
  base64UrlToBytes,
  buildPushPayload,
  isIosUserAgent,
  pushAvailability,
  type PushEnvironment,
} from '../src/push'

const supported: PushEnvironment = {
  hasServiceWorker: true,
  hasPushManager: true,
  hasNotification: true,
  isIos: false,
  isStandalone: false,
  permission: 'default',
  serverConfigured: true,
}

describe('push payload', () => {
  it('contains only type, installation id and badge', () => {
    const payload = buildPushPayload('inst-1', 7)
    expect(payload).toEqual({ type: 'new_mail', installationId: 'inst-1', badge: 7 })
    expect(Object.keys(payload).sort()).toEqual([...PUSH_PAYLOAD_FIELDS].sort())
  })

  it('normalizes the badge to a non-negative integer', () => {
    expect(buildPushPayload('i', -3).badge).toBe(0)
    expect(buildPushPayload('i', Number.NaN).badge).toBe(0)
    expect(buildPushPayload('i', 2.7).badge).toBe(2)
  })
})

describe('pushAvailability', () => {
  it('asks iOS browser tabs to install the app first', () => {
    expect(pushAvailability({ ...supported, isIos: true, hasPushManager: false })).toBe(
      'needs-install',
    )
    expect(pushAvailability({ ...supported, isIos: true, isStandalone: true })).toBe('available')
  })

  it('reports missing browser support, server config and blocked permission', () => {
    expect(pushAvailability({ ...supported, hasPushManager: false })).toBe('unsupported')
    expect(pushAvailability({ ...supported, hasServiceWorker: false })).toBe('unsupported')
    expect(pushAvailability({ ...supported, serverConfigured: false })).toBe('unconfigured')
    expect(pushAvailability({ ...supported, permission: 'denied' })).toBe('denied')
    expect(pushAvailability({ ...supported, permission: 'granted' })).toBe('available')
  })
})

describe('isIosUserAgent', () => {
  it('detects iPhone and iPadOS (desktop user agent with touch)', () => {
    expect(isIosUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe(true)
    expect(isIosUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5)).toBe(true)
    expect(isIosUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0)).toBe(false)
    expect(isIosUserAgent('Mozilla/5.0 (Linux; Android 15)')).toBe(false)
  })
})

describe('base64UrlToBytes', () => {
  it('decodes unpadded base64url', () => {
    const bytes = Buffer.from([0x04, 0xfb, 0xff, 0x3e, 0x10])
    expect(Buffer.from(base64UrlToBytes(bytes.toString('base64url')))).toEqual(bytes)
  })
})
