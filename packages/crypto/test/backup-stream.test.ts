import { randomBytes } from 'node:crypto'
import { Readable, type Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { describe, expect, it } from 'vitest'
import {
  BACKUP_CHUNK_BYTES,
  BackupDecryptError,
  createBackupDecryptStream,
  createBackupEncryptStream,
} from '../src/index'

const masterKey = Buffer.alloc(32, 7)
const otherMasterKey = Buffer.alloc(32, 9)

async function collect(source: Buffer[], transform: Transform): Promise<Buffer> {
  const out: Buffer[] = []
  await pipeline(Readable.from(source), transform, async (stream: AsyncIterable<unknown>) => {
    for await (const chunk of stream) out.push(chunk as Buffer)
  })
  return Buffer.concat(out)
}

async function encrypt(plaintext: Buffer, pieces = 7): Promise<Buffer> {
  // Feed in uneven pieces to exercise the chunk buffering.
  const parts: Buffer[] = []
  const step = Math.max(1, Math.ceil(plaintext.length / pieces))
  for (let i = 0; i < plaintext.length; i += step) parts.push(plaintext.subarray(i, i + step))
  return collect(parts, createBackupEncryptStream(masterKey))
}

async function decrypt(ciphertext: Buffer, key = masterKey): Promise<Buffer> {
  const parts: Buffer[] = []
  for (let i = 0; i < ciphertext.length; i += 10_000) parts.push(ciphertext.subarray(i, i + 10_000))
  return collect(parts, createBackupDecryptStream(key))
}

describe('backup stream encryption', () => {
  it.each([0, 1, BACKUP_CHUNK_BYTES, BACKUP_CHUNK_BYTES + 1, 3 * BACKUP_CHUNK_BYTES + 17])(
    'round-trips %i bytes',
    async (size) => {
      const plaintext = randomBytes(size)
      const ciphertext = await encrypt(plaintext)
      expect(ciphertext.subarray(0, 7).toString('ascii')).toBe('fma.bk1')
      expect(await decrypt(ciphertext)).toEqual(plaintext)
    },
  )

  it('does not contain the plaintext and uses a fresh salt per backup', async () => {
    const plaintext = Buffer.from('imap.example.org secret-folder-name '.repeat(100))
    const a = await encrypt(plaintext)
    const b = await encrypt(plaintext)
    expect(a.includes(Buffer.from('imap.example.org'))).toBe(false)
    expect(a.equals(b)).toBe(false)
  })

  it('fails with a wrong master key', async () => {
    const ciphertext = await encrypt(randomBytes(2 * BACKUP_CHUNK_BYTES))
    await expect(decrypt(ciphertext, otherMasterKey)).rejects.toBeInstanceOf(BackupDecryptError)
  })

  it('detects truncation at a chunk boundary and modified data', async () => {
    const ciphertext = await encrypt(randomBytes(2 * BACKUP_CHUNK_BYTES + 5))
    const header = 7 + 16
    const truncated = ciphertext.subarray(0, header + BACKUP_CHUNK_BYTES + 16)
    await expect(decrypt(truncated)).rejects.toBeInstanceOf(BackupDecryptError)
    const modified = Buffer.from(ciphertext)
    modified[header + 100] = modified[header + 100]! ^ 1
    await expect(decrypt(modified)).rejects.toBeInstanceOf(BackupDecryptError)
  })

  it('rejects files that are not backups', async () => {
    await expect(decrypt(Buffer.from('PGDMP not encrypted at all, sorry'))).rejects.toThrow(
      /not a backup file/,
    )
  })
})
