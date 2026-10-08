# fastmail-alternative

wip: self hosted fastmail-alternative

→ Planung: [ROADMAP.md](ROADMAP.md) · Doku: [docs/](docs/README.md) · Changelog: [CHANGELOG.md](CHANGELOG.md) · Sicherheit: [SECURITY.md](SECURITY.md) · Lizenz: [ISC](LICENSE)

## Installation

```sh
git clone https://github.com/mszkb/fastmail-alternative.git && cd fastmail-alternative
./scripts/setup-env.sh       # erzeugt .env mit MASTER_KEY – separat sichern!
# DOMAIN in .env auf die eigene Domain setzen
docker compose up -d --build --wait
```

Ohne Docker läuft das Backend auch auf Shared Hosting mit PHP 8.2+ und MySQL/MariaDB: [Installation auf Webspace](docs/operations/installation-php.md). Umstieg einer bestehenden Installation vom früheren Node-Backend: [Migration](docs/operations/migration.md#umstieg-auf-das-php-backend-postgresql--mysqlmariadb).

Ausführlich (Voraussetzungen, Ersteinrichtung, Push, Backup, Upgrade, Troubleshooting): [Betreiber-Doku](docs/operations/README.md)

## Systemanforderungen

Der komplette Stack (caddy, web, php, worker, mariadb) ist für einen Raspberry Pi mit 2 GB RAM ausgelegt (Speicherlimits in `docker-compose.yml`); die Messung im Leerlauf stammt noch vom früheren Node-Stack (**~200 MB RAM · ~0 % CPU · ~1 GB Disk**) und wird mit dem PHP-Stack wiederholt.

|          | Minimum                    | Empfohlen                         |
| -------- | -------------------------- | --------------------------------- |
| CPU      | 1 vCPU (arm64 oder x86-64) | 1–2 vCPU                          |
| RAM      | 1 GB (+ Swap/zram)         | 2 GB                              |
| Disk     | 8 GB **+ Postfachgröße**   | 32 GB **+ Postfachgröße**         |
| Netzwerk | –                          | Ports 80/443 öffentlich (für TLS) |

Details & Messung: [docs/operations/system-requirements.md](docs/operations/system-requirements.md)

## Entwicklung

```bash
pnpm install && (cd apps/server-php && composer install)
# DATABASE_URL=mysql://… und MASTER_KEY setzen (oder apps/server-php/config.php)
pnpm dev:api    # PHP-API (http://localhost:3001, /api/health)
pnpm dev:worker # PHP-Worker (Sync, Versand, Push)
pnpm dev:web    # Nuxt-PWA (http://localhost:3000, /api → 3001)
```

`pnpm lint` · `pnpm format` · `pnpm typecheck` · `pnpm build` · `make check`

ja.. es gibt auch sowas wie nextcloud die all deine mail konten speichert, aber A) schaut mist aus, B) einstellungsmöglichkeiten und regeln sind mehr C) ur langsam das ding und D) keine ios app mit push notification.
Und nein progress web app zählt hier nicht. Ich fang damit an, aber das ist nicht ziel der sache
