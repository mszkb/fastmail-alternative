# Lasttest (viele Konten, große Postfächer)

> Roadmap 6.6, Issue #60. Stand: 2026-10-04. Die Messwerte unten stammen von einer **Entwicklungsmaschine (x86_64, kein Raspberry Pi)** mit GreenMail als IMAP-Server. Der Lauf auf dem Pi steht noch aus (Anleitung unten).

## Methode

Das Skript [`apps/worker/loadtest/run.ts`](../../apps/worker/loadtest/run.ts) ist **nicht** Teil von `pnpm test` und wird separat gestartet (`pnpm loadtest`). Es benutzt nur vorhandene Bausteine (imapflow, pg, Fastify `inject`) – kein zusätzliches Lasttest-Tool.

1. **Postfach befüllen:** `LOADTEST_MESSAGES` synthetische Mails (Text, ~1 KB, gelesen) per IMAP `APPEND` in `LOADTEST_FOLDER` (Standard `INBOX`) des IMAP-Benutzers. GreenMail kennt nur die beim Start per `-Dgreenmail.users` angelegten Benutzer; deshalb zeigen alle `LOADTEST_ACCOUNTS` Konten auf **denselben** IMAP-Benutzer. Für die App sind das trotzdem getrennte Konten mit eigenem DEK, eigenen Ordnern, Nachrichten und Dateien – die Last auf Worker, Datenbank und API entspricht N Konten mit je einem großen Postfach.
2. **Frische Datenbank:** `LOADTEST_DB` (Standard `mail_loadtest`) wird über die `DATABASE_URL`-Verbindung **gelöscht und neu angelegt**, migriert, ein Benutzer per `/api/auth/setup` eingerichtet (Unified Inbox eingeschaltet) und die Konten verschlüsselt angelegt.
3. **Sync mit echtem Worker-Code:** `folder_sync`-Jobs je Konto, abgearbeitet vom echten `JobRunner` im selben Prozess (Standard-`WORKER_CONCURRENCY` 4, Verbindungslimit pro IMAP-Host) bis keine Jobs mehr laufen. Gemessen: Dauer des Initial-Syncs (Ordner + neuestes Fenster von 200 Mails je Ordner), optional (`LOADTEST_FULL=1`) die komplette Historie über wiederholte „Ältere laden"-Jobs, danach ein inkrementeller Lauf ohne Änderungen.
4. **Messwerte:** Jobs/s, Mails/s, Spitzen-RSS des Prozesses (`process.memoryUsage().rss` alle 50 ms), DB-Größe (`pg_database_size`, `message`, `message_location`) und die Latenz der wichtigsten API-Endpunkte per Fastify `inject` (p50/p95/max über `LOADTEST_REQUESTS` Aufrufe): Nachrichtenliste (erste und zweite Seite), Unified Inbox, Suche (IMAP `SEARCH`), Speicherverbrauch, Ordnerbaum.
5. **Aufräumen:** Die angehängten Mails werden am Ende wieder gelöscht (`LOADTEST_KEEP_MAIL=1` behält sie), das temporäre `MAIL_DATA_DIR` ebenso. Die Lasttest-Datenbank bleibt für Analysen (`EXPLAIN`) stehen.

Ausgabe ist ein Markdown-Bericht auf stdout (ohne Mailinhalte; die Testmails sind ohnehin synthetisch).

### Parameter

| Variable                            | Standard        | Bedeutung                                                            |
| ----------------------------------- | --------------- | -------------------------------------------------------------------- |
| `LOADTEST_ACCOUNTS`                 | `3`             | Anzahl Konten                                                        |
| `LOADTEST_MESSAGES`                 | `5000`          | Mails im Postfach                                                    |
| `LOADTEST_FULL`                     | `1`             | `1`: komplette Historie nachladen, `0`: nur Initial-Sync             |
| `LOADTEST_REQUESTS`                 | `30`            | Aufrufe je API-Endpunkt                                              |
| `LOADTEST_FOLDER`                   | `INBOX`         | Zielordner (anderer Ordner wird angelegt und am Ende gelöscht)       |
| `LOADTEST_DB`                       | `mail_loadtest` | Name der Lasttest-Datenbank – **wird gelöscht und neu angelegt**     |
| `LOADTEST_KEEP_MAIL`                | `0`             | `1`: angehängte Mails nicht wieder löschen                           |
| `DATABASE_URL`                      | –               | Verbindung mit `CREATEDB`-Recht (Datenbankname wird ersetzt)         |
| `GREENMAIL_HOST`, `_IMAP_PORT`, ... | GreenMail       | IMAP-Server und Zugangsdaten (`GREENMAIL_USER`/`GREENMAIL_PASSWORD`) |
| `WORKER_CONCURRENCY`, ...           | wie Worker      | Worker-Einstellungen wirken wie im Betrieb                           |

