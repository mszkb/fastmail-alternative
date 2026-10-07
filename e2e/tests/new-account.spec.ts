import { expect, test } from '@playwright/test'
import {
  backToMail,
  escapeRegExp,
  openSideMenu,
  deliver,
  imapPort,
  mailHost,
  openSettings,
  smtpPort,
  textMail,
} from './helpers'

// Regression: the folder list of a new account stayed empty ("Noch keine
// Ordner synchronisiert") until a reload when it was opened while the first
// sync was still running.
test('a new account shows its inbox after the first sync without reload', async ({ page }) => {
  // Unique per attempt: a retry must not find the account of the first try.
  const id = `${process.env.E2E_RUN}-${test.info().retry}`
  const mailbox = `e2e-c-${id}@example.com`
  const name = `Neu ${id}`
  await deliver(mailbox, textMail(mailbox, 'Erste Mail', 'Willkommen'))

  await page.goto('/')
  await openSettings(page)
  const form = page.locator('form', {
    has: page.getByRole('heading', { name: 'Konto hinzufügen' }),
  })
  await form.getByLabel('E-Mail-Adresse des Kontos').fill(mailbox)
  await form.getByLabel('Anzeigename (optional)').fill(name)
  const imap = form.locator('fieldset').filter({ has: page.locator('legend', { hasText: 'IMAP' }) })
  await imap.getByLabel('Host').fill(mailHost)
  await imap.getByLabel('Port').fill(String(imapPort))
  await imap.getByLabel('Benutzer').fill(mailbox)
  await imap.getByLabel('Passwort').fill(mailbox)
  const smtp = form.locator('fieldset').filter({ has: page.locator('legend', { hasText: 'SMTP' }) })
  await smtp.getByLabel('Host').fill(mailHost)
  await smtp.getByLabel('Port').fill(String(smtpPort))
  await form.getByRole('button', { name: 'Verbinden' }).click()
  await expect(form.getByText('Konto verbunden und gespeichert.')).toBeVisible()

  // Straight to the new account, before its first sync is through.
  await backToMail(page)
  const menu = await openSideMenu(page)
  await menu.getByRole('button', { name: new RegExp(`^${escapeRegExp(name)},`) }).click()
  await expect(
    page.getByRole('region', { name: 'Nachrichten' }).getByText('Erste Mail'),
  ).toBeVisible({ timeout: 30_000 })
})
