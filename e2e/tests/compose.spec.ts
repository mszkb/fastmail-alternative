import { expect, test } from '@playwright/test'
import { ACCOUNT_A, ACCOUNT_B, escapeRegExp, MAILBOX_B, openAccount } from './helpers'

test('saves a draft with attachment and reopens it', async ({ page }) => {
  const subject = `Entwurf ${process.env.E2E_RUN}`
  await openAccount(page, ACCOUNT_A)
  await page.getByRole('button', { name: 'Neue E-Mail' }).click()
  const compose = page.getByRole('dialog')
  await compose
    .getByPlaceholder('name@example.com, Name <name@example.com>')
    .fill('carol@example.org')
  await compose.getByLabel('Betreff').fill(subject)
  await compose.getByLabel('Nachricht').fill('Halb fertiger Text')
  await compose.locator('input[type=file]').setInputFiles({
    name: 'notizen.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Anhang im Entwurf'),
  })
  await expect(compose.getByText('notizen.txt')).toBeVisible()
  // Layout: the attachment list has the same left inset as the fields.
  const nameBox = (await compose.getByText('notizen.txt').boundingBox())!
  const labelBox = (await compose.getByText('Betreff', { exact: true }).boundingBox())!
  expect(Math.round(nameBox.x)).toBe(Math.round(labelBox.x))
  await expect(compose.getByRole('status')).toHaveText('Entwurf gespeichert')
  await compose.getByTitle('Schließen, Entwurf behalten (Esc)').click()
  await expect(compose).toBeHidden()

  // Reload: the draft comes from the server, not from component state.
  await openAccount(page, ACCOUNT_A)
  const drafts = page.getByRole('region', { name: 'Gespeicherte Entwürfe' })
  await drafts.getByRole('button', { name: new RegExp(subject) }).click()
  await expect(compose.getByPlaceholder('name@example.com, Name <name@example.com>')).toHaveValue(
    'carol@example.org',
  )
  await expect(compose.getByLabel('Betreff')).toHaveValue(subject)
  await expect(compose.getByLabel('Nachricht')).toHaveValue('Halb fertiger Text')
  await expect(compose.getByText('notizen.txt')).toBeVisible()

  // Discarding removes it from the list.
  page.once('dialog', (dialog) => dialog.accept())
  await compose.getByRole('button', { name: 'Verwerfen' }).click()
  await expect(compose).toBeHidden()
  await expect(drafts.getByRole('button', { name: new RegExp(subject) })).toBeHidden()
})

test('forwards a message with its attachment and inline image', async ({ page }) => {
  const subject = 'Mit Anhang und Bild'
  await openAccount(page, ACCOUNT_A)
  await page
    .getByRole('region', { name: 'Nachrichten' })
    .getByRole('button', { name: new RegExp(subject) })
    .click()
  await page
    .getByRole('region', { name: 'Nachricht' })
    .getByRole('button', { name: 'Weiterleiten' })
    .click()

  const compose = page.getByRole('dialog')
  await expect(compose.getByLabel('Betreff')).toHaveValue(new RegExp(`^(WG|Fwd): ${subject}`))
  // Original attachment and the inline (cid:) image come along (#53).
  await expect(compose.getByText('rechnung.pdf')).toBeVisible()
  await expect(compose.getByText('logo.png')).toBeVisible()
  await compose.getByPlaceholder('name@example.com, Name <name@example.com>').fill(MAILBOX_B)
  await compose.getByRole('button', { name: 'Senden' }).click()
  await expect(compose).toBeHidden()

  // Arrives at B (same GreenMail) with both files as attachments.
  await openAccount(page, ACCOUNT_B)
  const list = page.getByRole('region', { name: 'Nachrichten' })
  await expect(async () => {
    await page.getByRole('button', { name: 'Aktualisieren' }).click()
    await expect(list.getByRole('button', { name: new RegExp(subject) })).toBeVisible({
      timeout: 3000,
    })
  }).toPass({ timeout: 45_000 })
  await list.getByRole('button', { name: new RegExp(subject) }).click()
  const attachments = page.getByRole('region', { name: 'Anhänge' })
  await expect(attachments.getByText('rechnung.pdf')).toBeVisible()
  await expect(attachments.getByText('logo.png')).toBeVisible()
})

// Composer (#116): in the reading pane on a wide screen, recipient
// suggestions from known addresses, undo send within the window.
test('reply in the reading pane, suggestions, undo send', async ({ browser }) => {
  const context = await browser.newContext({
    storageState: '.auth/state.json',
    viewport: { width: 1280, height: 800 },
  })
  const page = await context.newPage()
  await page.goto('/')
  await page
    .getByRole('navigation', { name: 'Konten' })
    .getByRole('button', { name: new RegExp(`^${escapeRegExp(ACCOUNT_A)},`) })
    .click()
  const list = page.getByRole('region', { name: 'Nachrichten' })
  await list.getByRole('button', { name: /Hallo 3/ }).click()
  await page.keyboard.press('r')
  const compose = page.getByRole('dialog', { name: 'Antworten' })
  // Below the conversation in the reading pane: no modal overlay, the list stays usable.
  await expect(
    page.getByRole('region', { name: 'Nachricht', exact: true }).getByRole('dialog'),
  ).toHaveCount(1)
  await expect(compose).toHaveAttribute('aria-modal', 'false')
  await expect(list).toBeVisible()

  // Suggestion from the loaded messages (sender Alice).
  const cc = compose.getByRole('button', { name: 'Cc/Bcc' })
  await cc.click()
  const ccField = compose.getByLabel('Cc', { exact: true })
  await ccField.fill('ali')
  await expect(compose.getByRole('option', { name: /alice@example\.org/ })).toBeVisible()
  await ccField.press('Enter')
  await expect(ccField).toHaveValue(/alice@example\.org>?, $/)
  await ccField.fill('')

  // Undo send: the form stays, nothing is sent.
  await compose.getByLabel('Nachricht').fill('Antwort mit Rückgängig')
  await compose.getByRole('button', { name: 'Senden' }).click()
  await expect(
    compose.getByRole('status').filter({ hasText: /Wird in \d+ s gesendet/ }),
  ).toBeVisible()
  await compose.getByRole('button', { name: 'Rückgängig' }).click()
  await expect(compose.getByLabel('Nachricht')).toHaveValue('Antwort mit Rückgängig')
  await expect(compose.getByRole('button', { name: 'Senden' })).toBeVisible()

  // Ctrl+Enter sends after the window.
  await compose.getByLabel('Nachricht').press('Control+Enter')
  await expect(compose).toBeHidden({ timeout: 20_000 })
  await context.close()
})
