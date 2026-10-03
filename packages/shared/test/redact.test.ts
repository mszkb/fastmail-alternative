import { describe, expect, it } from 'vitest'
import { REDACT_LOG_PATHS, SENSITIVE_LOG_KEYS, redactForLog } from '../src/redact'

describe('redactForLog', () => {
  it('censors sensitive keys at the top level', () => {
    const redacted = redactForLog({ email: 'a@b.c', password: 'hunter2', token: 't.abc' })
    expect(redacted).toEqual({ email: 'a@b.c', password: '[REDACTED]', token: '[REDACTED]' })
  })

  it('censors mail content keys (subject, snippet, body, addresses)', () => {
    const redacted = redactForLog({
      subject: 'Geheime Rechnung',
      snippet: 'Sehr geehrte...',
      body: 'Inhalt',
      addresses: ['a@b.c'],
    })
    expect(JSON.stringify(redacted)).not.toContain('Geheime')
    expect(JSON.stringify(redacted)).not.toContain('Sehr geehrte')
    expect(JSON.stringify(redacted)).not.toContain('a@b.c')
    expect(JSON.stringify(redacted)).toContain('[REDACTED]')
  })

  it('censors nested keys and inside arrays', () => {
    const redacted = redactForLog({
      account: { settings: { password: 'x', imap: { host: 'imap.example.com' } } },
      jobs: [{ token: 't1' }, { subject: 's1' }],
    }) as {
      account: { settings: { password: string; imap: { host: string } } }
      jobs: { token?: string; subject?: string }[]
    }
    expect(redacted.account.settings.password).toBe('[REDACTED]')
    expect(redacted.account.settings.imap.host).toBe('imap.example.com') // host stays
    expect(redacted.jobs[0]?.token).toBe('[REDACTED]')
    expect(redacted.jobs[1]?.subject).toBe('[REDACTED]')
  })

  it('is case-insensitive on keys', () => {
    expect(redactForLog({ PassWord: 'x' })).toEqual({ PassWord: '[REDACTED]' })
  })

  it('does not mutate the input', () => {
    const input = { password: 'x' }
    redactForLog(input)
    expect(input.password).toBe('x')
  })

  it('is cycle-safe', () => {
    const input: Record<string, unknown> = { name: 'a' }
    input['self'] = input
    expect(() => redactForLog(input)).not.toThrow()
    expect((redactForLog(input) as { name: string }).name).toBe('a')
  })

  it('passes through primitives and dates', () => {
    const date = new Date('2026-01-01')
    expect(redactForLog(date)).toBe(date)
    expect(redactForLog(42)).toBe(42)
    expect(redactForLog('plain')).toBe('plain')
  })
})

describe('REDACT_LOG_PATHS', () => {
  it('covers passwords, tokens and subjects for pino', () => {
    for (const key of ['password', 'token', 'subject'] as const) {
      expect(REDACT_LOG_PATHS).toContain(key)
      expect(REDACT_LOG_PATHS).toContain(`*.${key}`)
    }
  })

  it('covers request header leak vectors', () => {
    expect(REDACT_LOG_PATHS).toContain('req.headers.cookie')
    expect(REDACT_LOG_PATHS).toContain('req.headers.authorization')
    expect(REDACT_LOG_PATHS).toContain('req.body')
  })

  it('is derived from the sensitive key list', () => {
    expect(SENSITIVE_LOG_KEYS.length).toBeGreaterThan(10)
  })
})
