# Systemanforderungen & gemessener Ressourcenverbrauch

> Gemessen auf dem Referenz-Deployment: Raspberry Pi (arm64, 2 GB RAM, SD-Karte), Debian 13, rootless Docker. Stand: 2026-10-02, Phase 1 (Skeleton ohne Mail-Daten).

## Gemessener Verbrauch (Stack im Leerlauf, alles healthy)

| Service                 | RAM         | CPU (idle)                                |
| ----------------------- | ----------- | ----------------------------------------- |
| `api` (Fastify)         | 78 MB       | ~0 %                                      |
| `worker`                | 49 MB       | ~0 %                                      |
| `caddy`                 | 44 MB       | ~0 %                                      |
| `postgres` (getunt)     | 19 MB       | ~0 %                                      |
| `web` (nginx, statisch) | 5 MB        | ~0 %                                      |
| **Stack gesamt**        | **~195 MB** | **0 %** (0 CPU-Sekunden in 30 s Wandzeit) |

Auf dem Referenzsystem sind inklusive Betriebssystem 546 MB von 1,8 GB belegt – der Stack nutzt ~10 % des RAM.

**Disk:**

| Was                                               | Größe          |
| ------------------------------------------------- | -------------- |
| Images (web, api, worker, postgres, caddy)        | ~810 MB        |
| Volumes (postgres-data, caddy-*, noch ohne Mails) | ~75 MB         |
| Root-Dateisystem gesamt (inkl. OS)                | 7,8 GB / 29 GB |

Der Build-Cache wächst bei jedem Image-Build (bis mehrere GB) und sollte gelegentlich mit `docker builder prune -af` geleert werden – er ist jederzeit gefahrlos löschbar.

## Anforderungen

|             | Minimum                      | Empfohlen                                                                                       |
| ----------- | ---------------------------- | ----------------------------------------------------------------------------------------------- |
| CPU         | 1 vCPU                       | 1–2 vCPU                                                                                        |
| RAM         | 1 GB (+ Swap/zram)           | 2 GB                                                                                            |
| Disk        | 8 GB **+ Postfachgröße**     | 32 GB **+ Postfachgröße**                                                                       |
| Architektur | linux/arm64 oder linux/amd64 | –                                                                                               |
| Netzwerk    | –                            | Ports 80/443 öffentlich erreichbar (für Let's-Encrypt-TLS, sobald eine Domain konfiguriert ist) |

Software: Docker (Engine + Compose-Plugin) auf Linux; Rootless-Betrieb wird empfohlen und ist getestet.

## Wachstum im Betrieb

- **`mail-data`-Volume** (verschlüsselte Rohmails und Anhänge, ADR-0001) skaliert mit der Summe aller verbundenen Postfächer – das ist der dominierende Speicherfaktor.
- **postgres** bleibt bei Einzelbenutzer klein: Metadaten inkl. verschlüsselnder Betreff-/Snippet-Felder liegen im Bereich weniger MB bis ~100 MB bei großen Postfächern.
- **RAM-Spitzen** nur beim IMAP-Initial-Sync (Verschlüsselung + Schreiben); danach kehrt der Stack ins Leerlauf-Niveau zurück. Memory-Limits in der `docker-compose.yml` deckeln jeden Service hart. Richtwert: Eine große Mail belegt beim Sync (Download, binäre Verschlüsselung, Text-Extraktion ohne Anhänge im Speicher) bis etwa das 5-Fache ihrer Größe – bei `MAX_RAW_MESSAGE_BYTES` = 20 MB rund 100 MB je gleichzeitig laufendem Job (`WORKER_CONCURRENCY`, Standard 4; Worker-Limit 384 MB). Die HTML-Ansicht der API braucht für eine 20-MB-Mail rund 60 MB (Anhänge werden gestreamt und verworfen, nur kleine Inline-Bilder bleiben im Speicher). Wer das Limit senkt (z. B. auf 1 GB-Systemen), setzt `MAX_RAW_MESSAGE_BYTES` und/oder `WORKER_CONCURRENCY` in der `.env` herunter.
- **Logs** sind auf 10 MB × 3 Dateien pro Service rotiert.

## Hinweis zu Memory-Limits auf Raspberry-Pi-Systemen

Die Limits in der `docker-compose.yml` setzen einen Memory-Cgroup-Controller voraus. Viele Pi-Images booten mit `cgroup_disable=memory` (Firmware-Default, spart wenige MB RAM) – dann sind die Limits wirkungslos, der Stack läuft aber unverändert. Aktivierung optional per `cgroup_enable=memory` in `/boot/firmware/cmdline.txt` + Neustart; auf typischen VPS ist der Controller vorhanden und die Limits greifen direkt.

## Backup (Vorblick)

Der `MASTER_KEY` aus der `.env` muss **getrennt vom Datenbank-Backup** gesichert werden – geht er verloren, sind alle verschlüsselten Mails und Zugangsdaten unlesbar. Details: [Key-Rotation](../process/key-rotation.md). Umzug auf einen neuen Server (Backup/Restore bzw. Konfigurations-Export): [Migration](migration.md). Vollständiges Backup-/Restore-Konzept: Roadmap 6.2.
