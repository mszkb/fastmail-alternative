/**
 * Connection test (api) with mandatory STARTTLS (audit M4) and redacted
 * logging (audit N4): fake servers without STARTTLS must never receive the
 * password, the user gets TLS_REQUIRED, the log only error name/code.
 */
import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { testImap, testSmtp } from '../src/mail/connection-test'

const servers: net.Server[] = []
const sockets: net.Socket[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy()
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  )
})

/** Line-based fake server; `reply` answers each received line. */
async function fake(
  greeting: string,
  reply: (line: string) => string,
  received: string[],
): Promise<number> {
  const server = net.createServer((socket) => {
    sockets.push(socket)
    socket.write(greeting)
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1')
      let index: number
      while ((index = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        received.push(line)
        socket.write(reply(line))
      }
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as net.AddressInfo).port
}

const policy = { allowPrivateHosts: true, insecureTransport: false }
const PASSWORD = 'never-on-the-wire'

describe('connection test: mandatory STARTTLS', () => {
  it('IMAP without STARTTLS -> TLS_REQUIRED, no LOGIN, redacted log', async () => {
    const received: string[] = []
    const port = await fake(
      '* OK [ALERT] internal banner user@example.com\r\n',
      (line) => {
        const [tag, verb = ''] = line.split(' ')
        if (verb.toUpperCase() === 'CAPABILITY')
          return `* CAPABILITY IMAP4rev1\r\n${tag} OK done\r\n`
        return `${tag} OK fine\r\n`
      },
      received,
    )
    const logged: Record<string, unknown>[] = []
    const result = await testImap(
      { host: '127.0.0.1', port, secure: false, user: 'user@example.com', password: PASSWORD },
      { policy, log: { warn: (obj) => logged.push(obj) } },
    )
    expect(result).toMatchObject({ ok: false, code: 'TLS_REQUIRED' })
    expect(result.message).toContain('STARTTLS')
    expect(received.join('\n')).not.toContain(PASSWORD)
    expect(received.some((line) => /\bLOGIN\b|\bAUTHENTICATE\b/i.test(line))).toBe(false)
    expect(logged).toEqual([
      { stage: 'imap', code: 'TLS_REQUIRED', errName: 'Error', errCode: undefined },
    ])
  })

  it('SMTP without STARTTLS -> TLS_REQUIRED, no AUTH', async () => {
    const received: string[] = []
    const port = await fake(
      '220 fake ESMTP\r\n',
      (line) => {
        const verb = (line.split(' ')[0] ?? '').toUpperCase()
        if (verb === 'EHLO') return '250-fake\r\n250 AUTH PLAIN LOGIN\r\n'
        if (verb === 'AUTH') return '235 accepted\r\n'
        return '502 unknown\r\n'
      },
      received,
    )
    const result = await testSmtp(
      { host: '127.0.0.1', port, secure: false, user: 'user@example.com', password: PASSWORD },
      { policy },
    )
    expect(result).toMatchObject({ ok: false, code: 'TLS_REQUIRED' })
    expect(received.some((line) => /^AUTH\b/i.test(line))).toBe(false)
  })

  it('never returns provider texts for unknown failures', async () => {
    const received: string[] = []
    const port = await fake('* BYE secret internal banner\r\n', () => '', received)
    const result = await testImap(
      { host: '127.0.0.1', port, secure: false, user: 'u', password: PASSWORD },
      { policy },
    )
    expect(result.ok).toBe(false)
    expect(result.message).not.toContain('secret internal banner')
  })
})
