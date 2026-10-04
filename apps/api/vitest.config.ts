import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Auth and account tests share the test database; run files sequentially.
    fileParallelism: false,
    // First-run setup requires a setup code (auth/setup-code.ts).
    env: { SETUP_TOKEN: 'test-setup-code' },
  },
})
