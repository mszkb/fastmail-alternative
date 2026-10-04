# fastmail-alternative

wip: self hosted fastmail-alternative

→ Planung: [ROADMAP.md](ROADMAP.md) · Doku: [docs/](docs/README.md) · Lizenz: [ISC](LICENSE)

## Installation

```sh
git clone https://github.com/mszkb/fastmail-alternative.git && cd fastmail-alternative
node scripts/setup-env.mjs   # erzeugt .env mit MASTER_KEY – separat sichern!
# DOMAIN in .env auf die eigene Domain setzen
docker compose up -d --build --wait
```

Ausführlich (Voraussetzungen, Ersteinrichtung, Push, Backup, Upgrade, Troubleshooting): [Betreiber-Doku](docs/operations/README.md)

## Systemanforderungen

Der komplette Stack (caddy, web, api, worker, postgres) läuft komfortabel auf einem Raspberry Pi mit 2 GB RAM – gemessen im Leerlauf: **~200 MB RAM · ~0 % CPU · ~1 GB Disk**.

|          | Minimum                    | Empfohlen                         |
| -------- | -------------------------- | --------------------------------- |
| CPU      | 1 vCPU (arm64 oder x86-64) | 1–2 vCPU                          |
| RAM      | 1 GB (+ Swap/zram)         | 2 GB                              |
| Disk     | 8 GB **+ Postfachgröße**   | 32 GB **+ Postfachgröße**         |
| Netzwerk | –                          | Ports 80/443 öffentlich (für TLS) |

Details & Messung: [docs/operations/system-requirements.md](docs/operations/system-requirements.md)

## Entwicklung

```bash
pnpm install
pnpm dev:web    # Nuxt-PWA (http://localhost:3000)
pnpm dev:api    # Fastify-API (http://localhost:3001, /api/health)
pnpm dev:worker # Worker-Skeleton
```

`pnpm lint` · `pnpm format` · `pnpm typecheck` · `pnpm build`

ja.. es gibt auch sowas wie nextcloud die all deine mail konten speichert, aber A) schaut mist aus, B) einstellungsmöglichkeiten und regeln sind mehr C) ur langsam das ding und D) keine ios app mit push notification.
Und nein progress web app zählt hier nicht. Ich fang damit an, aber das ist nicht ziel der sache
