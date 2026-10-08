import { expect, test } from '@playwright/test'
import { openSettings } from './helpers'

// Appearance (#112): theme and density per device, kept after a reload.
test('dark theme and compact list can be chosen and stay after reload', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto('/')
  await openSettings(page)
  const html = page.locator('html')
  await expect(html).not.toHaveAttribute('data-theme', /.+/)
  await page.getByLabel('Dunkel').check()
  await page.getByLabel('Kompakt').check()
  await expect(html).toHaveAttribute('data-theme', 'fma-dark')
  await expect(html).toHaveAttribute('data-density', 'compact')
  await page.reload()
  await expect(html).toHaveAttribute('data-theme', 'fma-dark')
  await expect(html).toHaveAttribute('data-density', 'compact')

  // Back to the defaults for the other specs.
  await openSettings(page)
  await page.getByLabel('Wie das System').check()
  await page.getByLabel('Normal').check()
  await expect(html).not.toHaveAttribute('data-theme', /.+/)
  await expect(html).toHaveAttribute('data-density', 'normal')
})
