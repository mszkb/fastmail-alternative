import { expect, test } from '@playwright/test'
import { ACCOUNT_A, MAILBOX_A, MAILBOX_B, appendOld, createFolder, textMail } from './helpers'

// Global search (#121): search field in the header, hits of all accounts
// merged by date, loading more while scrolling, opening a hit, ending the search.

const run = process.env.E2E_RUN!

test('header search across accounts: more hits while scrolling, open, end', async ({ browser }) => {
  // 60 hits in B (more than one page of 50) and one in A, newest last - in
  // folders of their own, so the inboxes the other specs use stay as they are.
  const folder = `Sammel-${run}`
  await createFolder(MAILBOX_A, folder)
  await createFolder(MAILBOX_B, folder)
  const base = Date.now() - 3_600_000
  for (let i = 1; i <= 60; i++) {
    const subject = `Sammel ${run} B${String(i).padStart(2, '0')}`
    const date = new Date(base + i * 1000)
    await appendOld(MAILBOX_B, textMail(MAILBOX_B, subject, 'Text', date), date, folder)
  }
  const dateA = new Date(base + 90_000)
  await appendOld(MAILBOX_A, textMail(MAILBOX_A, `Sammel ${run} A`, 'Text', dateA), dateA, folder)

  const context = await browser.newContext({
    storageState: '.auth/state.json',
    viewport: { width: 1280, height: 800 },
  })
  const page = await context.newPage()
  await page.goto('/')
  // The search covers folders the server knows: sync until both have the new one.
  const accounts = (await (await page.request.get('/api/accounts')).json()) as {
    accounts: { id: string }[]
  }
  await expect(async () => {
    await page.request.post('/api/sync')
    for (const account of accounts.accounts) {
      const res = await page.request.get(`/api/accounts/${account.id}/folders`)
      expect(JSON.stringify(await res.json())).toContain(folder)
    }
  }).toPass({ timeout: 60_000, intervals: [2_000] })
  await page.getByRole('banner').getByLabel('Suchbegriff').fill(`subject:"Sammel ${run}"`)
  await page.keyboard.press('Enter')

  const results = page.getByRole('region', { name: 'Suche in allen Konten' })
  const items = results.getByRole('listitem').filter({ hasText: `Sammel ${run}` })
  // Newest first across accounts: the hit of A, then B60, B59, ...
  await expect(items).toHaveCount(50, { timeout: 30_000 })
  await expect(items.first()).toContainText(`Sammel ${run} A`)
  await expect(items.nth(1)).toContainText(`Sammel ${run} B60`)
  await expect(results.getByRole('status')).toHaveText('1–50 von ca. 61')
  // The term is highlighted, the account icon shows the initials.
  await expect(items.first().locator('mark').first()).toHaveText(`Sammel`)
  await expect(items.first().locator('.avatar')).toHaveText(/^P/)

  // Scrolling to the end loads the rest.
  await items.last().scrollIntoViewIfNeeded()
  await expect(items).toHaveCount(61, { timeout: 30_000 })
  await expect(items.last()).toContainText(`Sammel ${run} B01`)
  await expect(results.getByRole('status')).toHaveText('61 Treffer')

  // Scope: only the active account (A).
  await results.getByLabel('Nur dieses Konto').check()
  await expect(items).toHaveCount(1, { timeout: 30_000 })

  // Hits without a local copy yet cannot be opened; a synced one opens in its account.
  await page.getByRole('banner').getByLabel('Suchbegriff').fill('subject:"Hallo 2"')
  await page.keyboard.press('Enter')
  await results.getByLabel('Alle Konten').check()
  const hallo = results.getByRole('listitem').filter({ hasText: 'Hallo 2' })
  await expect(hallo.getByRole('button')).toBeEnabled({ timeout: 30_000 })
  await hallo.getByRole('button').click()
  await expect(results).toBeHidden()
  const detail = page.getByRole('region', { name: 'Nachricht', exact: true })
  await expect(detail.getByRole('heading', { name: 'Hallo 2' })).toBeVisible({ timeout: 20_000 })
  await expect(
    page
      .getByRole('navigation', { name: 'Konten' })
      .getByRole('button', { name: new RegExp(`^${ACCOUNT_A},`) }),
  ).toHaveAttribute('aria-current', 'true')

  await page.getByRole('banner').getByLabel('Suchbegriff').fill(`Sammel ${run}`)
  await page.keyboard.press('Enter')
  await expect(results).toBeVisible()
  await results.getByRole('button', { name: 'Suche beenden' }).click()
  await expect(results).toBeHidden()
  await expect(page.getByRole('region', { name: 'Nachrichten' })).toBeVisible()
  await context.close()
})
