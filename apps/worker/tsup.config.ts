import { defineConfig } from 'tsup'

export default defineConfig({
  // backup.js: encrypted backup/restore CLI (docs/operations/backup-restore.md).
  entry: { main: 'src/main.ts', backup: 'src/backup-cli.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // Bundle everything (@fma/shared, pino): the runtime image ships no node_modules.
  noExternal: [/.*/],
  banner: {
    js: "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);",
  },
})
