import { describe, expect, it } from 'vitest'
import { ACCOUNT_ERROR_MESSAGES, accountStatusInfo } from '../src/mail'

describe('accountStatusInfo', () => {
  it('is null for a healthy account', () => {
    expect(accountStatusInfo({ status: 'ok', lastErrorCode: null })).toBeNull()
  })

  it('asks for new credentials on auth errors', () => {
    const info = accountStatusInfo({ status: 'auth_error', lastErrorCode: 'AUTH_FAILED' })
    expect(info?.label).toBe('Anmeldung fehlgeschlagen')
    expect(info?.action).toBe('Zugangsdaten aktualisieren')
    expect(info?.description).toContain(ACCOUNT_ERROR_MESSAGES.AUTH_FAILED)
  })

  it('explains the cause of an unreachable provider', () => {
    const info = accountStatusInfo({ status: 'unreachable', lastErrorCode: 'CONNECTION_REFUSED' })
    expect(info?.label).toBe('Server nicht erreichbar')
    expect(info?.description).toContain(ACCOUNT_ERROR_MESSAGES.CONNECTION_REFUSED)
    expect(info?.description).toContain('Andere Konten sind nicht betroffen')
  })
})
