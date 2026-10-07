import net from 'node:net'
import type { Page } from '@playwright/test'

export const USER = { email: 'owner@example.test', password: 'e2e-password-1' }
export const SETUP_CODE = process.env.SETUP_TOKEN ?? 'e2e-setup-code'

const run = process.env.E2E_RUN!
/** GreenMail creates unknown recipients on delivery (password = address). */
export const MAILBOX_A = `e2e-a-${run}@example.com`
export const MAILBOX_B = `e2e-b-${run}@example.com`
export const ACCOUNT_A = `Privat ${run}`
export const ACCOUNT_B = `Arbeit ${run}`

export const mailHost = process.env.E2E_MAIL_HOST ?? process.env.GREENMAIL_HOST ?? '127.0.0.1'
export const imapPort = Number(process.env.GREENMAIL_IMAP_PORT ?? 3143)
export const smtpPort = Number(process.env.GREENMAIL_SMTP_PORT ?? 3025)

// 1x1 PNG for the inline image.
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** Plain text message. */
export function textMail(to: string, subject: string, text: string, date = new Date()): string {
  return [
    'From: Alice <alice@example.org>',
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${Math.random().toString(36).slice(2)}@example.org>`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    text,
  ].join('\r\n')
}

/** HTML message with an inline image (cid:) and a PDF attachment. */
export function richMail(to: string, subject: string): string {
  return [
    'From: Bob <bob@example.org>',
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${Math.random().toString(36).slice(2)}@example.org>`,
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="mixed"',
    '',
    '--mixed',
    'Content-Type: multipart/related; boundary="related"',
    '',
    '--related',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>Bild im Text: <img src="cid:logo1" alt="Logo" width="20" height="20"></p>',
    '--related',
    'Content-Type: image/png; name="logo.png"',
    'Content-Transfer-Encoding: base64',
    'Content-ID: <logo1>',
    'Content-Disposition: inline; filename="logo.png"',
    '',
    PNG,
    '--related--',
    '--mixed',
    'Content-Type: application/pdf; name="rechnung.pdf"',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="rechnung.pdf"',
    '',
    Buffer.from('%PDF-1.4\n%e2e\n').toString('base64'),
    '--mixed--',
  ].join('\r\n')
}

/** Minimal SMTP client: delivers one message to GreenMail. */
export async function deliver(to: string, message: string): Promise<void> {
  const socket = net.connect(smtpPort, mailHost)
  socket.setEncoding('utf8')
  let buffer = ''
  const reply = () =>
    new Promise<string>((resolve, reject) => {
      const check = () => {
        const lines = buffer.split('\r\n')
        const done = lines.findIndex((line) => /^\d{3} /.test(line))
        if (done === -1) return false
        buffer = lines.slice(done + 1).join('\r\n')
        const line = lines[done]!
        if (line.startsWith('4') || line.startsWith('5')) reject(new Error(`SMTP: ${line}`))
        else resolve(line)
        return true
      }
      if (check()) return
      const onData = (chunk: string) => {
        buffer += chunk
        if (check()) socket.off('data', onData)
      }
      socket.on('data', onData)
      socket.once('error', reject)
    })
  await reply()
  for (const command of ['EHLO e2e', 'MAIL FROM:<sender@example.org>', `RCPT TO:<${to}>`, 'DATA']) {
    socket.write(`${command}\r\n`)
    await reply()
  }
  socket.write(`${message.replace(/^\./gm, '..')}\r\n.\r\n`)
  await reply()
  socket.end('QUIT\r\n')
}

/**
 * Stores a message with an old internal date via IMAP APPEND (sync_since
 * filters by internal date, SMTP delivery always uses "now"). The mailbox
 * must exist, i.e. received a message via deliver() before.
 */
export async function appendOld(mailbox: string, message: string, date: Date): Promise<void> {
  const socket = net.connect(imapPort, mailHost)
  socket.setEncoding('utf8')
  let buffer = ''
  socket.on('data', (chunk: string) => (buffer += chunk))
  const waitFor = async (pattern: RegExp) => {
    for (let i = 0; i < 100 && !pattern.test(buffer); i++)
      await new Promise((r) => setTimeout(r, 50))
    if (!pattern.test(buffer)) throw new Error('IMAP: no response')
    if (/^a\d (NO|BAD)/m.test(buffer)) throw new Error('IMAP command failed')
  }
  await waitFor(/^\* OK/m)
  socket.write(`a1 LOGIN "${mailbox}" "${mailbox}"\r\n`)
  await waitFor(/^a1 OK/m)
  const [, day, month, year, time] = date.toUTCString().match(/\w+, (\d+) (\w+) (\d+) (\S+)/)!
  const literal = Buffer.from(message)
  socket.write(`a2 APPEND INBOX "${day}-${month}-${year} ${time} +0000" {${literal.length}}\r\n`)
  await waitFor(/^\+/m)
  socket.write(Buffer.concat([literal, Buffer.from('\r\n')]))
  await waitFor(/^a2 OK/m)
  socket.end('a3 LOGOUT\r\n')
}

/** Creates an IMAP folder in a GreenMail mailbox (e.g. "Archive"); exists already = fine. */
export async function createFolder(mailbox: string, name: string): Promise<void> {
  const socket = net.connect(imapPort, mailHost)
  socket.setEncoding('utf8')
  let buffer = ''
  socket.on('data', (chunk: string) => (buffer += chunk))
  const waitFor = async (pattern: RegExp) => {
    for (let i = 0; i < 100 && !pattern.test(buffer); i++)
      await new Promise((r) => setTimeout(r, 50))
    if (!pattern.test(buffer)) throw new Error('IMAP: no response')
  }
  await waitFor(/^\* OK/m)
  socket.write(`a1 LOGIN "${mailbox}" "${mailbox}"\r\n`)
  await waitFor(/^a1 OK/m)
  socket.write(`a2 CREATE "${name}"\r\n`)
  await waitFor(/^a2 (OK|NO)/m)
  socket.end('a3 LOGOUT\r\n')
}

/**
 * Real touch input via CDP (trusted events with timestamps), for the
 * pull-to-refresh and swipe-back gestures. Chromium only.
 */
export async function touchDrag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  steps = 8,
): Promise<void> {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] })
  for (let i = 1; i <= steps; i++) {
    const point = {
      x: from.x + ((to.x - from.x) * i) / steps,
      y: from.y + ((to.y - from.y) * i) / steps,
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point] })
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach()
}

/** Signed in: the profile avatar of the header (#120) is shown. */
export function profileButton(page: Page) {
  return page.getByRole('button', { name: /^Profil:/ })
}

/** Settings via the profile menu (#120). */
export async function openSettings(page: Page): Promise<void> {
  await profileButton(page).click()
  await page.getByRole('menuitem', { name: 'Einstellungen' }).click()
  await page.getByRole('heading', { name: 'Einstellungen', level: 1 }).waitFor()
}

/** Back from the settings to the mail view. */
export async function backToMail(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Zurück zur Post' }).click()
}

/** Phone viewport: the side menu with the accounts (#120). */
export async function openSideMenu(page: Page) {
  await page.getByRole('button', { name: 'Konten und Ordner' }).click()
  return page.getByRole('dialog', { name: 'Konten' })
}

/** Opens the inbox of an account via the side menu of the phone layout. */
export async function openAccount(page: Page, displayName: string): Promise<void> {
  await page.goto('/')
  const menu = await openSideMenu(page)
  await menu.getByRole('button', { name: new RegExp(`^${escapeRegExp(displayName)},`) }).click()
  await menu.waitFor({ state: 'hidden' })
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
