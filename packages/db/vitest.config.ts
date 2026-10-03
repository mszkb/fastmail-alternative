import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The migrate test drops/creates tables; run files sequentially.
    fileParallelism: false,
  },
})
