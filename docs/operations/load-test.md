# Lasttest (viele Konten, große Postfächer)

> Roadmap 6.6, Issue #60. Stand: 2026-10-04.
>
> **Historisch – gemessen mit dem früheren Node-Backend.** Das Lasttest-Werkzeug (`pnpm loadtest`, `apps/worker/loadtest/run.ts`) lag im Node-Worker und ist mit dem Umstieg auf das PHP-Backend ([ADR-0013](../adr/0013-php-backend.md), #110) entfallen. Für das PHP-Backend gibt es noch kein Lasttest-Werkzeug und keine Messung; die Werte unten gelten nur für den damaligen Stack (Fastify-API, Node-Worker mit paralleler Job-Ausführung, PostgreSQL). Übertragbar sind vor allem die Beobachtungen zum IMAP-Verhalten (ein Roundtrip je Mail, GreenMail als Engpass).

## Methode (damals)

Das Skript befüllte ein GreenMail-Postfach per IMAP `APPEND` mit synthetischen Mails, legte in einer frischen PostgreSQL-Datenbank N Konten an (alle auf denselben GreenMail-Benutzer, für die App trotzdem getrennte Konten mit eigenem DEK), ließ den echten Worker-Code im selben Prozess synchronisieren und maß Sync-Dauer, Jobs/s, Spitzen-RSS, DB-Größe und die Latenz der wichtigsten API-Endpunkte (p50/p95/max per Fastify `inject`). Die Messwerte stammen von einer **Entwicklungsmaschine (x86_64, kein Raspberry Pi)**; ein Lauf auf dem Pi fand nicht mehr statt.

## Ergebnisse (Entwicklungsmaschine, kein Pi)

Lauf: 3 Konten, 5000 Mails, nur Initial-Sync (Node 24.21, linux/x64, PostgreSQL 16, GreenMail; Worker-Standardwerte).

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

Ein Vorlauf mit 2 × 300 Mails und kompletter Historie synchronisierte ≈ 35 Mails/s, Spitzen-RSS 266 MB bei 166 MB Grundlast.

Zusätzlich wurde die Nachrichtenliste mit **50 000 Nachrichten in einem Ordner** gemessen (synthetische Zeilen per SQL in der Lasttest-DB, `EXPLAIN ANALYZE` der Listen-Query): **≈ 43 ms** je Seite auf dieser Maschine.

## Bewertung gegen die Speicherlimits

- **Worker (384 MB):** Der Sync wächst um ≈ 46 MB über die Grundlast (3 Konten parallel, Fenster von 200 Mails). Der Speicher hängt vom Fenster (`MESSAGE_SYNC_LIMIT` = 200) und von der Mailgröße ab, nicht von der Postfachgröße; einzig der UID/FLAGS-Abgleich hält pro Ordner eine Liste aller UIDs und Flags (grob 100–200 Byte je Mail, bei 50 000 Mails also ≈ 5–10 MB je laufendem Job). Mit dem gebündelten Worker (≈ 49 MB im Leerlauf, siehe [Systemanforderungen](system-requirements.md)) bleibt deutlich Luft unter 384 MB; der Richtwert für große Einzelmails (bis ≈ 100 MB je Job) gilt unverändert.
- **API (192 MB):** Die gemessenen Endpunkte laden nur eine Seite (50 Einträge) bzw. Aggregate per SQL; die Ergebnismenge wächst nicht mit dem Postfach. Kein Anzeichen, dass 192 MB knapp werden.
- **Einschränkung:** Gemessen wurde ein Prozess mit API, Worker und `tsx`-Loader auf x86_64. Ein Nachweis gegen die echten Container-Limits auf dem Pi wurde mit dem Node-Backend nicht mehr gemacht.

## Gefundene Engpässe und offene Punkte

1. **Sync-Durchsatz: ein IMAP-Roundtrip pro Mail.** `message_sync` lädt jede Mail einzeln (`UID FETCH` des Rohtexts nach dem Metadaten-Fetch). Gegen GreenMail mit 5000 Mails im Ordner waren das nur ≈ 2 Mails/s, mit 300 Mails ≈ 35 Mails/s: GreenMail sucht pro Befehl linear im Ordner (Java-Prozess bei 100 % CPU) – das ist überwiegend ein Artefakt des Testservers, nicht der App. Bei echten Anbietern (indizierte Server, aber Netzwerk-Latenz) bestimmt die Roundtrip-Zeit den Durchsatz. **Offen:** Rohtexte gebündelt pro Fenster abrufen (damals `message-sync.ts`; für das PHP-Backend nicht neu bewertet).
2. **Nachrichtenliste und Unified Inbox sortieren den ganzen Ordner.** Die Sortierung nach `coalesce(sent_at, received_at, created_at)` liegt in `message`, der Filter in `message_location`; PostgreSQL muss alle Zeilen des Ordners joinen und per Top-N sortieren (O(n) je Seite, ≈ 43 ms bei 50 000 Mails auf x86, auf dem Pi geschätzt mehrere 100 ms). **Offen:** Sortierschlüssel nach `message_location` denormalisieren und `(folder_id, sort_at DESC, id DESC)` indizieren – Migration mit Backfill auf befüllter DB, daher nicht als kleiner Fix umgesetzt.
3. **Keine Fehler/Retries, keine Lecks:** 12 Jobs, 0 fehlgeschlagen; der inkrementelle Lauf ohne Änderungen dauert für 3 × 5000 Mails ≈ 2 s; kein Hinweis auf mit der Postfachgröße linear wachsenden Speicher außer dem UID-Abgleich (s. o.).
4. **Volle Historie großer Postfächer** (20 × 50 000) wurde wegen der GreenMail-Langsamkeit nicht gemessen – auf dem Pi gegen einen Dovecot-Testserver nachholen.
