export default defineNuxtConfig({
  compatibilityDate: '2026-10-02',
  devtools: { enabled: true },
  // Pure client-side PWA: no SSR runtime, built as static files and served
  // by nginx (saves a node process on the server).
  ssr: false,
})
