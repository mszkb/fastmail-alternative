# Autonomer Issue-Agent

Experiment: Issues mit dem Label `ready` werden ohne weiteres Zutun von Claude Code umgesetzt und bei grüner CI automatisch gemergt.

## Beteiligte

| Teil          | Wo                                                          | Aufgabe                                                                         |
| ------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Skill `/idea` | `~/.claude/skills/idea/` (lokal)                            | Idee → Issue nach Vorlage, Freigabe (`ready`), Status, Antworten auf Rückfragen |
| Runner        | `~/Documents/work/issue-agent/` (lokal, launchd alle 5 min) | Issue wählen, Worktree, `claude -p`, lokales Gate, Push, PR, Auto-Merge, Labels |
| GitHub        | Branch-Protection auf `main`                                | PR mergt erst, wenn der Unit-Job der CI grün ist                                |

Claude committet im Lauf nur. Push, PR, Merge und Labels setzt ausschließlich der Runner.

## Label-Lebenszyklus

```
(neu) ──/idea ready──▶ ready ──Runner──▶ agent:working ─┬─▶ agent:pr-open ──CI grün──▶ gemergt, Issue zu
                                                         ├─▶ agent:needs-info  (Rückfrage als Kommentar)
                                                         └─▶ agent:failed      (Fehler als Kommentar)
```

- `agent:needs-info`: Antwort als Kommentar schreiben, dann wieder `ready` setzen. Der nächste Lauf liest alle Kommentare des Owners mit.
- `agent:failed`: Ursache beheben (Issue präzisieren, `main` reparieren), wieder `ready` setzen.
- `risk:high`: PR wird erstellt, aber **nicht** automatisch gemergt. Gilt für Sync, Konflikte, Export/Import, Migrationen, Auth, Verschlüsselung, Push-Payload, Abhängigkeiten.

## Regeln für den Agenten

- Branch `agent/issue-<n>`, ein Issue pro PR, PR-Text = Abschlussbericht (`REPORT.md`) + `Closes #<n>`.
- Unklare, widersprüchliche oder prinzipienwidrige Aufträge: Rückfrage in `QUESTION.md` statt raten.
- Keine neuen Runtime-Abhängigkeiten und nichts aus `Proposed`-ADRs ohne Rückfrage.
- Lokales Gate vor dem Push: `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`. Dieselben Prüfungen sind die einzigen Required Checks der CI auf `main`. E2E-, Docker- und weitere langsame Tests laufen nur nächtlich um 22:00 auf der Gitea-Instanz der NAS (`msz/gitea-workflows`, gegen einen Pull-Mirror dieses Repos). Schlägt die Nacht fehl, öffnet der Workflow dort das Issue „🌙 Nightly failed“ und schließt es selbst, sobald es wieder grün ist.

## Sicherheitsgrenzen

- Nur Issues, deren Autor und `ready`-Label vom Owner (`mszkb`) stammen.
- Ein Issue zur Zeit; solange ein Agent-PR mit Auto-Merge offen ist, startet in diesem Repo kein neues.
- Im Lauf verboten: `git push`, `gh`, `curl`, `ssh`, `docker`, Web-Zugriffe.
- Zeitlimit pro Lauf (Standard 60 min), Tageslimit (Standard 8 Läufe).

## Stoppen

- Alles: `launchctl unload ~/Library/LaunchAgents/com.mszkb.issue-agent.plist`
- Ein Issue: Label `ready` entfernen, bevor der Lauf beginnt.
- Einen PR: Auto-Merge im PR deaktivieren (`gh pr merge --disable-auto <nr>`).
