import { expect, test } from '@playwright/test'
import { openSettings } from './helpers'

// Sign-in with Google/Microsoft (#36). The e2e stack has no OAuth app, so
// the provider list and the start are answered by page.route; the result
// comes back as /?oauth=... like after the provider's redirect.
test('Gmail preset offers the Google sign-in and shows the result after the return', async ({
  page,
}) => {
  await page.route('**/api/oauth/providers', (route) =>
    route.fulfill({
      json: {
        providers: { google: true, microsoft: false },
        redirectUri: 'https://x/api/oauth/callback',
      },
    }),
  )
  let startBody: unknown = null
  await page.route('**/api/oauth/google/start', (route) => {
    startBody = route.request().postDataJSON()
    // The provider would redirect back here; denied consent as the result.
    return route.fulfill({ json: { url: '/?oauth=error&reason=denied' } })
  })
  await page.goto('/')
  await openSettings(page)
  const form = page.locator('form', {
    has: page.getByRole('heading', { name: 'Konto hinzufügen' }),
  })
  await form.getByLabel('E-Mail-Adresse des Kontos').fill('ich@gmail.com')
  await form.getByLabel('E-Mail-Adresse des Kontos').blur()
  await expect(form.getByLabel('Anbieter')).toHaveValue('gmail')
  // Both ways: sign-in button and the app password fields.
  await expect(form.getByText('oder mit App-Passwort:')).toBeVisible()
  await expect(form.locator('fieldset')).toHaveCount(2)
  await form.getByRole('button', { name: 'Mit Google anmelden' }).click()

  await expect(page).toHaveURL((url) => url.search === '')
  expect(startBody).toEqual({})
  await expect(page.getByText('Die Anmeldung wurde beim Anbieter abgebrochen')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Einstellungen' })).toBeVisible()
})

test('Microsoft preset explains the missing server setup', async ({ page }) => {
  await page.goto('/')
  await openSettings(page)
  const form = page.locator('form', {
    has: page.getByRole('heading', { name: 'Konto hinzufügen' }),
  })
  await form.getByLabel('Anbieter').selectOption({ label: 'Microsoft 365 / Outlook.com' })
  await expect(form.getByRole('note')).toContainText('Betreiber')
  await expect(form.getByRole('button', { name: 'Mit Microsoft anmelden' })).toHaveCount(0)
})

test('Microsoft preset shows only the sign-in when configured', async ({ page }) => {
  await page.route('**/api/oauth/providers', (route) =>
    route.fulfill({ json: { providers: { google: false, microsoft: true }, redirectUri: null } }),
  )
  await page.goto('/')
  await openSettings(page)
  const form = page.locator('form', {
    has: page.getByRole('heading', { name: 'Konto hinzufügen' }),
  })
  await form.getByLabel('Anbieter').selectOption({ label: 'Microsoft 365 / Outlook.com' })
  await expect(form.getByRole('button', { name: 'Mit Microsoft anmelden' })).toBeVisible()
  await expect(form.locator('fieldset')).toHaveCount(0)
  await expect(form.getByRole('button', { name: 'Verbinden' })).toHaveCount(0)
})
