# Changelog-Prozess

Das [`CHANGELOG.md`](../../CHANGELOG.md) im Repo-Root folgt [Keep a Changelog](https://keepachangelog.com/de/1.1.0/). Es richtet sich an Nutzer und Betreiber, nicht an Entwickler – die Commit-Historie bleibt die technische Quelle.

## Bei jedem PR

- Jeder PR mit **nutzer- oder betreiberrelevanter Änderung** ergänzt `## [Unreleased]` im passenden Unterabschnitt: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`.
- Ein Eintrag ist ein kurzer Satz aus Sicht der Nutzer/Betreiber, optional mit Issue-Link (`#N`).
- **Betreiber-relevante Punkte explizit kennzeichnen**, mit dem Präfix `**Betreiber:**`:
  - neue Datenbankmigrationen, besonders lang laufende
  - neue, umbenannte oder entfernte `.env`-Variablen bzw. geänderte Standardwerte
  - Breaking Changes (API, Volumes, Compose-Dienste, manuelle Schritte beim Upgrade) – zusätzlich mit `**BREAKING**`
- Kein Eintrag nötig für reine Refactorings, Tests, CI oder Doku-Tippfehler.
- Sicherheitsfixes unter `Security` ohne Details, die eine noch nicht behobene Lücke offenlegen (siehe [SECURITY.md](../../SECURITY.md)).

## Beim Release

1. Versionsnummer nach [SemVer](https://semver.org/lang/de/) wählen: Breaking Change → Major (vor 1.0: Minor), neue Funktion → Minor, nur Fixes → Patch.
2. `## [Unreleased]` in `## [x.y.z] – JJJJ-MM-TT` umbenennen und einen neuen, leeren `## [Unreleased]`-Abschnitt darüber anlegen.
3. Version taggen; die Release-Images (Roadmap 7.2) verweisen auf den Abschnitt.

Eine automatische CI-Prüfung gibt es bewusst nicht; die Pflege ist Teil der [Definition of Done](definition-of-done.md) und der PR-Checkliste.
