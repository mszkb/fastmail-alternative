import { expect, test } from '@playwright/test'
import { openSettings } from './helpers'

// Settings detection for domains without a preset (#165). The server's
// lookup (autoconfig, ISPDB, DNS) needs the internet, so the API answer is
// stubbed here; the form must fill in only what the user has not typed.
test('unknown domain: detected servers pre-fill the form, nothing found leaves it empty', async ({
  page,
}) => {
  const asked: string[] = []
  await page.route('**/api/autoconfig?*', async (route) => {
    const domain = new URL(route.request().url()).searchParams.get('domain') ?? ''
    asked.push(domain)
    await route.fulfill({
      json:
        domain === 'eigene-domain.example'
          ? {
              found: true,
              source: 'ispdb',
              imap: { host: 'imap.eigene-domain.example', port: 993 },
              smtp: { host: 'smtp.eigene-domain.example', port: 587 },
              username: 'localpart',
            }
          : { found: false },
    })
  })
  await page.goto('/')
  await openSettings(page)
  const form = page.locator('form', {
    has: page.getByRole('heading', { name: 'Konto hinzufügen' }),
  })
  const imap = form.locator('fieldset').filter({ has: page.locator('legend', { hasText: 'IMAP' }) })
  const smtp = form.locator('fieldset').filter({ has: page.locator('legend', { hasText: 'SMTP' }) })
  const address = form.getByLabel('E-Mail-Adresse des Kontos')
  const status = form.getByTestId('autoconfig-status')

  await address.fill('ich@eigene-domain.example')
  await address.blur()
  await expect(status).toContainText('automatisch erkannt')
  await expect(status).toContainText('Thunderbird')
  await expect(form.getByLabel('Anbieter')).toHaveValue('')
  await expect(imap.getByLabel('Host')).toHaveValue('imap.eigene-domain.example')
  await expect(imap.getByLabel('Port')).toHaveValue('993')
  await expect(imap.getByLabel('Benutzer')).toHaveValue('ich')
  await expect(smtp.getByLabel('Host')).toHaveValue('smtp.eigene-domain.example')
  await expect(smtp.getByLabel('Port')).toHaveValue('587')
  // Only the domain goes to the server.
  expect(asked).toEqual(['eigene-domain.example'])

  // Another domain without results: the detected values go, typed ones stay.
  await smtp.getByLabel('Host').fill('mail.selbst.example')
  await address.fill('ich@unbekannt.example')
  await address.blur()
  await expect(status).toContainText('Keine Server-Einstellungen gefunden')
  await expect(imap.getByLabel('Host')).toHaveValue('')
  await expect(imap.getByLabel('Benutzer')).toHaveValue('')
  await expect(smtp.getByLabel('Host')).toHaveValue('mail.selbst.example')

  // A domain with a preset never asks the server.
  await address.fill('ich@posteo.de')
  await address.blur()
  await expect(form.getByLabel('Anbieter')).toHaveValue('posteo')
  await expect(status).toHaveCount(0)
  expect(asked).toEqual(['eigene-domain.example', 'unbekannt.example'])
})
