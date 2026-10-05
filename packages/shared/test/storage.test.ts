import { describe, expect, it } from 'vitest'
import { formatByteSize, storageSummary, type AccountStorage } from '../src'

const base: AccountStorage = {
  accountId: 'a',
  messageCount: 0,
  storedMessageCount: 0,
  messageBytes: 0,
  uploadCount: 0,
  uploadBytes: 0,
  totalBytes: 0,
}

describe('storage usage formatting', () => {
  it('formats byte sizes in German units', () => {
    expect(formatByteSize(0)).toBe('0 B')
    expect(formatByteSize(1024)).toBe('1,0 KB')
    expect(formatByteSize(5.25 * 1024 * 1024)).toBe('5,3 MB')
    expect(formatByteSize(3 * 1024 ** 3)).toBe('3,0 GB')
    expect(formatByteSize(42 * 1024 ** 3)).toBe('42 GB')
  })

  it('summarizes an account with approximate size, counts and pending uploads', () => {
    expect(storageSummary(base)).toBe('ca. 0 B · 0 Nachrichten')
    expect(storageSummary({ ...base, messageCount: 1, messageBytes: 2048, totalBytes: 2048 })).toBe(
      'ca. 2,0 KB · 1 Nachricht',
    )
    expect(
      storageSummary({
        ...base,
        messageCount: 12345,
        messageBytes: 1536 * 1024 * 1024,
        uploadCount: 2,
        uploadBytes: 500,
        totalBytes: 1536 * 1024 * 1024 + 500,
      }),
    ).toBe('ca. 1,5 GB · 12.345 Nachrichten · 2 Anhänge (500 B) ausstehend')
  })
})
