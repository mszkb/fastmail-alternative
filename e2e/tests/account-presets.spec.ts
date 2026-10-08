import { expect, test } from '@playwright/test'
import { openSettings } from './helpers'

// Provider presets (#117): no connection is made here (no real provider in
// CI); the form must be filled correctly.
test('Fastmail preset fills servers, ports and user and explains the app password', async ({
  page,
}) => {
  await page.goto('/')
  await openSettings(page)
  const form = page.locator('form', {
    has: page.getByRole('heading', { name: 'Konto hinzufügen' }),
  })
  const imap = form.locator('fieldset').filter({ has: page.locator('legend', { hasText: 'IMAP' }) })
  const smtp = form.locator('fieldset').filter({ has: page.locator('legend', { hasText: 'SMTP' }) })

  // A known domain selects the preset by itself.
  await form.getByLabel('E-Mail-Adresse des Kontos').fill('umstieg@fastmail.com')
  await form.getByLabel('E-Mail-Adresse des Kontos').blur()
  await expect(form.getByLabel('Anbieter')).toHaveValue('fastmail')
  await expect(imap.getByLabel('Host')).toHaveValue('imap.fastmail.com')
  await expect(imap.getByLabel('Port')).toHaveValue('993')
  await expect(imap.getByLabel('Benutzer')).toHaveValue('umstieg@fastmail.com')
  await expect(smtp.getByLabel('Host')).toHaveValue('smtp.fastmail.com')
  await expect(smtp.getByLabel('Port')).toHaveValue('465')
  await expect(form.getByRole('note')).toContainText('App-Passwort')

  // Picked by hand: Posteo, then back to the own server keeps the values editable.
  await form.getByLabel('Anbieter').selectOption({ label: 'Posteo' })
  await expect(imap.getByLabel('Host')).toHaveValue('posteo.de')
  await form
    .getByLabel('Anbieter')
    .selectOption({ label: 'Eigener Server (Daten selbst eingeben)' })
  await expect(form.getByRole('note')).toHaveCount(0)
  await imap.getByLabel('Host').fill('imap.example.org')
  await expect(imap.getByLabel('Host')).toHaveValue('imap.example.org')
})

test('first steps are shown in the settings until hidden', async ({ page }) => {
  await page.goto('/')
  await openSettings(page)
  const steps = page.getByRole('region', { name: 'Erste Schritte' })
  await expect(steps.getByText('Benachrichtigungen')).toBeVisible()
  await steps.getByRole('button', { name: 'Ausblenden' }).click()
  await expect(steps).toBeHidden()
  await page.reload()
  await openSettings(page)
  await expect(page.getByRole('region', { name: 'Erste Schritte' })).toBeHidden()
})
