/** `Secure` flag of the session cookie (audit N7). */
import { describe, expect, it } from 'vitest'
import { cookieSecure } from '../src/auth/routes'

describe('cookieSecure', () => {
  it('follows DOMAIN by default: only plain-HTTP :80 is not secure', () => {
    expect(cookieSecure({})).toBe(false)
    expect(cookieSecure({ DOMAIN: ':80' })).toBe(false)
    expect(cookieSecure({ DOMAIN: 'mail.example.org' })).toBe(true)
  })

  it('COOKIE_SECURE overrides it (own TLS proxy in front of :80, or the reverse)', () => {
    expect(cookieSecure({ DOMAIN: ':80', COOKIE_SECURE: '1' })).toBe(true)
    expect(cookieSecure({ DOMAIN: 'mail.example.org', COOKIE_SECURE: '0' })).toBe(false)
    expect(cookieSecure({ DOMAIN: ':80', COOKIE_SECURE: 'yes' })).toBe(false)
  })
})
