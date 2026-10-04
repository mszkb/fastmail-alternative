# Release-Prozess (SemVer, Images, Signatur)

Releases sind Git-Tags `vX.Y.Z`. Zu jedem Tag baut [`.github/workflows/release.yml`](../../.github/workflows/release.yml) die Images für api, worker und web als Multi-Arch-Images (`linux/amd64`, `linux/arm64` – also auch für den Raspberry Pi), legt sie in der GitHub Container Registry ab und signiert sie keyless mit [cosign](https://docs.sigstore.dev/) (Sigstore). Bei Branches und Pull Requests läuft der Workflow nicht.

Die fertigen Images sind ein **Angebot, keine Voraussetzung**: Self-hosted first bleibt – `docker compose up -d --build --wait` baut wie bisher alles auf dem eigenen Server (Standard auf dem Pi, siehe [Upgrade](../operations/upgrade.md)).

## Versionsschema

[Semantic Versioning](https://semver.org/lang/de/) `MAJOR.MINOR.PATCH`, Tag mit Präfix `v` (`v0.3.1`). Vorabversionen mit Suffix: `v0.4.0-rc.1`.

Maßstab sind **Nutzer und Betreiber** (nicht interne Code-APIs):

| Änderung                                                                                                                                                             | ab 1.0 | vor 1.0 (`0.x`) |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | --------------- |
| Breaking Change für Betreiber oder Clients (API-Vertrag inkompatibel, `.env`-Variable entfernt/umbenannt, manueller Upgrade-Schritt, Volume/Compose-Dienst geändert) | Major  | Minor           |
| Neue Datenbankmigration, neue `.env`-Variable, neue Funktion                                                                                                         | Minor  | Minor           |
| Nur Fehlerbehebungen, ohne Migration und ohne Betreiber-Aufwand                                                                                                      | Patch  | Patch           |

Regeln:

- **Migrationen bedeuten mindestens Minor.** Ein Patch-Upgrade muss ohne Schemaänderung und ohne Handgriff möglich sein – und damit auch ein Patch-Rollback ohne Restore.
- Vor 1.0 gilt `0.MINOR` als Bruchstelle: Breaking Changes erhöhen die Minor-Version und stehen im Changelog mit `**Betreiber:** **BREAKING**`.
- Vorabversionen (`-rc.N`, `-beta.N`) bekommen kein `latest`.

## Image-Tags

Pro Release in `ghcr.io/<owner>/fastmail-alternative-{api,worker,web}`:

| Tag      | Bedeutung                                           |
| -------- | --------------------------------------------------- |
| `0.3.1`  | genau dieses Release (empfohlen, reproduzierbar)    |
| `0.3`    | neuestes Patch-Release der Minor-Linie              |
| `latest` | neuestes stabile Release (nicht bei Vorabversionen) |

Die Version steckt als `APP_VERSION` im Image (Build-Argument aus dem Tag) und erscheint in `/api/health` (`"version": "0.3.1"`). Lokale Builds ohne Argument melden `0.0.0-dev`.

## Ablauf

1. Auf `main` mit grüner CI: Version nach obiger Tabelle festlegen.
2. In [`CHANGELOG.md`](../../CHANGELOG.md) `## [Unreleased]` in `## [x.y.z] - JJJJ-MM-TT` umbenennen und darüber einen neuen, leeren `## [Unreleased]`-Abschnitt anlegen ([Changelog-Prozess](changelog.md)).
3. `"version"` in der Root-`package.json` auf `x.y.z` setzen.
4. Beides als Commit `Release vX.Y.Z` (per PR) nach `main` bringen.
5. Tag setzen und pushen:

   ```sh
   git checkout main && git pull
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```

6. Der Workflow „Release images“ baut, pusht und signiert die drei Images (arm64-Builds laufen per QEMU und dauern einige Minuten). Ein fehlgeschlagener Lauf kann per „Run workflow“ (`workflow_dispatch`) mit dem Tag als Eingabe wiederholt werden.
7. Ergebnis prüfen: Images in GHCR vorhanden (bei einem neuen Paket einmalig die Sichtbarkeit auf **public** stellen, sonst brauchen Betreiber ein Login), Signatur prüfen (unten).

Ein Tag wird nie verschoben oder neu vergeben; ein fehlerhaftes Release wird durch ein neues Patch-Release ersetzt.

## Signatur prüfen

Signiert wird der Digest des Multi-Arch-Index; die Identität ist der Release-Workflow dieses Repos (OIDC-Token von GitHub Actions, Eintrag im öffentlichen Transparenzlog Rekor):

```sh
cosign verify \
  --certificate-identity-regexp '^https://github\.com/mszkb/fastmail-alternative/\.github/workflows/release\.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/mszkb/fastmail-alternative-api:0.3.1
```

Für `worker` und `web` entsprechend. Bei einem per `workflow_dispatch` wiederholten Lauf lautet die Identität `…/release.yml@refs/heads/<branch>`; dann `@refs/` statt `@refs/tags/v` im Ausdruck verwenden. Für Forks `mszkb` durch den eigenen Owner ersetzen.

## Fertige Images verwenden (optional)

[`docker-compose.release.yml`](../../docker-compose.release.yml) ersetzt für web, api und worker den lokalen Build durch die Release-Images (benötigt Docker Compose ≥ 2.24.4):

```sh
export FMA_VERSION=0.3.1
docker compose -f docker-compose.yml -f docker-compose.release.yml pull
docker compose -f docker-compose.yml -f docker-compose.release.yml up -d --wait
```

`FMA_IMAGE_PREFIX` (Standard `ghcr.io/mszkb`) zeigt auf eine andere Registry oder einen Fork. Details für Betreiber: [Installation](../operations/installation.md#5-starten) und [Upgrade](../operations/upgrade.md#fertige-images-statt-lokal-bauen).
