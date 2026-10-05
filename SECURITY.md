# Security-Policy

## Unterstützte Versionen

Es gibt noch keine getaggten Releases (Release-Images und SemVer folgen mit Roadmap 7.2). Sicherheitskorrekturen gibt es nur für den aktuellen Stand von `main` bzw. später die jeweils neueste Version. Bitte vor einer Meldung prüfen, ob das Problem mit dem aktuellen Stand noch besteht ([Upgrade](docs/operations/upgrade.md)).

| Version             | Unterstützt |
| ------------------- | ----------- |
| `main` / neueste    | ja          |
| ältere Commits/Tags | nein        |

## Sicherheitslücke melden

**Bitte keine öffentlichen Issues, Diskussionen oder Pull Requests für Sicherheitslücken.**

Meldungen bitte vertraulich über **GitHub Private Vulnerability Reporting**: im Repository den Tab **„Security"** öffnen → **„Report a vulnerability"** ([direkt](https://github.com/mszkb/fastmail-alternative/security/advisories/new)).

Hilfreich sind:

- betroffene Version (`git rev-parse --short HEAD`) und Komponente (web, api, worker, Deployment)
- Beschreibung, Auswirkung und Schritte zum Nachstellen bzw. Proof of Concept
- ggf. Vorschlag zur Behebung

**Keine echten Mailinhalte, Betreffzeilen, Adressen, Zugangsdaten, `.env`-Inhalte oder den `MASTER_KEY` in Meldungen aufnehmen** – Testdaten (z. B. `user@example.com`) genügen.

## Ablauf

Das Projekt wird von Freiwilligen gepflegt; die folgenden Zeiten sind Absicht, keine Garantie:

- Eingangsbestätigung innerhalb von 7 Tagen
- erste Einschätzung (Schweregrad, betroffene Versionen) innerhalb von 14 Tagen
- Behebung je nach Schweregrad so schnell wie möglich; kritische Lücken haben Vorrang vor allem anderen
- Veröffentlichung eines Security Advisorys und eines Eintrags unter „Security" im [Changelog](CHANGELOG.md) nach dem Fix, auf Wunsch mit Nennung der meldenden Person

## Scope

Im Scope ist der Code dieses Repositories in einer self-hosted Instanz nach der [Betreiber-Doku](docs/operations/README.md), insbesondere:

- Authentifizierung, Sessions, CSRF, Rate Limits
- Verschlüsselung at rest (Zugangsdaten, Mailinhalte, Backups) und Umgang mit dem `MASTER_KEY`
- Rendering von HTML-Mails und Anhängen (XSS, Remote-Content), SSRF bei Kontoverbindungen
- Datenlecks in Logs, Fehlermeldungen, Push-Payloads oder Exporten
- Die mitgelieferte Docker-Compose-/Caddy-Konfiguration

Nicht im Scope:

- Fehlkonfiguration der eigenen Instanz entgegen der Doku (z. B. veröffentlichte `.env`, fehlendes TLS, offen erreichbare Datenbank)
- Schwachstellen beim Mailanbieter, im Betriebssystem, in Docker oder im Browser selbst (bitte dort melden); Schwachstellen in Abhängigkeiten nur, wenn sie in diesem Projekt tatsächlich ausnutzbar sind
- Angriffe mit physischem Zugriff auf Server oder entsperrtes Gerät
- Denial of Service durch reine Last (Volumen-Angriffe) sowie Social Engineering
- Fremde oder öffentliche Instanzen – keine Tests gegen Instanzen, die dir nicht gehören

---

**English summary:** Only the latest `main` is supported. Please report vulnerabilities privately via GitHub Private Vulnerability Reporting (Security tab → "Report a vulnerability"), never in public issues, and do not include real mail content, addresses or credentials. We aim to acknowledge within 7 days and assess within 14 days (best effort). Scope is this repository's code in a self-hosted instance deployed per the docs.
