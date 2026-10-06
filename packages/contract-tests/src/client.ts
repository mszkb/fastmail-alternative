/**
 * HTTP client for the contract tests (#96): talks to any backend at
 * API_URL, keeps the session cookie and sends a per-client
 * X-Forwarded-For, so every test file has its own rate-limit and lockout
 * counters (the backends trust X-Forwarded-For from a loopback peer).
 *
 * Every JSON response is validated against the operation in
 * docs/api/openapi.yaml for its method, path pattern and status code.
 */
import { randomInt } from 'node:crypto'
import { expect } from 'vitest'
import { validateResponse } from './openapi'

export const API_URL = process.env.API_URL?.replace(/\/$/, '') ?? ''
/** Setup code of the backend under test (SETUP_TOKEN). */
export const SETUP_TOKEN = process.env.SETUP_TOKEN ?? 'e2e-setup-code'
/** Login of the single user the contract tests create or reuse. */
export const USER = {
  email: process.env.CONTRACT_EMAIL ?? 'contract@example.org',
  password: process.env.CONTRACT_PASSWORD ?? 'contract-password-1',
}

export interface ApiResponse {
  status: number
  headers: Headers
  body: unknown
  text: string
}

export class Client {
  private cookie = ''
  readonly ip = `198.51.100.${randomInt(1, 254)}`

  /** Same-origin browser request by default (passes the CSRF check). */
  async request(
    method: string,
    path: string,
    options: { body?: unknown; headers?: Record<string, string>; pattern?: string } = {},
  ): Promise<ApiResponse> {
    const headers: Record<string, string> = {
      'x-forwarded-for': this.ip,
      'sec-fetch-site': 'same-origin',
      ...(this.cookie ? { cookie: this.cookie } : {}),
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...options.headers,
    }
    for (const [name, value] of Object.entries(headers)) if (value === '') delete headers[name]
    const response = await fetch(`${API_URL}${path}`, {
      method,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      redirect: 'manual',
    })
    const setCookie = response.headers.getSetCookie().find((c) => c.startsWith('fma_session='))
    if (setCookie) {
      const value = setCookie.split(';')[0]!
      this.cookie = value === 'fma_session=' ? '' : value
    }
    const text = await response.text()
    const isJson = (response.headers.get('content-type') ?? '').includes('application/json')
    const body: unknown = isJson && text !== '' ? JSON.parse(text) : text
    const errors = validateResponse(
      method,
      options.pattern ?? path,
      response.status,
      isJson ? body : undefined,
    )
    expect(
      errors,
      `${method} ${path} -> ${response.status} does not match the OpenAPI spec`,
    ).toEqual([])
    return { status: response.status, headers: response.headers, body, text }
  }

  get hasSession(): boolean {
    return this.cookie !== ''
  }

  /** Creates the user on a fresh backend, otherwise logs in. */
  async signIn(): Promise<void> {
    const status = await this.request('GET', '/api/auth/status')
    const { needsSetup } = status.body as { needsSetup: boolean }
    const response = needsSetup
      ? await this.request('POST', '/api/auth/setup', {
          body: { ...USER, setupCode: SETUP_TOKEN, deviceName: 'contract', platform: 'web' },
        })
      : await this.request('POST', '/api/auth/login', {
          body: { ...USER, deviceName: 'contract', platform: 'web' },
        })
    expect(response.status, 'sign-in (setup or login) failed').toBe(200)
  }
}
