/**
 * Cross-implementation test vectors for the PHP port (ADR-0013, #99).
 *
 * - `apps/server-php/tests/fixtures/crypto-vectors-node.json` is written by
 *   this file (FMA_WRITE_VECTORS=1 pnpm --filter @fma/crypto test) and
 *   decrypted by the PHP unit tests.
 * - `apps/server-php/tests/fixtures/crypto-vectors-php.json` is written by
 *   `php apps/server-php/bin/crypto-vectors.php` and decrypted here.
 *
 * Both fixtures use throwaway keys; they contain no real data.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { Readable, type Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  BACKUP_CHUNK_BYTES,
  createBackupDecryptStream,
  createBackupEncryptStream,
  decryptBytes,
  decryptField,
  deriveHmacKey,
  draftContentAad,
  encryptBytes,
  encryptField,
  hmacValue,
  loadMasterKey,
  messageFieldAad,
  outboxContentAad,
  pushKeysAad,
  unwrapDataKey,
  uploadFieldAad,
  wrapDataKey,
} from '../src/index'

const fixtureDir = fileURLToPath(
  new URL('../../../apps/server-php/tests/fixtures/', import.meta.url),
)

interface Vectors {
  generator: 'node' | 'php'
  masterKey: string
  keyId: string
  wrappedDek: string
  dataKey: string
  fields: { aad: string; plaintext: string; envelope: string }[]
  bytes: { aad: string; plaintext: string; envelope: string }
  legacyBytes: { aad: string; plaintext: string; envelope: string }
  hmac: { context: string; value: string; expected: string }
  backup: { length: number; envelope: string }
}

const MESSAGE_ID = '0b6f3c1e-8a2d-4c5b-9e7f-1a2b3c4d5e6f'
const ACCOUNT_ID = '5f0e6d7c-1b2a-4938-8776-5a4b3c2d1e0f'

/** Every AAD context in use, with a non-ASCII plaintext each. */
const FIELD_CASES: { aad: string; plaintext: string }[] = [
  { aad: messageFieldAad('subject', MESSAGE_ID), plaintext: 'Grüße aus Köln 🎉' },
  {
    aad: messageFieldAad('from', MESSAGE_ID),
    plaintext: '{"name":"Zoë","address":"zoe@example.org"}',
  },
  {
    aad: messageFieldAad('recipients', MESSAGE_ID),
    plaintext: '{"to":[{"address":"a@example.org"}]}',
  },
  { aad: messageFieldAad('snippet', MESSAGE_ID), plaintext: 'Vorschau – mit Gedankenstrich' },
  { aad: messageFieldAad('body', MESSAGE_ID), plaintext: '<p>Hallo&nbsp;Welt</p>' },
  { aad: messageFieldAad('text', MESSAGE_ID), plaintext: 'Hallo Welt\r\n' },
  { aad: `mail_account.credential:${ACCOUNT_ID}`, plaintext: '{"imapPassword":"pässwört"}' },
  { aad: outboxContentAad(MESSAGE_ID), plaintext: '{"subject":"Ä"}' },
  { aad: draftContentAad(MESSAGE_ID), plaintext: '' },
  { aad: uploadFieldAad('filename', MESSAGE_ID), plaintext: 'Rechnung März.pdf' },
  {
    aad: uploadFieldAad('content', MESSAGE_ID),
    plaintext: 'not used as field, still a valid context',
  },
  {
    aad: pushKeysAad('https://push.example.org/send/abc?x=1'),
    plaintext: '{"p256dh":"k","auth":"a"}',
  },
]

/** Deterministic binary plaintext covering all byte values. */
function patternBytes(length: number): Buffer {
  const buf = Buffer.alloc(length)
  for (let i = 0; i < length; i++) buf[i] = (i * 31 + 7) & 0xff
  return buf
}

const BACKUP_LENGTH = BACKUP_CHUNK_BYTES + 1000

async function collect(source: Buffer, transform: Transform): Promise<Buffer> {
  const out: Buffer[] = []
  await pipeline(Readable.from([source]), transform, async (stream: AsyncIterable<unknown>) => {
    for await (const chunk of stream) out.push(chunk as Buffer)
  })
  return Buffer.concat(out)
}

