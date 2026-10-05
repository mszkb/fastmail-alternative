import { expect, test, type Page } from '@playwright/test'
import { USER } from './helpers'

async function changePassword(page: Page, current: string, next: string, confirm = next) {
  await page.getByRole('button', { name: 'Einstellungen' }).click()
  const form = page.locator('form', { has: page.getByRole('heading', { name: 'Passwort ändern' }) })
  await form.getByLabel('Aktuelles Passwort').fill(current)
  await form.getByLabel('Neues Passwort (mind. 10 Zeichen)').fill(next)
  await form.getByLabel('Neues Passwort bestätigen').fill(confirm)
  await form.getByRole('button', { name: 'Passwort ändern' }).click()
  return form
}

test('password change signs out the other session, not this one', async ({ page, browser }) => {
  // Second device: its own login.
  const other = await browser.newContext({ storageState: { cookies: [], origins: [] } })
  const otherPage = await other.newPage()
  await otherPage.goto('/')
  await otherPage.getByLabel('E-Mail').fill(USER.email)
  await otherPage.getByLabel('Passwort', { exact: true }).fill(USER.password)
  await otherPage.getByLabel('Gerätename (optional)').fill('Zweitgerät')
  await otherPage.getByRole('button', { name: 'Anmelden' }).click()
  await expect(otherPage.getByRole('button', { name: 'Einstellungen' })).toBeVisible()

  await page.goto('/')
  // Negative cases: wrong current password, mismatching confirmation.
  let form = await changePassword(page, 'falsches-passwort', 'e2e-password-2')
  await expect(form.locator('.error')).toBeVisible()
  form = await changePassword(page, USER.password, 'e2e-password-2', 'e2e-password-3')
  await expect(form.locator('.error')).toBeVisible()

  form = await changePassword(page, USER.password, 'e2e-password-2')
  await expect(form.getByText('Passwort geändert. Andere Geräte wurden abgemeldet.')).toBeVisible()
  await expect(page.getByText('Zweitgerät')).toBeHidden()

  // The other session is gone, this one still works.
  await otherPage.reload()
  await expect(otherPage.getByRole('heading', { name: 'Anmeldung' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('button', { name: 'Einstellungen' })).toBeVisible()

  // Old password rejected, new one accepted.
  await otherPage.getByLabel('E-Mail').fill(USER.email)
  await otherPage.getByLabel('Passwort', { exact: true }).fill(USER.password)
  await otherPage.getByRole('button', { name: 'Anmelden' }).click()
  await expect(otherPage.locator('.message.error')).toBeVisible()
  await otherPage.getByLabel('Passwort', { exact: true }).fill('e2e-password-2')
  await otherPage.getByRole('button', { name: 'Anmelden' }).click()
  await expect(otherPage.getByRole('button', { name: 'Einstellungen' })).toBeVisible()
  await other.close()

  // Back to the original password for later runs against the same stack.
  form = await changePassword(page, 'e2e-password-2', USER.password)
  await expect(form.getByText('Passwort geändert. Andere Geräte wurden abgemeldet.')).toBeVisible()
})
