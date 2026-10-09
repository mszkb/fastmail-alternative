import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { openSettings } from './helpers'

// Installable themes (#126): install, preview, activate, reset via
// ?theme=default, reject an invalid file, delete.

const preset = fileURLToPath(
  new URL('../../themes/klassisch-wie-outlook.fmatheme.json', import.meta.url),
)

test('install a theme, preview, activate, reset with ?theme=default, delete', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto('/')
  await openSettings(page)
  const html = page.locator('html')
  const radius = () =>
    page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--fma-radius').trim(),
    )
  const defaultRadius = await radius()

  // An invalid file is refused with the reason.
  await page.getByLabel('Theme-Datei installieren').setInputFiles({
    name: 'boese.fmatheme.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        format: 1,
        id: 'boese',
        name: 'Böse',
        version: '1.0.0',
        author: 'x',
        license: 'x',
        minAppVersion: '0.1.0',
        css: 'body{background:url(https://evil.example/)}',
      }),
    ),
  })
  await expect(page.getByRole('alert')).toContainText('Unbekanntes Feld „css“.')

  await page.getByLabel('Theme-Datei installieren').setInputFiles(preset)
  await expect(page.getByRole('status').filter({ hasText: 'ist installiert' })).toBeVisible()
  const row = page.locator('[data-theme-id="klassisch-wie-outlook"]')
  await expect(row).toContainText('Klassisch (wie Outlook)')

  await row.getByRole('button', { name: 'Vorschau' }).click()
  await expect(html).toHaveAttribute('data-user-theme', 'klassisch-wie-outlook')
  await row.getByRole('button', { name: 'Vorschau beenden' }).click()
  await expect(html).not.toHaveAttribute('data-user-theme', /.+/)

  await row.getByRole('button', { name: 'Aktivieren' }).click()
  await expect(html).toHaveAttribute('data-user-theme', 'klassisch-wie-outlook')
  expect(await radius()).toBe('0.125rem')
  await page.reload()
  await expect(html).toHaveAttribute('data-user-theme', 'klassisch-wie-outlook')

  // Emergency exit: ?theme=default always restores the built-in look.
  await page.goto('/?theme=default')
  await expect(html).not.toHaveAttribute('data-user-theme', /.+/)
  expect(await radius()).toBe(defaultRadius)
  await expect(page).not.toHaveURL(/theme=/)
  await page.reload()
  await expect(html).not.toHaveAttribute('data-user-theme', /.+/)

  // Delete it again.
  await openSettings(page)
  page.once('dialog', (dialog) => void dialog.accept())
  await page
    .locator('[data-theme-id="klassisch-wie-outlook"]')
    .getByRole('button', { name: 'Löschen' })
    .click()
  await expect(page.locator('[data-theme-id="klassisch-wie-outlook"]')).toHaveCount(0)
})
