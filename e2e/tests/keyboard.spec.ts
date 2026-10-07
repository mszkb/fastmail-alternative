import { expect, test } from '@playwright/test'
import { ACCOUNT_A, MAILBOX_A, createFolder, deliver, escapeRegExp, textMail } from './helpers'

// Keyboard shortcuts (#115): go through the inbox with the keyboard only,
// reply and archive. Wide screen: list and reading pane side by side.
test('inbox with the keyboard only: move, open, reply, archive', async ({ browser }) => {
  await createFolder(MAILBOX_A, 'Archive')
  const subject = `Tastatur ${Date.now()}`
  await deliver(MAILBOX_A, textMail(MAILBOX_A, subject, 'Bitte mit der Tastatur bearbeiten'))
  const context = await browser.newContext({
    storageState: '.auth/state.json',
    viewport: { width: 1280, height: 800 },
  })
  const page = await context.newPage()
  await page.goto('/')
  const bar = page.getByRole('navigation', { name: 'Konten' })
  await bar.getByRole('button', { name: new RegExp(`^${escapeRegExp(ACCOUNT_A)},`) }).click()
  const list = page.getByRole('region', { name: 'Nachrichten' })
  const detail = page.getByRole('region', { name: 'Nachricht' })
  // The new mail and the Archive folder arrive with a sync.
  await expect(async () => {
    await page.getByRole('button', { name: 'Aktualisieren', exact: true }).click()
    await expect(list.getByText(subject)).toBeVisible({ timeout: 5_000 })
    await expect(page.getByRole('navigation', { name: 'Ordner' }).getByText('Archiv')).toBeVisible({
      timeout: 5_000,
    })
  }).toPass({ intervals: [3_000], timeout: 60_000 })

  // "?" shows the overview, Escape closes it.
  await page.locator('body').click({ position: { x: 5, y: 400 } })
  await page.keyboard.press('?')
  await expect(page.getByRole('dialog', { name: 'Tastenkürzel' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Tastenkürzel' })).toBeHidden()

  // j moves the cursor to the newest message, Enter opens it.
  await page.keyboard.press('j')
  await expect(list.locator('.item.cursor')).toContainText(subject)
  await page.keyboard.press('Enter')
  await expect(detail.getByRole('heading', { name: subject })).toBeVisible()

  // r replies; Esc closes the form and keeps the draft.
  await page.keyboard.press('r')
  const compose = page.getByRole('dialog')
  await expect(compose.getByLabel('Betreff')).toHaveValue(`Re: ${subject}`)
  await compose.getByTitle('Schließen, Entwurf behalten (Esc)').click()
  await expect(compose).toBeHidden()

  // e archives: the message leaves the inbox.
  await page.keyboard.press('e')
  await expect(list.getByText(subject)).toBeHidden()
  // g a jumps to the archive, where it is now.
  await page.keyboard.press('g')
  await page.keyboard.press('a')
  await expect(list.getByText(subject)).toBeVisible({ timeout: 30_000 })

  // Typing in a field never triggers shortcuts.
  await page.getByRole('banner').getByLabel('Suchbegriff').fill('je')
  await expect(page.getByRole('banner').getByLabel('Suchbegriff')).toHaveValue('je')
  await context.close()
})
