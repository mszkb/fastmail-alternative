import { mkdirSync } from 'node:fs'
import { expect, test as setup } from '@playwright/test'
import {
  ACCOUNT_A,
  ACCOUNT_B,
  appendOld,
  deliver,
  imapPort,
  MAILBOX_A,
  MAILBOX_B,
  mailHost,
  openSettings,
  profileButton,
  richMail,
  SETUP_CODE,
  smtpPort,
  textMail,
  USER,
} from './helpers'

setup('first-run setup, login and two accounts', async ({ page }) => {
  // Test mails first, so the initial sync already finds them.
  for (let i = 1; i <= 3; i++) {
    await deliver(MAILBOX_A, textMail(MAILBOX_A, `Hallo ${i}`, `Testnachricht ${i}`))
  }
  await deliver(MAILBOX_A, richMail(MAILBOX_A, 'Mit Anhang und Bild'))
  await deliver(MAILBOX_B, textMail(MAILBOX_B, 'Neu bei B', 'aktuell'))
  const twoYearsAgo = new Date(Date.now() - 2 * 365 * 24 * 3600 * 1000)
  await appendOld(MAILBOX_B, textMail(MAILBOX_B, 'Alt bei B', 'alt', twoYearsAgo), twoYearsAgo)

  await page.goto('/')
  const setupForm = page.getByRole('heading', { name: 'Einrichtung' })
  const loginForm = page.getByRole('heading', { name: 'Anmeldung' })
  await expect(setupForm.or(loginForm)).toBeVisible()
  if (await setupForm.isVisible()) {
    // Wrong setup code: rejected, no user created.
    await page.getByLabel('Setup-Code').fill('WRONG-CODE')
    await page.getByLabel('E-Mail').fill(USER.email)
    await page.getByLabel('Passwort (min. 10 Zeichen)').fill(USER.password)
    await page.getByRole('button', { name: 'Konto erstellen' }).click()
    await expect(page.locator('.message.error')).toBeVisible()
    await page.getByLabel('Setup-Code').fill(SETUP_CODE)
    await page.getByRole('button', { name: 'Konto erstellen' }).click()
  } else {
    await page.getByLabel('E-Mail').fill(USER.email)
    await page.getByLabel('Passwort', { exact: true }).fill(USER.password)
    await page.getByRole('button', { name: 'Anmelden' }).click()
  }
  await expect(profileButton(page)).toBeVisible()

  // Settings and logout via the profile menu (#120), then login again (incl. a
  // wrong password).
  await openSettings(page)
  await profileButton(page).click()
  await page.getByRole('menuitem', { name: 'Abmelden' }).click()
  await expect(loginForm).toBeVisible()
  await page.getByLabel('E-Mail').fill(USER.email)
  await page.getByLabel('Passwort', { exact: true }).fill('not-the-password')
  await page.getByRole('button', { name: 'Anmelden' }).click()
  await expect(page.locator('.message.error')).toBeVisible()
  await page.getByLabel('Passwort', { exact: true }).fill(USER.password)
  await page.getByLabel('Gerätename (optional)').fill('E2E Handy')
  await page.getByRole('button', { name: 'Anmelden' }).click()
  await expect(profileButton(page)).toBeVisible()

  // Accounts via the settings form; B only syncs the last 30 days.
  for (const [mailbox, name, since] of [
    [MAILBOX_A, ACCOUNT_A, 'Alle'],
    [MAILBOX_B, ACCOUNT_B, '30 Tage'],
  ] as const) {
    await openSettings(page)
    const form = page.locator('form', {
      has: page.getByRole('heading', { name: 'Konto hinzufügen' }),
    })
    await form.getByLabel('E-Mail-Adresse des Kontos').fill(mailbox)
    await form.getByLabel('Anzeigename (optional)').fill(name)
    await form.getByLabel('Mails synchronisieren').selectOption({ label: since })
    const imap = form
      .locator('fieldset')
      .filter({ has: page.locator('legend', { hasText: 'IMAP' }) })
    await imap.getByLabel('Host').fill(mailHost)
    await imap.getByLabel('Port').fill(String(imapPort))
    await imap.getByLabel('Benutzer').fill(mailbox)
    await imap.getByLabel('Passwort').fill(mailbox)
    const smtp = form
      .locator('fieldset')
      .filter({ has: page.locator('legend', { hasText: 'SMTP' }) })
    await smtp.getByLabel('Host').fill(mailHost)
    await smtp.getByLabel('Port').fill(String(smtpPort))
    await form.getByRole('button', { name: 'Verbinden' }).click()
    await expect(form.getByText('Konto verbunden und gespeichert.')).toBeVisible()
  }

  mkdirSync('.auth', { recursive: true })
  await page.context().storageState({ path: '.auth/state.json' })
})
