import { defineConfig } from 'tsup'

export default defineConfig({
  // server.js: startApi/stopApi for the single-process native mode (scripts/native.mjs).
  entry: { main: 'src/main.ts', server: 'src/server.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // Bundle everything (@fma/shared, fastify): the runtime image ships no node_modules.
  noExternal: [/.*/],
  // Some CJS deps (avvio, pino) call require() at runtime; give the ESM
  // bundle a real require for builtins.
  banner: {
    js: "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);",
  },
})
