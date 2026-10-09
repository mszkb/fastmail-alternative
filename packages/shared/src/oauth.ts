/**
 * Sign-in with Google or Microsoft (#36, ADR-0011): provider names and the
 * German texts for the result the server appends to the PWA address after
 * the provider sent the browser back (`/?oauth=connected|error&...`).
 *
 * Kept free of DOM access so native clients can share it.
 */
import { ACCOUNT_ERROR_MESSAGES, type AccountErrorCode } from './mail'

export type OAuthProviderId = 'google' | 'microsoft'

export const OAUTH_PROVIDER_LABELS: Record<OAuthProviderId, string> = {
  google: 'Google',
  microsoft: 'Microsoft',
}

/** Response of GET /api/oauth/providers. */
export interface OAuthProvidersResponse {
  providers: Record<OAuthProviderId, boolean>
  redirectUri: string | null
}

export type OAuthResult =
  { ok: true; accountId: string | null; message: string } | { ok: false; message: string }

const REASONS: Record<string, string> = {
  state:
    'Die Anmeldung ist abgelaufen oder wurde schon verwendet. Bitte erneut auf „Anmelden“ klicken.',
  denied: 'Die Anmeldung wurde beim Anbieter abgebrochen oder der Zugriff nicht erlaubt.',
  not_configured: 'Die Anmeldung über diesen Anbieter ist auf dem Server nicht eingerichtet.',
  provider: 'Der Anbieter hat die Anmeldung abgelehnt. Bitte später erneut versuchen.',
  network: 'Der Anbieter war nicht erreichbar. Bitte später erneut versuchen.',
  invalid_grant: 'Der Anmeldecode war ungültig oder abgelaufen. Bitte erneut anmelden.',
  no_refresh_token:
    'Der Anbieter hat keinen dauerhaften Zugriff erteilt. Bitte erneut anmelden und alle Berechtigungen bestätigen.',
  no_email: 'Der Anbieter hat keine E-Mail-Adresse übermittelt.',
  imap: 'Anmeldung erfolgreich, aber der Mail-Abruf (IMAP) ist fehlgeschlagen.',
  smtp: 'Anmeldung erfolgreich, aber der Mail-Versand (SMTP) ist fehlgeschlagen.',
  wrong_account:
    'Es wurde ein anderes Postfach angemeldet als das dieses Kontos. Bitte mit der richtigen Adresse anmelden.',
  limit: 'Es sind bereits 20 Konten verbunden.',
}

/**
 * The OAuth result in a query string (`location.search`), or null when the
 * address carries none. Unknown reasons get a generic text.
 */
export function oauthResultFromQuery(search: string): OAuthResult | null {
  const params = new URLSearchParams(search)
  const result = params.get('oauth')
  if (result === 'connected') {
    return { ok: true, accountId: params.get('account'), message: 'Konto verbunden.' }
  }
  if (result !== 'error') return null
  const reason = params.get('reason') ?? ''
  let message = REASONS[reason] ?? 'Die Anmeldung ist fehlgeschlagen.'
  const code = params.get('code') as AccountErrorCode | null
  if ((reason === 'imap' || reason === 'smtp') && code && ACCOUNT_ERROR_MESSAGES[code]) {
    message += ` ${ACCOUNT_ERROR_MESSAGES[code]}`
  } else if (reason === 'imap') {
    message += ' Bei Gmail muss IMAP in den Gmail-Einstellungen aktiviert sein.'
  }
  return { ok: false, message }
}

/** The query string without the OAuth result parameters (for history.replaceState). */
export function withoutOAuthResult(search: string): string {
  const params = new URLSearchParams(search)
  for (const name of ['oauth', 'reason', 'code', 'account']) params.delete(name)
  const rest = params.toString()
  return rest ? `?${rest}` : ''
}
