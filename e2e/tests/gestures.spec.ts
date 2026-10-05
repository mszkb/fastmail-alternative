import { expect, test } from '@playwright/test'
import { ACCOUNT_A, MAILBOX_A, deliver, openAccount, textMail, touchDrag } from './helpers'

// The server accepts one manual sync per account and 30 s (the app start
// already asked for one), so the flow is: pull right after the start ->
// "Gerade aktualisiert.", later the button fetches the new mail.
test('pull-to-refresh and refresh button fetch new mail without reload', async ({ page }) => {
  await openAccount(page, ACCOUNT_A)
  const list = page.getByRole('region', { name: 'Nachrichten' })
  await expect(list.getByText('Hallo 1')).toBeVisible()
  const subject = `Aktualisiert ${Date.now()}`
  await deliver(MAILBOX_A, textMail(MAILBOX_A, subject, 'neu'))
  const isSync = (r: { request(): { method(): string }; url(): string }) =>
    r.request().method() === 'POST' && /\/api\/accounts\/[^/]+\/sync$/.test(r.url())

  // While the start sync runs, pulls are ignored (button disabled).
  await expect(page.getByRole('button', { name: 'Aktualisieren' })).toBeEnabled()
  const box = (await list.locator('.messages').boundingBox())!
  const start = { x: box.x + box.width / 2, y: box.y + 10 }
  // A short pull (below the threshold) does nothing.
  let synced = false
  const onResponse = (r: Parameters<typeof isSync>[0]) => {
    if (isSync(r)) synced = true
  }
  page.on('response', onResponse)
  await touchDrag(page, start, { x: start.x, y: start.y + 60 })
  await page.waitForTimeout(500)
  expect(synced).toBe(false)
  page.off('response', onResponse)

  const pulled = page.waitForResponse(isSync)
  await touchDrag(page, start, { x: start.x, y: start.y + 250 })
  if ((await pulled).status() === 429) {
    await expect(page.getByText('Gerade aktualisiert.')).toBeVisible()
  }

  // Refresh button until the server takes the request (202), then the new
  // mail shows up in the open list.
  await expect(async () => {
    if (await list.getByText(subject).isVisible()) return
    const response = page.waitForResponse(isSync)
    await page.getByRole('button', { name: 'Aktualisieren' }).click()
    expect((await response).status()).toBe(202)
  }).toPass({ intervals: [5_000], timeout: 45_000 })
  await expect(list.getByText(subject)).toBeVisible({ timeout: 20_000 })
})

test('swipe right goes back from a message to the list', async ({ page }) => {
  await openAccount(page, ACCOUNT_A)
  const list = page.getByRole('region', { name: 'Nachrichten' })
  await list.getByRole('button', { name: /Hallo 2/ }).click()
  const detail = page.getByRole('region', { name: 'Nachricht' })
  await expect(detail.getByRole('heading', { name: 'Hallo 2' })).toBeVisible()
  await expect(list).toBeHidden()

  const viewport = page.viewportSize()!
  const y = viewport.height / 2
  // Starts in the left 20 px are left to the browser's own back gesture.
  await touchDrag(page, { x: 5, y }, { x: 200, y })
  await expect(list).toBeHidden()
  await touchDrag(page, { x: 60, y }, { x: 260, y })
  await expect(list).toBeVisible()
  await expect(list.getByText('Hallo 2')).toBeVisible()
})

test('swipe back never drops a half-filled form', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Einstellungen' }).click()
  const form = page.locator('form', {
    has: page.getByRole('heading', { name: 'Konto hinzufügen' }),
  })
  await form.getByLabel('E-Mail-Adresse des Kontos').fill('halb@example.org')
  await form.getByLabel('Anzeigename (optional)').fill('Halb ausgefüllt')

  const viewport = page.viewportSize()!
  const y = 120 // on the card heading, not on an input
  await touchDrag(page, { x: 60, y }, { x: 280, y })
  await expect(form.getByLabel('E-Mail-Adresse des Kontos')).toHaveValue('halb@example.org')
  await expect(form.getByLabel('Anzeigename (optional)')).toHaveValue('Halb ausgefüllt')

  // Untouched settings: the swipe goes back to the mail view.
  await page.reload()
  await page.getByRole('button', { name: 'Einstellungen' }).click()
  await expect(page.getByRole('heading', { name: 'Konto hinzufügen' })).toBeVisible()
  await touchDrag(page, { x: 60, y: viewport.height / 3 }, { x: 280, y: viewport.height / 3 })
  await expect(page.getByRole('heading', { name: 'Konto hinzufügen' })).toBeHidden()

  // An open compose form ignores the swipe: the text stays.
  await openAccount(page, ACCOUNT_A)
  await page.getByRole('button', { name: 'Neue E-Mail' }).click()
  const compose = page.getByRole('dialog')
  await compose.getByLabel('Nachricht').fill('Nicht verlieren')
  await touchDrag(page, { x: 60, y: viewport.height / 2 }, { x: 280, y: viewport.height / 2 })
  await expect(compose.getByLabel('Nachricht')).toHaveValue('Nicht verlieren')
})
