import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The test files share the test database; run sequentially. IMAP syncs
    // over SSH tunnels are slow, hence the generous timeout.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
