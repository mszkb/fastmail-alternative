import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Auth and account tests share the test database; run files sequentially.
    fileParallelism: false,
    // First-run setup requires a setup code (auth/setup-code.ts).
    // Test-only transport (GreenMail on plain ports, local fake push
    // service); MAIL_ALLOW_PRIVATE_HOSTS comes from the environment.
    env: { SETUP_TOKEN: 'test-setup-code', MAIL_INSECURE_TRANSPORT: '1' },
  },
})
