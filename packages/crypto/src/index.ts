/**
 * Envelope encryption for credentials and mail contents (data model: see
 * docs/architecture/data-model.md#verschlüsselung).
 *
 * Design:
 * - One data key (DEK) per mail account (and per user for user-related
 *   secrets), stored wrapped with the instance master key (KEK) that comes
 *   exclusively from the environment (ADR: secrets never in DB or repo).
 * - Fields are encrypted with AES-256-GCM (AEAD), one fresh nonce per field,
 *   with the field context as AAD (e.g. `mail_account.credential:<id>`).
 * - Master key rotation only re-wraps DEKs; contents stay untouched
 *   (see docs/process/key-rotation.md).
 * - Deleting an account deletes its DEK -> remaining ciphertexts (e.g. in
 *   backups) become unreadable (crypto-shredding).
 *
 * Envelope formats (ASCII, safe for bytea/text columns):
 * - field: `fma.f1.` + base64(nonce[12] | ciphertext | tag[16])
 * - wrapped DEK: `fma.k1.` + base64(keyIdLen[1] | keyId | nonce[12] | ct | tag[16])
 */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const KEY_BYTES = 32
const NONCE_BYTES = 12
const TAG_BYTES = 16
const FIELD_PREFIX = 'fma.f1.'
const WRAPPED_PREFIX = 'fma.k1.'

/** Validates and decodes the base64 master key from the environment. */
export function loadMasterKey(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, 'base64')
  if (key.length !== KEY_BYTES) {
    throw new Error(`MASTER_KEY must be ${KEY_BYTES} bytes base64-encoded, got ${key.length} bytes`)
  }
  return key
}

/** Generates a fresh random data key (DEK). */
export function generateDataKey(): Buffer {
  return randomBytes(KEY_BYTES)
}

/**
 * Wraps a data key with the master key. `keyId` identifies the master key
 * version (e.g. "v1") so rotation can find and re-wrap old DEKs.
 */
export function wrapDataKey(masterKey: Buffer, dataKey: Buffer, keyId: string): string {
  if (dataKey.length !== KEY_BYTES) {
    throw new Error(`data key must be ${KEY_BYTES} bytes, got ${dataKey.length}`)
  }
  const keyIdBuf = Buffer.from(keyId, 'utf8')
  if (keyIdBuf.length < 1 || keyIdBuf.length > 255) {
    throw new Error('keyId must be 1-255 bytes')
  }
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv(ALGORITHM, masterKey, nonce)
  cipher.setAAD(aadForWrappedKey(keyId))
  const ct = Buffer.concat([cipher.update(dataKey), cipher.final(), cipher.getAuthTag()])
  return (
    WRAPPED_PREFIX +
    Buffer.concat([Buffer.from([keyIdBuf.length]), keyIdBuf, nonce, ct]).toString('base64')
  )
}

/** Unwraps a data key; returns the DEK and the keyId it was wrapped with. */
export function unwrapDataKey(
  masterKey: Buffer,
  wrapped: string,
): { dataKey: Buffer; keyId: string } {
  expectPrefix(wrapped, WRAPPED_PREFIX)
  const buf = Buffer.from(wrapped.slice(WRAPPED_PREFIX.length), 'base64')
  const keyIdLen = buf[0]
  if (!keyIdLen) throw new Error('invalid wrapped key: empty keyId')
  const keyId = buf.subarray(1, 1 + keyIdLen).toString('utf8')
  const nonce = buf.subarray(1 + keyIdLen, 1 + keyIdLen + NONCE_BYTES)
  const ct = buf.subarray(1 + keyIdLen + NONCE_BYTES)
  const decipher = createDecipheriv(ALGORITHM, masterKey, nonce)
  decipher.setAAD(aadForWrappedKey(keyId))
  decipher.setAuthTag(ct.subarray(ct.length - TAG_BYTES))
  const dataKey = Buffer.concat([
    decipher.update(ct.subarray(0, ct.length - TAG_BYTES)),
    decipher.final(),
  ])
  if (dataKey.length !== KEY_BYTES) throw new Error('invalid wrapped key: wrong DEK length')
  return { dataKey, keyId }
}

