import { describe, expect, it } from 'vitest'
import { accountStatusInfo } from '../src/mail'
import { oauthResultFromQuery, withoutOAuthResult } from '../src/oauth'

describe('oauth result (#36)', () => {
  it('reads a connected account', () => {
    expect(oauthResultFromQuery('?oauth=connected&account=abc')).toEqual({
      ok: true,
      accountId: 'abc',
      message: 'Konto verbunden.',
    })
  })

  it('explains errors, with the connection test code', () => {
    expect(oauthResultFromQuery('?oauth=error&reason=denied')).toMatchObject({
      ok: false,
      message: expect.stringMatching(/abgebrochen/),
    })
    expect(oauthResultFromQuery('?oauth=error&reason=imap&code=AUTH_FAILED')?.message).toMatch(
      /IMAP.*Zugangsdaten abgelehnt/,
    )
    expect(oauthResultFromQuery('?oauth=error&reason=imap')?.message).toMatch(/Gmail/)
    expect(oauthResultFromQuery('?oauth=error&reason=whatever')?.message).toBe(
      'Die Anmeldung ist fehlgeschlagen.',
    )
  })

  it('ignores addresses without a result and strips only its parameters', () => {
    expect(oauthResultFromQuery('')).toBeNull()
    expect(oauthResultFromQuery('?oauth=maybe')).toBeNull()
    expect(withoutOAuthResult('?oauth=error&reason=state&code=X')).toBe('')
    expect(withoutOAuthResult('?oauth=connected&account=a&install=1')).toBe('?install=1')
  })

  it('asks OAuth accounts to sign in again instead of new credentials', () => {
    expect(
      accountStatusInfo({
        status: 'auth_error',
        lastErrorCode: 'OAUTH_EXPIRED',
        credentialKind: 'oauth2',
      }),
    ).toMatchObject({ label: 'Neu anmelden', action: 'Neu anmelden' })
    expect(
      accountStatusInfo({
        status: 'auth_error',
        lastErrorCode: 'AUTH_FAILED',
        credentialKind: 'password',
      }),
    ).toMatchObject({ action: 'Zugangsdaten aktualisieren' })
  })
})
