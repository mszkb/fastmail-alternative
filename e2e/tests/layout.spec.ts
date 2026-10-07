import { expect, test } from '@playwright/test'
import { ACCOUNT_A, escapeRegExp } from './helpers'

// Layout (#113): change folders, open a message, switch the reading pane,
// the choice (and a dragged width) stay after a reload. Wide screen.
test('reading pane right, below and off; kept after reload', async ({ browser }) => {
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
  const folders = page.getByRole('navigation', { name: 'Ordner' })
  const list = page.getByRole('region', { name: 'Nachrichten' })
  const detail = page.getByRole('region', { name: 'Nachricht', exact: true })
  await folders.getByRole('button', { name: /Posteingang/ }).click()
  await list.getByRole('button', { name: /Hallo 1/ }).click()
  await expect(detail.getByRole('heading', { name: 'Hallo 1' })).toBeVisible()
  await expect(list).toBeVisible()

  // Drag the list border to the right.
  const border = page.getByRole('separator', { name: 'Breite der Nachrichtenliste' })
  const before = Number(await border.getAttribute('aria-valuenow'))
  const box = (await border.boundingBox())!
  await page.mouse.move(box.x + 2, box.y + 200)
  await page.mouse.down()
  await page.mouse.move(box.x + 102, box.y + 200, { steps: 5 })
  await page.mouse.up()
  await expect(border).toHaveAttribute('aria-valuenow', String(before + 100))

  // Below: list and message both visible.
  await page.getByRole('button', { name: 'Lesebereich unten' }).click()
  await expect(page.getByRole('button', { name: 'Lesebereich unten' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(list).toBeVisible()
  await expect(detail.getByRole('heading', { name: 'Hallo 1' })).toBeVisible()

  // Off: the open message replaces the list; Escape goes back.
  await page.getByRole('button', { name: 'Ohne Lesebereich' }).click()
  await expect(list).toBeHidden()
  await page.keyboard.press('Escape')
  await expect(list).toBeVisible()

  await page.reload()
  await expect(page.getByRole('button', { name: 'Ohne Lesebereich' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  // Back to the default for the other specs, the width is remembered too.
  await page.getByRole('button', { name: 'Lesebereich rechts' }).click()
  await expect(
    page.getByRole('separator', { name: 'Breite der Nachrichtenliste' }),
  ).toHaveAttribute('aria-valuenow', String(before + 100))
  await context.close()
})
