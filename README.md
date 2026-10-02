# fastmail-alternative

wip: self hosted fastmail-alternative

→ Planung: [ROADMAP.md](ROADMAP.md) · Doku: [docs/](docs/README.md) · Lizenz: [ISC](LICENSE)

## Entwicklung

```bash
pnpm install
pnpm dev:web    # Nuxt-PWA (http://localhost:3000)
pnpm dev:api    # Fastify-API (http://localhost:3001, /health)
pnpm dev:worker # Worker-Skeleton
```

`pnpm lint` · `pnpm format` · `pnpm typecheck` · `pnpm build`

ja.. es gibt auch sowas wie nextcloud die all deine mail konten speichert, aber A) schaut mist aus, B) einstellungsmöglichkeiten und regeln sind mehr C) ur langsam das ding und D) keine ios app mit push notification.
Und nein progress web app zählt hier nicht. Ich fang damit an, aber das ist nicht ziel der sache