## Ergebnisse (Entwicklungsmaschine, kein Pi)

Lauf: `LOADTEST_ACCOUNTS=3 LOADTEST_MESSAGES=5000 LOADTEST_FULL=0 pnpm loadtest` (Node 24.21, linux/x64, PostgreSQL 16, GreenMail; Worker-Standardwerte).

| Messgröße                                      | Wert                                                          |
| ---------------------------------------------- | ------------------------------------------------------------- |
| Befüllen per IMAP APPEND                       | 1,8 s (≈ 2700 Mails/s)                                        |
| Initial-Sync (3 Konten, je 200 neueste Mails)  | 320,6 s, 600 Nachrichten, 6 Jobs, 0 fehlgeschlagen/wiederholt |
| Inkrementeller Lauf ohne Änderungen (3 Konten) | 2,25 s (inkl. UID/FLAGS-Abgleich von je 5000 Mails)           |
| RSS vor Sync (API + Worker + tsx in einem)     | 178,9 MB                                                      |
| Spitzen-RSS Initial-Sync und API-Messung       | 224,4 MB (Zuwachs ≈ 46 MB)                                    |
| DB-Größe                                       | 11,4 MB (`message` 1,4 MB, `message_location` 0,3 MB)         |

API-Latenz (30 Aufrufe je Endpunkt, Fastify `inject`, ms):

| Endpunkt                  | p50 | p95 | max   |
| ------------------------- | --- | --- | ----- |
| Nachrichtenliste (50)     | 5,6 | 8,6 | 10,8  |
| Nachrichtenliste, Seite 2 | 5,5 | 8,3 | 11,6  |
| Unified Inbox (50)        | 6,5 | 8,2 | 8,2   |
| Suche (IMAP `SEARCH`)     | 2,8 | 4,6 | 323,7 |
| Speicher gesamt           | 2,0 | 2,4 | 3,6   |
| Ordnerbaum                | 1,5 | 2,0 | 2,3   |

Die Suche ist nach dem ersten Aufruf (IMAP-Verbindung, `SEARCH` beim Anbieter, 324 ms) im Kurzzeit-Cache; p50/p95 messen daher den Cache.

Ein Vorlauf mit 2 × 300 Mails und kompletter Historie (`LOADTEST_FULL=1`) synchronisierte ≈ 35 Mails/s, Spitzen-RSS 266 MB bei 166 MB Grundlast.

Zusätzlich wurde die Nachrichtenliste mit **50 000 Nachrichten in einem Ordner** gemessen (synthetische Zeilen per SQL in der Lasttest-DB, `EXPLAIN ANALYZE` der Listen-Query): **≈ 43 ms** je Seite auf dieser Maschine.

## Bewertung gegen die Speicherlimits

- **Worker (384 MB):** Der Sync wächst um ≈ 46 MB über die Grundlast (3 Konten parallel, Fenster von 200 Mails). Der Speicher hängt vom Fenster (`MESSAGE_SYNC_LIMIT` = 200) und von der Mailgröße ab, nicht von der Postfachgröße; einzig der UID/FLAGS-Abgleich hält pro Ordner eine Liste aller UIDs und Flags (grob 100–200 Byte je Mail, bei 50 000 Mails also ≈ 5–10 MB je laufendem Job). Mit dem gebündelten Worker (≈ 49 MB im Leerlauf, siehe [Systemanforderungen](system-requirements.md)) bleibt deutlich Luft unter 384 MB; der Richtwert für große Einzelmails (bis ≈ 100 MB je Job) gilt unverändert.
- **API (192 MB):** Die gemessenen Endpunkte laden nur eine Seite (50 Einträge) bzw. Aggregate per SQL; die Ergebnismenge wächst nicht mit dem Postfach. Kein Anzeichen, dass 192 MB knapp werden.
- **Einschränkung:** Gemessen wurde ein Prozess mit API, Worker und `tsx`-Loader auf x86_64. Der Nachweis gegen die echten Container-Limits auf dem Pi steht aus (Anleitung unten).

## Gefundene Engpässe und offene Punkte

