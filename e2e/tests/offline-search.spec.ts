import { expect, test } from '@playwright/test'
import { ACCOUNT_A, MAILBOX_A, deliver, escapeRegExp, textMail } from './helpers'

// Offline search (#162): without a connection the global search filters the
// messages cached on the device; back online, "Online erneut suchen" runs
// the full search at the providers.
test('offline: search the cached messages, open a hit, search online again', async ({
  browser,
}) => {
  test.setTimeout(120_000)
  const run = Date.now()
  const first = `Offline ${run} Rechnung`
  const second = `Offline ${run} Einladung`
  const base = Date.now() - 60_000
  await deliver(
    MAILBOX_A,
    textMail(MAILBOX_A, first, `Projekt Zebra${run} ist fertig`, new Date(base)),
  )
  await deliver(MAILBOX_A, textMail(MAILBOX_A, second, 'Bis bald', new Date(base + 1000)))
  const context = await browser.newContext({
    storageState: '.auth/state.json',
    viewport: { width: 1280, height: 800 },
  })
  const page = await context.newPage()
  await page.goto('/')
  await page
    .getByRole('navigation', { name: 'Konten' })
    .getByRole('button', { name: new RegExp(`^${escapeRegExp(ACCOUNT_A)},`) })
    .click()
  const list = page.getByRole('region', { name: 'Nachrichten' })
  await expect(async () => {
    await page.getByRole('button', { name: 'Aktualisieren', exact: true }).click()
    await expect(list.getByText(second)).toBeVisible({ timeout: 5_000 })
  }).toPass({ intervals: [3_000], timeout: 60_000 })
  // Opening caches the message with its text.
  await list.getByText(first).click()
  await expect(page.getByText(`Projekt Zebra${run} ist fertig`)).toBeVisible()

  await context.setOffline(true)
  const field = page.getByRole('banner').getByLabel('Suchbegriff')
  const results = page.getByRole('region', { name: 'Suche in allen Konten' })
  // The list cache is written shortly after the last change: search until it has both.
  await expect(async () => {
    await field.fill(`Offline ${run}`)
    await page.keyboard.press('Enter')
    await expect(results.getByRole('status')).toHaveText('2 gespeicherte Treffer', {
      timeout: 1_000,
    })
  }).toPass({ timeout: 15_000 })
  await expect(results.getByRole('note')).toContainText(
    'Offline – nur gespeicherte Nachrichten durchsucht',
  )
  const items = results.getByRole('listitem')
  await expect(items.first()).toContainText(second)
  await expect(items.nth(1)).toContainText(first)
  await expect(results.getByRole('button', { name: 'Online erneut suchen' })).toHaveCount(0)

  // The text of an opened mail is searched as well; operators work offline.
  await field.fill(`zebra${run} from:alice`)
  await page.keyboard.press('Enter')
  await expect(results.getByRole('status')).toHaveText('1 gespeicherte Treffer')
  await expect(items.first()).toContainText(first)

  // Nothing about the search is stored on the device.
  const stored = await page.evaluate(async () => {
    const local = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage })
    const keys = await new Promise<string>((resolve) => {
      const open = indexedDB.open('fma-offline')
      open.onsuccess = () => {
        const db = open.result
        const names = Array.from(db.objectStoreNames)
        const tx = db.transaction(names)
        const all: unknown[] = []
        for (const name of names) {
          const req = tx.objectStore(name).getAllKeys()
          req.onsuccess = () => all.push(...req.result)
        }
        tx.oncomplete = () => resolve(JSON.stringify(all))
      }
      open.onerror = () => resolve('')
    })
    return local + keys
  })
  expect(stored.toLowerCase()).not.toContain(`zebra${run}`)

  // A hit opens offline from the cache.
  await items.first().getByRole('button').click()
  const detail = page.getByRole('region', { name: 'Nachricht', exact: true })
  await expect(detail.getByRole('heading', { name: first })).toBeVisible()
  await expect(detail.getByText(`Projekt Zebra${run} ist fertig`)).toBeVisible()

  // Back online: the full search is offered.
  await field.fill(`Offline ${run}`)
  await page.keyboard.press('Enter')
  await expect(results.getByRole('status')).toHaveText('2 gespeicherte Treffer')
  await context.setOffline(false)
  await results.getByRole('button', { name: 'Online erneut suchen' }).click()
  await expect(results.getByRole('note')).toHaveCount(0)
  await expect(results.getByRole('status')).toHaveText('2 Treffer', { timeout: 45_000 })
  await context.close()
})
