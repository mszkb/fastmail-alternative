# Offene Produktfragen

Fragen, die eine Produktentscheidung brauchen. Bis zur Entscheidung gilt jeweils der **einfachste Default** (CLAUDE.md, Prinzip 9); er ist unten als „Aktuell“ beschrieben. Entschiedene Punkte wandern in die Roadmap bzw. eine ADR und werden hier gestrichen.

Herkunft: UI-Abnahme im [Testbericht 2026-10-05](../operations/test-report-2026-10-05.md#5-ui-abnahme-chromium-pixel-7-viewport-mit-touch).

## 1. Manueller Sync direkt nach dem App-Start

**Aktuell:** Beim Start fordert die App für alle Konten einen Sync an (`POST /api/sync`, [Push-Strategie](../architecture/push.md)). Der Server lässt pro Konto höchstens einen neuen `folder_sync` je 30 s zu. Solange der Start-Sync läuft, sind „Aktualisieren“ und Pull-to-Refresh gesperrt (Frage 2). Ist er fertig, die 30 s seit dem Start aber noch nicht um, antwortet der Server auf „Aktualisieren“ oder Ziehen mit 429 und die App zeigt „Gerade aktualisiert.“.

**Frage:** So lassen oder ändern?

| Option                                                                                           | Aufwand | Folgen                                                                                                 |
| ------------------------------------------------------------------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------ |
| A – so lassen (Default)                                                                          | –       | Schutz vor Job-Flut beim Anbieter; der Start-Sync hat ohnehin gerade abgeholt, der Hinweis ist ehrlich |
| B – manueller Sync darf das Limit einmal überspringen, wenn der letzte Sync vom App-Start stammt | S       | Nutzer bekommt immer einen echten Abruf; zwei IMAP-Verbindungen kurz hintereinander pro Konto          |
| C – kürzeres Limit nur für manuelle Anfragen (z. B. 10 s)                                        | S       | Weniger „Gerade aktualisiert.“; Job-Flut-Schutz bleibt grob erhalten                                   |

## 2. Pull-to-Refresh während des Start-Syncs

**Aktuell:** Solange der Start-Sync des Kontos läuft (`syncing`), ist „Aktualisieren“ deaktiviert und ein Ziehen der Liste wird ignoriert – ohne Hinweis. Die Liste aktualisiert sich von selbst, sobald der Sync fertig ist.

**Frage:** So lassen oder sichtbar machen?

| Option                                                                | Aufwand | Folgen                                                             |
| --------------------------------------------------------------------- | ------- | ------------------------------------------------------------------ |
| A – so lassen (Default)                                               | –       | Kein doppelter Job; Nutzer sieht aber keine Reaktion auf die Geste |
| B – Geste zeigt den laufenden Sync an (Spinner/„Wird aktualisiert …“) | S       | Rückmeldung ohne zusätzliche Last                                  |

## 3. Neue Mails bei geöffneter App

**Aktuell:** Der Server erfährt neue Mails im Posteingang per IMAP IDLE binnen Sekunden. Die geöffnete App fragt die Kontoliste aber nur alle 60 s ab (bzw. alle 3 s für 2 min nach einem Sync-Auslöser) und zeigt neue Mails daher spätestens nach ca. 60 s. Web Push ist nur ein Hinweis und nie Quelle der Wahrheit (Prinzip 3).

**Frage:** Reichen 60 s?

| Option                                                             | Aufwand | Folgen                                                                                    |
| ------------------------------------------------------------------ | ------- | ----------------------------------------------------------------------------------------- |
| A – so lassen (Default)                                            | –       | Einfach, wenig Last; bis zu 60 s Verzögerung bei offener App                              |
| B – kürzeres Intervall (z. B. 20 s), nur solange sichtbar          | S       | Schneller; dreimal so viele leichte `GET /api/accounts` pro offenem Gerät                 |
| C – Server-Sent Events / Long-Poll „Konto geändert“ (ohne Inhalte) | M–L     | Echtzeit; eigener Kanal durch caddy, Verbindungen pro Gerät, mehr Code in api und Clients |
| D – eingehender Push weckt die offene App zu einem Abgleich        | S       | Nur mit aktivem Push-Abo; Push bleibt Hinweis, die App synchronisiert selbst              |
