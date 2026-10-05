import { defineConfig, devices } from '@playwright/test'

// One id per run (inherited by the worker processes): every run gets its own
// GreenMail mailboxes, so a reused local stack keeps working.
process.env.E2E_RUN ??= String(Date.now())

const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:4173'

export default defineConfig({
  testDir: 'tests',
  // The flows share one instance (single user) and build on each other.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // A horizontal touch drag must reach the app's swipe-back, not the
    // browser's own history navigation (full Chromium, not headless shell).
    launchOptions: { args: ['--disable-features=OverscrollHistoryNavigation'] },
  },
  projects: [
    { name: 'setup', testMatch: /setup\.ts$/, use: { ...devices['Pixel 7'] } },
    {
      // Phone viewport with touch (Chromium: CDP touch events for the gestures).
      name: 'mobile',
      dependencies: ['setup'],
      use: { ...devices['Pixel 7'], storageState: '.auth/state.json' },
    },
  ],
  // Without E2E_BASE_URL: start api, worker and web from the build output.
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'node stack.mjs',
        url: `${baseURL}/api/health`,
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
        env: { DATABASE_URL: process.env.E2E_DATABASE_URL ?? process.env.DATABASE_URL ?? '' },
      },
})
