/**
 * Transport policy shared with the api (SSRF check, mandatory STARTTLS,
 * MAIL_INSECURE_TRANSPORT test mode). see `@fma/shared/mail-transport`.
 */
export { isSecurePort, mailTestMode } from '@fma/shared/mail-transport'
