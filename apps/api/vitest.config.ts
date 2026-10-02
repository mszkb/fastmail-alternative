import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Auth and account tests share the test database; run files sequentially.
    fileParallelism: false,
  },
})
