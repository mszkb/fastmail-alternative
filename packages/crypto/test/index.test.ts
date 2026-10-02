import { describe, expect, it } from 'vitest'
import {
  decryptField,
  deriveHmacKey,
  encryptField,
  generateDataKey,
  hmacValue,
  loadMasterKey,
  unwrapDataKey,
  wrapDataKey,
} from '../src/index'

const masterKey = Buffer.alloc(32, 7)
const otherMasterKey = Buffer.alloc(32, 9)

describe('loadMasterKey', () => {
  it('accepts a valid 32-byte base64 key', () => {
    const base64 = masterKey.toString('base64')
    expect(loadMasterKey(base64)).toEqual(masterKey)
  })

  it('rejects keys with the wrong length', () => {
    expect(() => loadMasterKey(Buffer.alloc(16).toString('base64'))).toThrow(/32 bytes/)
  })
})

describe('data key wrap/unwrap', () => {
  it('round-trips a DEK and keeps the keyId', () => {
    const dek = generateDataKey()
    const wrapped = wrapDataKey(masterKey, dek, 'v1')
    const result = unwrapDataKey(masterKey, wrapped)
    expect(result.dataKey).toEqual(dek)
    expect(result.keyId).toBe('v1')
  })

  it('fails with a different master key', () => {
    const wrapped = wrapDataKey(masterKey, generateDataKey(), 'v1')
    expect(() => unwrapDataKey(otherMasterKey, wrapped)).toThrow()
  })

  it('fails on a tampered envelope', () => {
    const wrapped = wrapDataKey(masterKey, generateDataKey(), 'v1')
    const tampered = wrapped.slice(0, -4) + 'AAAA'
    expect(() => unwrapDataKey(masterKey, tampered)).toThrow()
  })

  it('rotation: unwrap with old key, re-wrap with new key and new keyId', () => {
    const dek = generateDataKey()
    const oldWrapped = wrapDataKey(masterKey, dek, 'v1')
    const unwrapped = unwrapDataKey(masterKey, oldWrapped)
    const newWrapped = wrapDataKey(otherMasterKey, unwrapped.dataKey, 'v2')
    expect(unwrapDataKey(otherMasterKey, newWrapped).dataKey).toEqual(dek)
  })
})

describe('field encryption', () => {
  const dek = generateDataKey()
  const aad = 'mail_account.credential:some-account-id'

  it('round-trips UTF-8 content', () => {
    const envelope = encryptField(dek, 'hunter2 🔐', aad)
    expect(decryptField(dek, envelope, aad)).toBe('hunter2 🔐')
  })

  it('uses a fresh nonce per encryption', () => {
    const a1 = encryptField(dek, 'same', aad)
    const a2 = encryptField(dek, 'same', aad)
    expect(a1).not.toEqual(a2)
  })

  it('fails with the wrong AAD (context binding)', () => {
    const envelope = encryptField(dek, 'secret', aad)
    expect(() => decryptField(dek, envelope, 'other.context:id')).toThrow()
  })

  it('fails with the wrong data key', () => {
    const envelope = encryptField(dek, 'secret', aad)
    expect(() => decryptField(generateDataKey(), envelope, aad)).toThrow()
  })

  it('fails on tampered ciphertext', () => {
    const envelope = encryptField(dek, 'secret', aad)
    expect(() => decryptField(dek, envelope.slice(0, -3) + 'AAA', aad)).toThrow()
  })
})

describe('HMAC derivation', () => {
  it('is deterministic for the same context and differs between contexts', () => {
    const dek = generateDataKey()
    const k1 = deriveHmacKey(dek, 'subject')
    const k2 = deriveHmacKey(dek, 'subject')
    const k3 = deriveHmacKey(dek, 'from')
    expect(k1).toEqual(k2)
    expect(k1).not.toEqual(k3)
    expect(hmacValue(k1, 'Re: hello')).toBe(hmacValue(k2, 'Re: hello'))
  })
})
