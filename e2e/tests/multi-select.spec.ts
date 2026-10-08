import { expect, test } from '@playwright/test'
import { ACCOUNT_A, MAILBOX_A, createFolder, deliver, escapeRegExp, textMail } from './helpers'

// Message list (#114): select three messages and archive them; offline the
// action is queued (offline queue) and applied locally.
test('select three messages and archive them, online and offline', async ({ browser }) => {
  await createFolder(MAILBOX_A, 'Archive')
  const run = Date.now()
  const subjects = [1, 2, 3, 4, 5, 6].map((i) => `Auswahl ${run} ${i}`)
  for (const subject of subjects) await deliver(MAILBOX_A, textMail(MAILBOX_A, subject, 'x'))
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
    await expect(list.getByText(subjects[5]!)).toBeVisible({ timeout: 5_000 })
    await expect(page.getByRole('navigation', { name: 'Ordner' }).getByText('Archiv')).toBeVisible({
      timeout: 5_000,
    })
  }).toPass({ intervals: [3_000], timeout: 60_000 })

  // Today's mail is grouped under "Heute".
  await expect(list.locator('.date-group').first()).toHaveText(/Heute/i)

  // Checkbox, then Shift-click for the range: three messages.
  const box = (subject: string) => list.getByRole('checkbox', { name: `Auswählen: ${subject}` })
  await box(subjects[5]!).check()
  await box(subjects[3]!).click({ modifiers: ['Shift'] })
  const bar = page.getByRole('toolbar', { name: 'Auswahl' })
  await expect(bar.getByRole('status')).toHaveText('3 ausgewählt')
  await bar.getByRole('button', { name: 'Archivieren' }).click()
  for (const subject of subjects.slice(3)) await expect(list.getByText(subject)).toBeHidden()
  await expect(bar).toBeHidden()

  // Offline: the bulk action is queued and applied locally.
  await context.setOffline(true)
  for (const subject of subjects.slice(0, 3)) await box(subject).check()
  await expect(bar.getByRole('status')).toHaveText('3 ausgewählt')
  await bar.getByRole('button', { name: 'Archivieren' }).click()
  for (const subject of subjects.slice(0, 3)) await expect(list.getByText(subject)).toBeHidden()
  await expect(page.getByRole('status').filter({ hasText: /ausstehend/ })).toBeVisible()

  // Back online: the queue is replayed, all six end up in the archive.
  await context.setOffline(false)
  await expect(page.getByRole('status').filter({ hasText: /ausstehend/ })).toBeHidden({
    timeout: 30_000,
  })
  await page.keyboard.press('g')
  await page.keyboard.press('a')
  for (const subject of subjects)
    await expect(list.getByText(subject)).toBeVisible({ timeout: 30_000 })
  await context.close()
})
