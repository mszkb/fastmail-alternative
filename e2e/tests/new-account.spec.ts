import { expect, test } from '@playwright/test'
import { deliver, imapPort, mailHost, smtpPort, textMail } from './helpers'

// Regression: the folder list of a new account stayed empty ("Noch keine
// Ordner synchronisiert") until a reload when it was opened while the first
// sync was still running.
test('a new account shows its inbox after the first sync without reload', async ({ page }) => {
  const mailbox = `e2e-c-${process.env.E2E_RUN}@example.com`
  const name = `Neu ${process.env.E2E_RUN}`
  await deliver(mailbox, textMail(mailbox, 'Erste Mail', 'Willkommen'))

  await page.goto('/')
  await page.getByRole('button', { name: 'Einstellungen' }).click()
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
  await page.getByRole('button', { name: 'E-Mail', exact: true }).click()
  const picker = page.locator('.account-picker select')
  await picker.selectOption(
    (await picker.locator('option', { hasText: name }).getAttribute('value'))!,
  )
  await expect(
    page.getByRole('region', { name: 'Nachrichten' }).getByText('Erste Mail'),
  ).toBeVisible({ timeout: 30_000 })
})
