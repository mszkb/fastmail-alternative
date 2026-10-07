import { expect, test } from '@playwright/test'
import {
  ACCOUNT_A,
  ACCOUNT_B,
  backToMail,
  openAccount,
  openSettings,
  openSideMenu,
} from './helpers'

test('sync_since: only recent mail is synced, older mail on request', async ({ page }) => {
  await openAccount(page, ACCOUNT_B)
  const list = page.getByRole('region', { name: 'Nachrichten' })
  await expect(list.getByText('Neu bei B')).toBeVisible()
  await expect(list.getByText('Alt bei B')).toBeHidden()

  // The stored choice is shown as a date in the edit form.
  await openSettings(page)
  const row = page.locator('li', { hasText: ACCOUNT_B })
  await row.getByRole('button', { name: 'Bearbeiten' }).click()
  const select = row.getByLabel('Mails synchronisieren')
  await expect(select.locator('option:checked')).toHaveText(/^Seit \d{1,2}\.\d{1,2}\.\d{4}$/)
  await row.getByRole('button', { name: 'Abbrechen' }).click()

  await backToMail(page)
  await list.getByRole('button', { name: 'Ältere Mails laden' }).click()
  await expect(list.getByText('Alt bei B')).toBeVisible({ timeout: 30_000 })
})

test('shows the storage use per account', async ({ page }) => {
  await page.goto('/')
  await openSettings(page)
  for (const name of [ACCOUNT_A, ACCOUNT_B]) {
    await expect(page.locator('li', { hasText: name }).locator('.storage')).toContainText(
      /Speicher: .*\d/,
    )
  }
  await expect(page.getByText(/Speicher gesamt: ca\. \d/)).toBeVisible()
})

test('unified inbox can be switched on and off', async ({ page }) => {
  await page.goto('/')
  let menu = await openSideMenu(page)
  // Off by default (principle 8): no "Alle Konten" entry.
  await expect(menu.getByRole('button', { name: /^Alle Konten/ })).toHaveCount(0)
  await page.keyboard.press('Escape')

  await openSettings(page)
  const toggle = page.getByLabel('Gemeinsamer Posteingang (alle Konten)')
  await expect(toggle).not.toBeChecked()
  await toggle.check()
  await backToMail(page)
  menu = await openSideMenu(page)
  await menu.getByRole('button', { name: /^Alle Konten/ }).click()
  const unified = page.getByRole('region', { name: 'Alle Posteingänge' })
  // Messages of both accounts, each tagged with its account.
  await expect(unified.getByText('Hallo 1')).toBeVisible()
  await expect(unified.getByText('Neu bei B')).toBeVisible()
  await expect(unified.locator('.account-tag').first()).toBeVisible()
  await unified.getByRole('button', { name: '← Konten' }).click()

  await openSettings(page)
  await toggle.uncheck()
  await expect(toggle).not.toBeChecked()
  await page.reload()
  await openSettings(page)
  await expect(page.getByLabel('Gemeinsamer Posteingang (alle Konten)')).not.toBeChecked()
  await backToMail(page)
  menu = await openSideMenu(page)
  await expect(menu.getByRole('button', { name: /^Alle Konten/ })).toHaveCount(0)
})
