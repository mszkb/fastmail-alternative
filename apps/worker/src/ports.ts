/**
 * Transport policy shared with the api (SSRF check, mandatory STARTTLS,
 * test mode): see `@fma/shared/mail-transport`.
 */
export { isSecurePort, mailTestMode } from '@fma/shared/mail-transport'
