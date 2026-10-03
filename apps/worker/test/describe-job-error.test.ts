import { describe, expect, it } from 'vitest'
import { describeJobError } from '../src/runner'

describe('describeJobError', () => {
  it('drops message and server response, keeps class, code and frames', () => {
    const err = Object.assign(new Error('Mailbox "Bewerbung Max Mustermann" not found'), {
      code: 'NONEXISTENT',
      response: 'A1 NO [NONEXISTENT] max@example.com: no such mailbox',
    })
    const summary = describeJobError(err)
    const serialized = JSON.stringify(summary)
    expect(serialized).not.toContain('Mustermann')
    expect(serialized).not.toContain('max@example.com')
    expect(summary.name).toBe('Error')
    expect(summary.code).toBe('NONEXISTENT')
    expect(summary.text).toBe('Error:NONEXISTENT')
    expect(summary.frames).toMatch(/^\s*at /)
  })

  it('maps provider errors to the account error code', () => {
    const err = Object.assign(new Error('Invalid login for max@example.com'), {
      authenticationFailed: true,
    })
    const summary = describeJobError(err)
    expect(summary.accountErrorCode).toBe('AUTH_FAILED')
    expect(summary.text).not.toContain('max@example.com')
  })

  it('handles non-error values', () => {
    expect(describeJobError('boom').text).toBe('string')
  })
})