1. **Sync-Durchsatz: ein IMAP-Roundtrip pro Mail.** `message_sync` lädt jede Mail einzeln (`UID FETCH` des Rohtexts nach dem Metadaten-Fetch). Gegen GreenMail mit 5000 Mails im Ordner waren das nur ≈ 2 Mails/s, mit 300 Mails ≈ 35 Mails/s: GreenMail sucht pro Befehl linear im Ordner (Java-Prozess bei 100 % CPU) – das ist überwiegend ein Artefakt des Testservers, nicht der App. Bei echten Anbietern (indizierte Server, aber Netzwerk-Latenz) bestimmt die Roundtrip-Zeit den Durchsatz. **Offen:** Rohtexte gebündelt pro Fenster abrufen (größerer Umbau in `message-sync.ts`, nicht im Rahmen dieses Issues).
2. **Nachrichtenliste und Unified Inbox sortieren den ganzen Ordner.** Die Sortierung nach `coalesce(sent_at, received_at, created_at)` liegt in `message`, der Filter in `message_location`; PostgreSQL muss alle Zeilen des Ordners joinen und per Top-N sortieren (O(n) je Seite, ≈ 43 ms bei 50 000 Mails auf x86, auf dem Pi geschätzt mehrere 100 ms). **Offen:** Sortierschlüssel nach `message_location` denormalisieren und `(folder_id, sort_at DESC, id DESC)` indizieren – Migration mit Backfill auf befüllter DB, daher nicht als kleiner Fix umgesetzt.
3. **Keine Fehler/Retries, keine Lecks:** 12 Jobs, 0 fehlgeschlagen; der inkrementelle Lauf ohne Änderungen dauert für 3 × 5000 Mails ≈ 2 s; kein Hinweis auf mit der Postfachgröße linear wachsenden Speicher außer dem UID-Abgleich (s. o.).
4. **Volle Historie großer Postfächer** (20 × 50 000) wurde wegen der GreenMail-Langsamkeit nicht gemessen – auf dem Pi gegen einen Dovecot-Testserver nachholen.

## Auf dem Raspberry Pi ausführen

Der Lasttest braucht eine Arbeitskopie mit Node ≥ 24.11 und pnpm (die Runtime-Images enthalten keine `node_modules`), eine **eigene** PostgreSQL-Datenbank und einen Test-IMAP-Server. **Niemals gegen die Produktionsdatenbank oder ein echtes Postfach laufen lassen** – `LOADTEST_DB` wird gelöscht, und Mails werden angehängt und gelöscht.

```sh
# Test-Dienste (Ports nur lokal; nach dem Test wieder entfernen)
docker run -d --name lt-pg -e POSTGRES_USER=mail -e POSTGRES_PASSWORD=lt \
  -p 127.0.0.1:55432:5432 postgres:16-alpine
docker run -d --name lt-greenmail -p 127.0.0.1:3143:3143 \
  -e GREENMAIL_OPTS='-Dgreenmail.setup.test.imap -Dgreenmail.users=testuser:secret123@example.com -Dgreenmail.hostname=0.0.0.0' \
  greenmail/standalone

cd ~/fastmail-alternative && pnpm install
export DATABASE_URL=postgres://mail:lt@127.0.0.1:55432/postgres \
  GREENMAIL_HOST=127.0.0.1 GREENMAIL_IMAP_PORT=3143 \
  GREENMAIL_USER=testuser@example.com GREENMAIL_PASSWORD=secret123 \
  MAIL_INSECURE_TRANSPORT=1 MAIL_ALLOW_PRIVATE_HOSTS=1

# Mit dem Speicherlimit des Worker-Containers (OOM = Test nicht bestanden):
systemd-run --user --scope -p MemoryMax=384M -p MemorySwapMax=0 \
  pnpm loadtest > loadtest-pi.md

docker rm -f lt-pg lt-greenmail
```

Hinweise:

- Werte schrittweise erhöhen (z. B. `LOADTEST_ACCOUNTS=5 LOADTEST_MESSAGES=10000 LOADTEST_FULL=0`, dann `LOADTEST_FULL=1`). GreenMail wird bei großen Postfächern selbst zum Engpass (siehe oben); für 20 × 50 000 einen Dovecot-Testserver verwenden und `GREENMAIL_*` darauf zeigen lassen.
- Der Prozess enthält API **und** Worker sowie den `tsx`-Loader; sein Grundverbrauch liegt deutlich über dem der gebündelten Container. Aussagekräftig ist vor allem der **Zuwachs** des RSS während des Syncs. Ergänzend während des Laufs `docker stats` des echten Stacks beobachten, wenn dieser parallel ein großes Testkonto synchronisiert.
- Ergebnisse unter „Ergebnisse" als eigener Abschnitt „Raspberry Pi" ergänzen; dann kann 6.6 auf ✅.