async function generate(): Promise<Vectors> {
  const masterKey = Buffer.alloc(32)
  for (let i = 0; i < 32; i++) masterKey[i] = i * 7 + 3
  const dataKey = Buffer.alloc(32)
  for (let i = 0; i < 32; i++) dataKey[i] = 255 - i * 5
  const raw = patternBytes(1000)
  const bytesAad = `message.raw:${MESSAGE_ID}`
  return {
    generator: 'node',
    masterKey: masterKey.toString('base64'),
    keyId: 'v1',
    wrappedDek: wrapDataKey(masterKey, dataKey, 'v1'),
    dataKey: dataKey.toString('base64'),
    fields: FIELD_CASES.map((c) => ({ ...c, envelope: encryptField(dataKey, c.plaintext, c.aad) })),
    bytes: {
      aad: bytesAad,
      plaintext: raw.toString('base64'),
      envelope: encryptBytes(dataKey, raw, bytesAad).toString('base64'),
    },
    // Legacy raw-mail form: the bytes as a latin1 string in a field envelope.
    legacyBytes: {
      aad: bytesAad,
      plaintext: raw.toString('base64'),
      envelope: encryptField(dataKey, raw.toString('latin1'), bytesAad),
    },
    hmac: {
      context: 'thread',
      value: 'Re: Grüße',
      expected: hmacValue(deriveHmacKey(dataKey, 'thread'), 'Re: Grüße'),
    },
    backup: {
      length: BACKUP_LENGTH,
      envelope: (
        await collect(patternBytes(BACKUP_LENGTH), createBackupEncryptStream(masterKey))
      ).toString('base64'),
    },
  }
}

async function verify(v: Vectors): Promise<void> {
  const masterKey = loadMasterKey(v.masterKey)
  const { dataKey, keyId } = unwrapDataKey(masterKey, v.wrappedDek)
  expect(keyId).toBe(v.keyId)
  expect(dataKey.toString('base64')).toBe(v.dataKey)
  expect(v.fields.map((f) => f.aad)).toEqual(FIELD_CASES.map((c) => c.aad))
  for (const field of v.fields) {
    expect(decryptField(dataKey, field.envelope, field.aad)).toBe(field.plaintext)
  }
  const raw = Buffer.from(v.bytes.plaintext, 'base64')
  expect(decryptBytes(dataKey, Buffer.from(v.bytes.envelope, 'base64'), v.bytes.aad)).toEqual(raw)
  expect(
    decryptBytes(dataKey, Buffer.from(v.legacyBytes.envelope, 'latin1'), v.legacyBytes.aad),
  ).toEqual(Buffer.from(v.legacyBytes.plaintext, 'base64'))
  expect(hmacValue(deriveHmacKey(dataKey, v.hmac.context), v.hmac.value)).toBe(v.hmac.expected)
  const backup = await collect(
    Buffer.from(v.backup.envelope, 'base64'),
    createBackupDecryptStream(masterKey),
  )
  expect(backup.equals(patternBytes(v.backup.length))).toBe(true)
}

describe('PHP compatibility vectors', () => {
  it('verifies freshly generated vectors (self-check)', async () => {
    const vectors = await generate()
    await verify(vectors)
    if (process.env.FMA_WRITE_VECTORS === '1') {
      writeFileSync(
        `${fixtureDir}crypto-vectors-node.json`,
        `${JSON.stringify(vectors, null, 2)}\n`,
      )
    }
  })

  it('decrypts what the PHP implementation encrypted', async () => {
    const vectors = JSON.parse(
      readFileSync(`${fixtureDir}crypto-vectors-php.json`, 'utf8'),
    ) as Vectors
    expect(vectors.generator).toBe('php')
    await verify(vectors)
  })

  it('rejects the PHP vectors with a wrong AAD', () => {
    const vectors = JSON.parse(
      readFileSync(`${fixtureDir}crypto-vectors-php.json`, 'utf8'),
    ) as Vectors
    const { dataKey } = unwrapDataKey(loadMasterKey(vectors.masterKey), vectors.wrappedDek)
    const field = vectors.fields[0]!
    expect(() => decryptField(dataKey, field.envelope, `${field.aad}x`)).toThrow()
  })
})
