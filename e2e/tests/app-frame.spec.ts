import { expect, test } from '@playwright/test'
import {
  ACCOUNT_A,
  ACCOUNT_B,
  USER,
  backToMail,
  escapeRegExp,
  openAccount,
  openSettings,
  openSideMenu,
  profileButton,
} from './helpers'

// App frame (#120): account bar, header with search, profile menu.

const accountButton = (name: string) => ({ name: new RegExp(`^${escapeRegExp(name)},`) })

test('account bar on a wide screen: initials, switch, choice kept after reload', async ({
  browser,
}) => {
  const context = await browser.newContext({
    storageState: '.auth/state.json',
    viewport: { width: 1280, height: 800 },
  })
  const page = await context.newPage()
  await page.goto('/')
  const bar = page.getByRole('navigation', { name: 'Konten' })
  const a = bar.getByRole('button', accountButton(ACCOUNT_A))
  const b = bar.getByRole('button', accountButton(ACCOUNT_B))
  // "Privat <run>" / "Arbeit <run>": first letters of the two words.
  await expect(a).toContainText(/^P\d/)
  await expect(b).toContainText(/^A\d/)
  await expect(a).toHaveAttribute('title', /Privat .* – e2e-a-/)

  await b.click()
  await expect(b).toHaveAttribute('aria-current', 'true')
  await expect(a).not.toHaveAttribute('aria-current', 'true')
  const list = page.getByRole('region', { name: 'Nachrichten' })
  await expect(list.getByText('Neu bei B')).toBeVisible()
  await page.reload()
  await expect(bar.getByRole('button', accountButton(ACCOUNT_B))).toHaveAttribute(
    'aria-current',
    'true',
  )
  await expect(list.getByText('Neu bei B')).toBeVisible()

  // Keyboard: Tab reaches the accounts, Enter switches.
  await bar.getByRole('button', accountButton(ACCOUNT_A)).focus()
  await page.keyboard.press('Enter')
  await expect(list.getByText('Hallo 1')).toBeVisible()

  // Expand shows names; remembered on this device.
  await bar.getByRole('button', { name: 'Kontoleiste ausklappen' }).click()
  await expect(bar.getByText(ACCOUNT_A, { exact: true })).toBeVisible()
  await page.reload()
  await expect(bar.getByText(ACCOUNT_A, { exact: true })).toBeVisible()
  await bar.getByRole('button', { name: 'Kontoleiste einklappen' }).click()
  await expect(bar.getByText(ACCOUNT_A, { exact: true })).toBeHidden()

  // Header search starts the search in the active account.
  await page.getByRole('banner').getByLabel('Suchbegriff').fill('Hallo 2')
  await page.keyboard.press('Enter')
  await expect(list.getByText(/\d+ Treffer/)).toBeVisible({ timeout: 20_000 })
  await context.close()
})

test('side menu switches accounts on the phone', async ({ page }) => {
  await openAccount(page, ACCOUNT_B)
  const list = page.getByRole('region', { name: 'Nachrichten' })
  await expect(list.getByText('Neu bei B')).toBeVisible()
  const menu = await openSideMenu(page)
  await expect(menu.getByRole('button', accountButton(ACCOUNT_B))).toHaveAttribute(
    'aria-current',
    'true',
  )
  await menu.getByRole('button', accountButton(ACCOUNT_A)).click()
  await expect(menu).toBeHidden()
  await expect(list.getByText('Hallo 1')).toBeVisible()
})

test('profile menu: keyboard, settings', async ({ page }) => {
  await page.goto('/')
  const avatar = profileButton(page)
  await expect(avatar).toHaveAttribute('aria-haspopup', 'menu')
  await expect(avatar).toHaveAttribute('aria-expanded', 'false')
  await avatar.focus()
  await page.keyboard.press('ArrowDown')
  await expect(avatar).toHaveAttribute('aria-expanded', 'true')
  const menu = page.getByRole('menu', { name: 'Profil' })
  await expect(menu.getByRole('menuitem', { name: 'Einstellungen' })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(menu.getByRole('menuitem', { name: 'Abmelden' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  await expect(avatar).toBeFocused()

  await openSettings(page)
  await expect(page.getByRole('heading', { name: 'Konto hinzufügen' })).toBeVisible()
  await backToMail(page)
  await expect(page.getByRole('region', { name: 'Nachrichten' })).toBeVisible()
})

test('profile menu: logout ends the session', async ({ browser }) => {
  // Own login: logging out here must not end the session of the other specs.
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } })
  const page = await context.newPage()
  await page.goto('/')
  await page.getByLabel('E-Mail').fill(USER.email)
  await page.getByLabel('Passwort', { exact: true }).fill(USER.password)
  await page.getByRole('button', { name: 'Anmelden' }).click()
  await profileButton(page).click()
  await page.getByRole('menuitem', { name: 'Abmelden' }).click()
  await expect(page.getByRole('heading', { name: 'Anmeldung' })).toBeVisible()
  // The session is gone on the server as well.
  expect((await page.request.get('/api/accounts')).status()).toBe(401)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Anmeldung' })).toBeVisible()
  await context.close()
})
