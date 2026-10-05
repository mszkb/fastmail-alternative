import { expect, test } from '@playwright/test'
import { ACCOUNT_A, openAccount } from './helpers'

test('reads a message with inline image and attachment', async ({ page }) => {
  await openAccount(page, ACCOUNT_A)
  const list = page.getByRole('region', { name: 'Nachrichten' })
  await expect(list.getByText('Hallo 1')).toBeVisible()
  await expect(list.getByText('Hallo 3')).toBeVisible()

  await list.getByRole('button', { name: /Mit Anhang und Bild/ }).click()
  const detail = page.getByRole('region', { name: 'Nachricht' })
  await expect(detail.getByRole('heading', { name: 'Mit Anhang und Bild' })).toBeVisible()

  // Attachment list: only the real attachment, downloadable.
  const attachments = detail.getByRole('region', { name: 'Anhänge' })
  await expect(attachments.getByText('rechnung.pdf')).toBeVisible()
  await expect(attachments.getByRole('link', { name: 'Herunterladen' })).toHaveCount(1)
  const download = page.waitForEvent('download')
  await attachments.getByRole('link', { name: 'Herunterladen' }).click()
  expect((await download).suggestedFilename()).toBe('rechnung.pdf')

  // The cid: image renders inside the sandboxed HTML frame.
  const image = page
    .frameLocator('iframe[title="Nachrichteninhalt"]')
    .getByRole('img', { name: 'Logo' })
  await expect(image).toBeVisible()
  await expect
    .poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
    .toBeGreaterThan(0)

  // Opening marks it as read; back returns to the list.
  await expect(detail.getByRole('button', { name: 'Als ungelesen markieren' })).toBeVisible()
  await detail.getByRole('button', { name: '← Zurück' }).click()
  await expect(list.getByText('Hallo 1')).toBeVisible()
})