/** Encrypts a UTF-8 field value. `aad` binds the ciphertext to its context. */
export function encryptField(dataKey: Buffer, plaintext: string, aad: string): string {
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv(ALGORITHM, dataKey, nonce)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const ct = Buffer.concat([
    cipher.update(Buffer.from(plaintext, 'utf8')),
    cipher.final(),
    cipher.getAuthTag(),
  ])
  return FIELD_PREFIX + Buffer.concat([nonce, ct]).toString('base64')
}

/** Decrypts a field; throws if dataKey, aad or ciphertext do not match. */
export function decryptField(dataKey: Buffer, envelope: string, aad: string): string {
  expectPrefix(envelope, FIELD_PREFIX)
  const buf = Buffer.from(envelope.slice(FIELD_PREFIX.length), 'base64')
  const nonce = buf.subarray(0, NONCE_BYTES)
  const ct = buf.subarray(NONCE_BYTES)
  const decipher = createDecipheriv(ALGORITHM, dataKey, nonce)
  decipher.setAAD(Buffer.from(aad, 'utf8'))
  decipher.setAuthTag(ct.subarray(ct.length - TAG_BYTES))
  return Buffer.concat([
    decipher.update(ct.subarray(0, ct.length - TAG_BYTES)),
    decipher.final(),
  ]).toString('utf8')
}

/**
 * Derives a key for HMACs (e.g. subject_hash for threading) from a DEK.
 * Independent from the encryption key: compromising one does not expose the other.
 */
export function deriveHmacKey(dataKey: Buffer, context: string): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      dataKey,
      Buffer.from(context, 'utf8'),
      Buffer.from('fma-hmac-v1', 'utf8'),
      32,
    ),
  )
}

/** HMAC-SHA256 over a value (e.g. a subject) with a derived key, hex-encoded. */
export function hmacValue(hmacKey: Buffer, value: string): string {
  return createHmac('sha256', hmacKey).update(value, 'utf8').digest('hex')
}

/**
 * Unwraps an account DEK as stored in `mail_account.wrapped_dek` (bytea or
 * text) with the base64 master key from the environment. Shared by api and
 * worker; the result must never be logged or persisted.
 */
export function unwrapAccountKey(masterKeyBase64: string, wrappedDek: Buffer | string): Buffer {
  const wrapped = Buffer.isBuffer(wrappedDek) ? wrappedDek.toString('utf8') : wrappedDek
  return unwrapDataKey(loadMasterKey(masterKeyBase64), wrapped).dataKey
}

/** Message fields encrypted with the account DEK (see migration 0004). */
export type MessageField = 'subject' | 'from' | 'recipients' | 'snippet' | 'body' | 'text'

/** AAD context of an encrypted message field: `message.<field>:<message id>`. */
export function messageFieldAad(field: MessageField, messageId: string): string {
  return `message.${field}:${messageId}`
}

/** AAD context of an outbox message's encrypted content (see migration 0006). */
export function outboxContentAad(outboxId: string): string {
  return `outbox_message.content:${outboxId}`
}

/**
 * AAD context of a push subscription's encrypted keys (p256dh/auth,
 * migration 0010), encrypted with the user DEK and bound to the endpoint
 * (unique per subscription, stable across upserts).
 */
export function pushKeysAad(endpoint: string): string {
  return `push_subscription.keys:${endpoint}`
}

function aadForWrappedKey(keyId: string): Buffer {
  return Buffer.from(`fma.wrapped-dek:${keyId}`, 'utf8')
}

function expectPrefix(value: string, prefix: string): void {
  if (!value.startsWith(prefix)) {
    throw new Error(`invalid envelope: expected prefix ${prefix}`)
  }
}
