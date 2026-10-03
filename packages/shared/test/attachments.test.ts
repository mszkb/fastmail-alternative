import { describe, expect, it } from 'vitest'
import {
  contentDisposition,
  formatByteSize,
  isInlineSafeType,
  normalizeContentType,
  sanitizeFilename,
} from '../src/attachments'

describe('attachment helpers', () => {
  it('normalizes MIME types', () => {
    expect(normalizeContentType('Image/PNG; name="x.png"')).toBe('image/png')
    expect(normalizeContentType('image/jpg')).toBe('image/jpeg')
    expect(normalizeContentType('not a type')).toBe('application/octet-stream')
    expect(normalizeContentType(undefined)).toBe('application/octet-stream')
  })

  it('allows inline display only for passive types', () => {
    expect(isInlineSafeType('image/png')).toBe(true)
    expect(isInlineSafeType('text/plain; charset=utf-8')).toBe(true)
    for (const type of [
      'text/html',
      'image/svg+xml',
      'application/javascript',
      'text/xml',
      'application/pdf',
      'application/octet-stream',
    ]) {
      expect(isInlineSafeType(type)).toBe(false)
    }
  })

  it('cleans file names', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd')
    expect(sanitizeFilename('C:\\Users\\x\\a.txt')).toBe('a.txt')
    expect(sanitizeFilename('a\r\nb"c.txt')).toBe('abc.txt')
    expect(sanitizeFilename('..')).toBe('anhang')
    expect(sanitizeFilename('', 'anhang-2')).toBe('anhang-2')
    expect(sanitizeFilename('x'.repeat(300))).toHaveLength(255)
  })

  it('builds Content-Disposition with an RFC 5987 file name', () => {
    expect(contentDisposition('attachment', 'Grüße (1).pdf')).toBe(
      `attachment; filename="Gr__e (1).pdf"; filename*=UTF-8''Gr%C3%BC%C3%9Fe%20%281%29.pdf`,
    )
    expect(contentDisposition('inline', 'a"b.png')).toBe(
      `inline; filename="ab.png"; filename*=UTF-8''ab.png`,
    )
  })

  it('formats sizes', () => {
    expect(formatByteSize(512)).toBe('512 B')
    expect(formatByteSize(1536)).toBe('1,5 KB')
    expect(formatByteSize(14 * 1024 * 1024)).toBe('14 MB')
  })
})
