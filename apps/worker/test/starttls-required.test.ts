/**
 * Mandatory STARTTLS (ASVS 9.2.2, audit M4): on plain ports the client must
 * refuse to authenticate when the server does not offer STARTTLS (or an
 * attacker stripped it). Fake IMAP/SMTP servers record every command; the
 * production policy is forced via `insecureTransport: false` (the test env
 * sets MAIL_INSECURE_TRANSPORT=1 for GreenMail), private hosts stay allowed
 * because the fakes listen on loopback.
 */
import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'
import {
  imapTransportOptions,
  isStartTlsUnavailable,
  smtpTransportOptions,
  type MailTransportPolicy,
} from '@fma/shared/mail-transport'
import { classifyAccountError } from '../src/account-health'
import { classifySmtpError } from '../src/jobs/send-message'

const PRODUCTION_TLS: MailTransportPolicy = { allowPrivateHosts: true, insecureTransport: false }

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

async function listen(server: net.Server): Promise<number> {
  servers.push(server)
  server.on('connection', (socket) => sockets.push(socket))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as net.AddressInfo).port
}

/** IMAP server without STARTTLS; `starttls: 'reject'` advertises it but answers NO. */
function fakeImap(commands: string[], starttls: 'absent' | 'reject'): net.Server {
  const caps = starttls === 'reject' ? 'IMAP4rev1 STARTTLS' : 'IMAP4rev1'
  return net.createServer((socket) => {
    socket.write('* OK IMAP4rev1 ready\r\n')
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1')
      let index: number
      while ((index = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        const [tag, command = ''] = line.split(' ')
        if (!tag) continue
        const verb = command.toUpperCase()
        commands.push(verb)
        if (verb === 'CAPABILITY') socket.write(`* CAPABILITY ${caps}\r\n${tag} OK done\r\n`)
        else if (verb === 'LOGIN' || verb === 'AUTHENTICATE')
          socket.write(`${tag} OK logged in\r\n`)
        else if (verb === 'LOGOUT') socket.end(`* BYE\r\n${tag} OK bye\r\n`)
        else socket.write(`${tag} NO not available\r\n`)
      }
    })
  })
}

/** SMTP server that offers AUTH but no STARTTLS (or refuses it with 502). */
function fakeSmtp(commands: string[], starttls: 'absent' | 'reject'): net.Server {
  return net.createServer((socket) => {
    socket.write('220 fake.test ESMTP\r\n')
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1')
      let index: number
      while ((index = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        const verb = (line.split(' ')[0] ?? '').toUpperCase()
        commands.push(verb)
        if (verb === 'EHLO') {
          const tls = starttls === 'reject' ? '250-STARTTLS\r\n' : ''
          socket.write(`250-fake.test\r\n${tls}250 AUTH PLAIN LOGIN\r\n`)
        } else if (verb === 'STARTTLS') socket.write('502 5.5.1 not implemented\r\n')
        else if (verb === 'AUTH') socket.write('235 2.7.0 accepted\r\n')
        else if (verb === 'QUIT') socket.end('221 bye\r\n')
        else socket.write('502 5.5.2 unknown\r\n')
      }
    })
  })
}

describe('mandatory STARTTLS', () => {
  it.each(['absent', 'reject'] as const)(
    'IMAP: refuses to log in when STARTTLS is %s',
    async (starttls) => {
      const commands: string[] = []
      const port = await listen(fakeImap(commands, starttls))
      const options = await imapTransportOptions(
        { host: '127.0.0.1', port, secure: false },
        PRODUCTION_TLS,
      )
      expect(options.doSTARTTLS).toBe(true)

      const client = new ImapFlow({
        ...options,
        auth: { user: 'user@example.com', pass: 'secret-password' },
        logger: false,
      })
      client.on('error', () => {})
      const error = await client.connect().then(
        () => null,
        (err: unknown) => err,
      )
      client.close()

      expect(error).not.toBeNull()
      expect(isStartTlsUnavailable(error)).toBe(true)
      expect(classifyAccountError(error)).toEqual({ code: 'TLS_REQUIRED', kind: 'unreachable' })
      expect(commands).not.toContain('LOGIN')
      expect(commands).not.toContain('AUTHENTICATE')
    },
  )

  it.each(['absent', 'reject'] as const)(
    'SMTP: refuses to authenticate when STARTTLS is %s',
    async (starttls) => {
      const commands: string[] = []
      const port = await listen(fakeSmtp(commands, starttls))
      const options = await smtpTransportOptions(
        { host: '127.0.0.1', port, secure: false },
        PRODUCTION_TLS,
      )
      expect(options.requireTLS).toBe(true)

      const transporter = nodemailer.createTransport({
        ...options,
        auth: { user: 'user@example.com', pass: 'secret-password' },
      })
      const error = await transporter.verify().then(
        () => null,
        (err: unknown) => err,
      )
      transporter.close()

      expect(error).not.toBeNull()
      expect(isStartTlsUnavailable(error)).toBe(true)
      expect(classifySmtpError(error)).toEqual({ code: 'TLS_REQUIRED', permanent: false })
      expect(classifyAccountError(error)?.code).toBe('TLS_REQUIRED')
      expect(commands).not.toContain('AUTH')
    },
  )
})

describe('transport options', () => {
  const lookup = async () => [
    { address: '2606:4700::1111', family: 6 },
    { address: '93.184.216.34', family: 4 },
  ]

  it('connects to the checked address and verifies TLS against the hostname', async () => {
    const policy = { insecureTransport: false, allowPrivateHosts: false, lookup }
    const imap = await imapTransportOptions(
      { host: 'imap.example.com', port: 143, secure: false },
      policy,
    )
    expect(imap).toEqual({
      host: '93.184.216.34',
      port: 143,
      secure: false,
      servername: 'imap.example.com',
      tls: { servername: 'imap.example.com' },
      doSTARTTLS: true,
    })
    const smtp = await smtpTransportOptions(
      { host: 'smtp.example.com', port: 465, secure: true },
      policy,
    )
    expect(smtp).toEqual({
      host: '93.184.216.34',
      port: 465,
      secure: true,
      servername: 'smtp.example.com',
      tls: { servername: 'smtp.example.com' },
    })
  })

  it('rejects hosts resolving to internal addresses before connecting', async () => {
    const internal = async () => [{ address: '10.0.0.5', family: 4 }]
    await expect(
      imapTransportOptions(
        { host: 'rebind.example', port: 993, secure: true },
        { allowPrivateHosts: false, lookup: internal },
      ),
    ).rejects.toMatchObject({ code: 'PRIVATE_HOST_BLOCKED' })
    await expect(
      smtpTransportOptions(
        { host: '0:0:0:0:0:ffff:127.0.0.1', port: 587, secure: false },
        { allowPrivateHosts: false },
      ),
    ).rejects.toMatchObject({ code: 'PRIVATE_HOST_BLOCKED' })
  })

  it('keeps the GreenMail exception in test mode only', async () => {
    const options = await imapTransportOptions(
      { host: '127.0.0.1', port: 3143, secure: false },
      { allowPrivateHosts: true, insecureTransport: true },
    )
    expect(options).toMatchObject({ doSTARTTLS: false, tls: { rejectUnauthorized: false } })
  })
})
