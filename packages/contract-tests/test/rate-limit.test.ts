// Runs as a separate vitest invocation after the other files (package.json),
// though each Client has its own X-Forwarded-For address anyway.
import { describe, expect, it } from 'vitest'
import { API_URL, Client } from '../src/client'

describe.skipIf(!API_URL)('rate limits', () => {
  it('answers 429 with Retry-After after 600 requests per minute and IP', async () => {
    const client = new Client()
    let limited
    for (let i = 0; i < 601 && !limited; i++) {
      const response = await client.request('GET', '/api/does-not-exist')
      if (response.status === 429) limited = response
    }
    expect(limited, 'no 429 within 601 requests').toBeDefined()
    expect(limited!.body).toEqual({
      message: 'Zu viele Anfragen. Bitte kurz warten und erneut versuchen.',
    })
    const retryAfter = Number(limited!.headers.get('retry-after'))
    expect(retryAfter).toBeGreaterThanOrEqual(1)
    expect(retryAfter).toBeLessThanOrEqual(60)
    // Another client address is not affected.
    expect((await new Client().request('GET', '/api/health')).status).toBe(200)
  })
})
