import tailwindcss from '@tailwindcss/vite'

export default defineNuxtConfig({
  compatibilityDate: '2026-10-02',
  devtools: { enabled: true },
  // Pure client-side PWA: no SSR runtime, built as static files and served
  // by nginx (saves a node process on the server).
  ssr: false,
  // The service worker (scripts/build-sw.mjs) handles new versions with an
  // update prompt; Nuxt's build manifest polling is not needed.
  experimental: { appManifest: false },
  // Styling (#120): Tailwind CSS with daisyUI themes (light/dark), see
  // app/assets/css/main.css; built into a static CSS file (CSP style-src 'self').
  css: ['~/assets/css/main.css'],
  vite: { plugins: [tailwindcss()] },
  app: {
    head: {
      htmlAttrs: { lang: 'de' },
      title: 'fastmail-alternative',
      meta: [
        // viewport-fit=cover: the installed iOS app may draw under the notch
        // (safe-area insets are respected in the layout).
        {
          name: 'viewport',
          content: 'width=device-width, initial-scale=1, viewport-fit=cover',
        },
        { name: 'description', content: 'Self-hosted Mail-Client für mehrere Konten' },
        { name: 'theme-color', content: '#ffffff', media: '(prefers-color-scheme: light)' },
        { name: 'theme-color', content: '#161b22', media: '(prefers-color-scheme: dark)' },
        { name: 'color-scheme', content: 'light dark' },
        // iOS home screen app (roadmap 4.1/4.2): standalone, own title.
        { name: 'apple-mobile-web-app-capable', content: 'yes' },
        { name: 'mobile-web-app-capable', content: 'yes' },
        { name: 'apple-mobile-web-app-title', content: 'Mail' },
        { name: 'apple-mobile-web-app-status-bar-style', content: 'default' },
      ],
      link: [
        { rel: 'manifest', href: '/manifest.webmanifest' },
        { rel: 'icon', type: 'image/png', sizes: '32x32', href: '/icons/favicon-32.png' },
        { rel: 'apple-touch-icon', href: '/icons/apple-touch-icon.png' },
      ],
    },
  },
  // Local development: forward /api/* to the Fastify dev server (same paths
  // as behind caddy in production).
  nitro: {
    devProxy: {
      '/api/': { target: 'http://localhost:3001/api/', changeOrigin: true },
    },
  },
})
