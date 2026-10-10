import { expect, test, type Page, type Route } from '@playwright/test'
import { ACCOUNT_A, openAccount } from './helpers'

// Sync panel (#119). The first sync of the small test mailbox ends within a
// second, so the progress of a long first sync is simulated by rewriting
// the active account in GET /api/sync/status; "Stoppen" and "Jetzt
// synchronisieren" go to the real backend.

interface AccountRow {
  id: string
  displayName: string
  syncing: boolean
}

async function accountId(page: Page, displayName: string): Promise<string> {
  const res = await page.request.get('/api/accounts')
  const { accounts } = (await res.json()) as { accounts: AccountRow[] }
  return accounts.find((a) => a.displayName === displayName)!.id
}

async function inboxId(page: Page, account: string): Promise<string> {
  const res = await page.request.get(`/api/accounts/${account}/folders`)
  const { folders } = (await res.json()) as { folders: { id: string; specialUse: string | null }[] }
  return folders.find((f) => f.specialUse === 'inbox')!.id
}

test('sync panel shows progress, stops and starts again', async ({ page }) => {
  const probe = await page.request.get('/api/sync/status')
  test.skip(probe.status() === 404, 'backend without /api/sync/status (see the fallback test)')

  const account = await accountId(page, ACCOUNT_A)
  const folder = await inboxId(page, account)
  let fake: { state: string; done: number } | null = { state: 'running', done: 1240 }
  await page.route('**/api/sync/status', async (route: Route) => {
    const response = await route.fetch()
    const body = (await response.json()) as { accounts: Record<string, unknown>[] }
    if (fake) {
      body.accounts = body.accounts.map((s) =>
        s.accountId === account
          ? {
              ...s,
              state: fake!.state,
              phase: 'headers',
              folderId: folder,
              done: fake!.done,
              total: 8000,
              startedAt: new Date(Date.now() - 65_000).toISOString(),
              nextRunAt: null,
            }
          : s,
      )
    }
    await route.fulfill({ response, json: body })
  })

  await openAccount(page, ACCOUNT_A)
  const refresh = page.getByRole('button', { name: 'Wird aktualisiert' })
  await expect(refresh).toBeVisible()
  // Progress line under the list header while the active account syncs.
  await expect(page.getByText(/Posteingang – 1\s240 \/ 8\s000 Nachrichten/).first()).toBeVisible()

  const indicator = page.getByRole('button', { name: /^Synchronisierungsstatus/ })
  await expect(indicator).toHaveAttribute('aria-expanded', 'false')
  await indicator.click()
  await expect(indicator).toHaveAttribute('aria-expanded', 'true')
  const panel = page.getByRole('dialog', { name: 'Synchronisierung' })
  const row = panel.getByRole('listitem', { name: ACCOUNT_A })
  await expect(row.getByText(/Posteingang – 1\s240 \/ 8\s000 Nachrichten/)).toBeVisible()
  await expect(row.getByText('Neue Nachrichten laden')).toBeVisible()
  await expect(row.getByText(/seit 1:0\d/)).toBeVisible()
  const bar = row.getByRole('progressbar', { name: `Fortschritt ${ACCOUNT_A}` })
  await expect(bar).toHaveAttribute('aria-valuenow', '16')

  // The panel keeps polling while the sync runs.
  fake = { state: 'running', done: 4000 }
  await expect(row.getByText(/4\s000 \/ 8\s000/)).toBeVisible({ timeout: 10_000 })
  await expect(bar).toHaveAttribute('aria-valuenow', '50')

  // Stop: the real backend takes the request, the spinner stops at once.
  const cancel = page.waitForResponse(
    (r) =>
      r.request().method() === 'POST' && r.url().endsWith(`/api/accounts/${account}/sync/cancel`),
  )
  fake = { state: 'cancelling', done: 4000 }
  await row.getByRole('button', { name: 'Stoppen' }).click()
  expect((await cancel).status()).toBe(200)
  await expect(page.getByRole('button', { name: 'Aktualisieren', exact: true })).toBeVisible()
  await expect(row.getByText('Wird gestoppt …')).toBeVisible()
  // Stopped (not the real state: other specs may have queued a sync meanwhile).
  fake = { state: 'idle', done: 4000 }
  await expect(
    page.locator('[aria-live="polite"]', { hasText: 'Synchronisierung gestoppt' }),
  ).toHaveCount(1, {
    timeout: 10_000,
  })

  // Start again from the panel: same path as the refresh button.
  const sync = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith(`/api/accounts/${account}/sync`),
  )
  await row.getByRole('button', { name: 'Jetzt synchronisieren' }).click()
  const status = (await sync).status()
  expect([200, 202, 429]).toContain(status)
  if (status === 429) await expect(page.getByText('Gerade aktualisiert.')).toBeVisible()

  // Escape closes the panel and returns the focus to the indicator.
  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()
  await expect(indicator).toBeFocused()
})

test('without the status endpoint the panel falls back to "syncing"', async ({ page }) => {
  // Backends without /api/sync/status (e.g. an older server) answer 404; simulate that.
  await page.route('**/api/sync/status', (route) =>
    route.fulfill({ status: 404, json: { message: 'Not found' } }),
  )
  let syncing = true
  await page.route('**/api/accounts', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const response = await route.fetch()
    const body = (await response.json()) as { accounts: AccountRow[] }
    body.accounts = body.accounts.map((a) =>
      a.displayName === ACCOUNT_A ? { ...a, syncing: syncing || a.syncing } : a,
    )
    await route.fulfill({ response, json: body })
  })

  await openAccount(page, ACCOUNT_A)
  await expect(page.getByRole('button', { name: 'Wird aktualisiert' })).toBeVisible()
  await page.getByRole('button', { name: /^Synchronisierungsstatus/ }).click()
  const panel = page.getByRole('dialog', { name: 'Synchronisierung' })
  const row = panel.getByRole('listitem', { name: ACCOUNT_A })
  await expect(row.getByText('Wird synchronisiert')).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Stoppen' })).toHaveCount(0)
  await expect(panel.getByRole('button', { name: 'Alle stoppen' })).toHaveCount(0)

  // The account list poll (4.5) ends the spinner once the sync is over.
  syncing = false
  await expect(page.getByRole('button', { name: 'Aktualisieren', exact: true })).toBeVisible({
    timeout: 10_000,
  })
  await expect(row.getByRole('button', { name: 'Jetzt synchronisieren' })).toBeVisible()
})
