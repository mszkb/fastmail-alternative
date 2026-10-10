import { describe, expect, it } from 'vitest'
import { autoconfigDomain, autoconfigFields } from '../src/provider-presets'

describe('autoconfig (#165)', () => {
  it('asks only for complete addresses without a preset', () => {
    expect(autoconfigDomain(' Ich@Example.ORG ')).toBe('example.org')
    expect(autoconfigDomain('a@mail.example.co.uk.')).toBe('mail.example.co.uk')
    expect(autoconfigDomain('a@fastmail.com')).toBeUndefined()
    expect(autoconfigDomain('a@localhost')).toBeUndefined()
    expect(autoconfigDomain('@example.org')).toBeUndefined()
    expect(autoconfigDomain('a@b@example.org')).toBeUndefined()
    expect(autoconfigDomain('a@exa mple.org')).toBeUndefined()
    expect(autoconfigDomain('no-address')).toBeUndefined()
  })

  it('maps the result to form values', () => {
    const result = {
      found: true,
      source: 'ispdb' as const,
      imap: { host: 'imap.example.org', port: 993 },
      smtp: { host: 'smtp.example.org', port: 587 },
      username: 'localpart' as const,
    }
    expect(autoconfigFields(result, ' ich@example.org ')).toEqual({
      imapHost: 'imap.example.org',
      imapPort: 993,
      smtpHost: 'smtp.example.org',
      smtpPort: 587,
      user: 'ich',
    })
    expect(
      autoconfigFields({ ...result, smtp: null, username: 'address' }, 'ich@example.org'),
    ).toEqual({ imapHost: 'imap.example.org', imapPort: 993, user: 'ich@example.org' })
    expect(autoconfigFields({ found: false }, 'ich@example.org')).toBeUndefined()
  })
})
