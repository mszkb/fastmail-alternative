import { describe, expect, it } from 'vitest'
import {
  PROVIDER_PRESETS,
  presetById,
  presetFields,
  presetForAddress,
} from '../src/provider-presets'

describe('provider presets', () => {
  it('fills Fastmail with the documented servers and an app password hint', () => {
    const fastmail = presetById('fastmail')!
    expect(presetFields(fastmail, ' ich@fastmail.com ')).toEqual({
      imapHost: 'imap.fastmail.com',
      imapPort: 993,
      smtpHost: 'smtp.fastmail.com',
      smtpPort: 465,
      user: 'ich@fastmail.com',
    })
    expect(fastmail.auth).toBe('app-password')
    expect(fastmail.hint).toMatch(/App-Passwort/)
  })

  it('detects the provider from the address domain', () => {
    expect(presetForAddress('Ich@FastMail.FM')?.id).toBe('fastmail')
    expect(presetForAddress('a@posteo.de')?.id).toBe('posteo')
    expect(presetForAddress('a@googlemail.com')?.id).toBe('gmail')
    expect(presetForAddress('a@hotmail.de')?.auth).toBe('oauth-only')
    expect(presetForAddress('a@example.org')).toBeUndefined()
    expect(presetForAddress('no-address')).toBeUndefined()
  })

  it('only uses TLS ports the server allows and unique ids/domains', () => {
    const ids = new Set(PROVIDER_PRESETS.map((p) => p.id))
    expect(ids.size).toBe(PROVIDER_PRESETS.length)
    const domains = PROVIDER_PRESETS.flatMap((p) => p.domains)
    expect(new Set(domains).size).toBe(domains.length)
    for (const preset of PROVIDER_PRESETS) {
      // IMAP implicit TLS; SMTP implicit TLS or STARTTLS submission (MAIL ports policy).
      expect(preset.imap.port, preset.id).toBe(993)
      expect([465, 587], preset.id).toContain(preset.smtp.port)
    }
  })
})

describe('oauth presets (#36)', () => {
  it('links Gmail and Microsoft to their OAuth providers', () => {
    expect(presetById('gmail')?.oauth).toBe('google')
    expect(presetById('microsoft')?.oauth).toBe('microsoft')
    expect(presetById('fastmail')?.oauth).toBeUndefined()
  })
})
