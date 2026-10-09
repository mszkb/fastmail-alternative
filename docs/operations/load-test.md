# Lasttest (viele Konten, große Postfächer)

> Roadmap 6.6, Issue #60. Stand: 2026-10-08 (PHP-Backend). Darunter die früheren Messungen mit dem Node-Backend.

## PHP-Backend

### Werkzeug

`composer loadtest` (`apps/server-php/tests/Load/loadtest.php`, nur Entwicklung, braucht die Dev-Abhängigkeiten):

```sh
cd apps/server-php
make -C ../.. test-services   # MariaDB und GreenMail (jede Anmeldung erlaubt)
docker exec fma-test-mariadb mariadb -uroot -proot -e 'CREATE DATABASE IF NOT EXISTS fma_load'
LOADTEST_DATABASE_URL=mysql://root:root@127.0.0.1:33306/fma_load GREENMAIL_HOST=127.0.0.1 \
  composer loadtest -- --accounts=3 --messages=5000 --synthetic=50000 --runs=30
```

Die Datenbank aus `LOADTEST_DATABASE_URL` wird **gelöscht** und neu migriert. Das Skript befüllt ein GreenMail-Postfach per IMAP `APPEND`, legt N Konten darauf an (je eigener DEK, wie echte Konten), lässt den echten Job-Runner (`Bootstrap::runner`) im selben Prozess synchronisieren und misst Sync-Dauer, Jobs, Speicher des PHP-Prozesses, DB-Größe und die Latenz der wichtigsten Endpunkte (Slim-Requests im Prozess, ohne Netzwerk und ohne php-fpm). `--synthetic=N` legt zusätzlich N Nachrichten (gültig verschlüsselt, ohne Rohmail) in einen eigenen Ordner und misst dort die Nachrichtenliste. Die Ausgabe ist Markdown.

### Zielwerte

Gemessen auf einer Entwicklungsmaschine (x86_64); der Pi ist grob 5–10× langsamer, die Ziele lassen dafür Luft.

| Messgröße                                                   | Ziel (x86)              | Gemessen (MariaDB 11.8)        | Erreicht |
| ----------------------------------------------------------- | ----------------------- | ------------------------------ | -------- |
| Nachrichtenliste, Unified Inbox, Ordnerbaum, Speicher (p95) | ≤ 50 ms                 | 6,3–15,2 ms                    | ✅       |
| Nachrichtenliste bei 50 000 Mails in einem Ordner (p95)     | ≤ 50 ms                 | 5,7 ms (MySQL 8.0: 8,2 ms)     | ✅       |
| Inkrementeller Lauf ohne Änderungen, 3 × 5000 Mails         | ≤ 10 s                  | 3,9 s                          | ✅       |
| Spitzen-Speicher des PHP-Prozesses (Runner + API)           | ≤ 64 MB (Limit 256 MB)  | 20 MB                          | ✅       |
| Initial-Sync                                                | ohne Fehler und Retries | 0 fehlgeschlagen, 0 wiederholt | ✅       |

Keine Zielzahl für die Dauer des Initial-Syncs und der Suche: Beide hängen hier fast nur an GreenMail (siehe unten).

### Ergebnisse (2026-10-08, Entwicklungsmaschine, kein Pi)

Lauf: 3 Konten, 5000 Mails im Postfach, PHP 8.3, linux/x86_64, MariaDB 11.8, GreenMail 2.1; ein Prozess (Runner + API), Jobs nacheinander wie bei Cron und Worker.

| Messgröße                                      | Wert                                                                                                      |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Befüllen per IMAP APPEND                       | 1,1 s (≈ 4600 Mails/s)                                                                                    |
| Initial-Sync (3 Konten, je 200 neueste Mails)  | 600 s, 600 Nachrichten, 8 Jobs, 0 fehlgeschlagen/wiederholt                                               |
| Inkrementeller Lauf ohne Änderungen (3 Konten) | 3,9 s (inkl. UID/FLAGS-Abgleich von je 5000 Mails)                                                        |
| Speicher des PHP-Prozesses vor Sync / Spitze   | 4 MB / 18 MB (mit API-Messung und großem Ordner 20 MB)                                                    |
| DB-Größe (Daten + Indizes)                     | 110 MB, davon `message` 77 MB, `message_location` 30 MB – fast alles die 50 000 synthetischen Nachrichten |

API-Latenz (30 Aufrufe je Endpunkt, ms):

| Endpunkt                                     | p50   | p95   | max   |
| -------------------------------------------- | ----- | ----- | ----- |
| Nachrichtenliste (50)                        | 5,2   | 7,6   | 8,0   |
| Nachrichtenliste, Seite 2                    | 5,1   | 6,5   | 7,6   |
| Unified Inbox (50)                           | 10,6  | 15,2  | 15,3  |
| Suche (IMAP `SEARCH`, 9 Aufrufe, ohne Cache) | 236,1 | 268,4 | 268,4 |
| Speicher gesamt                              | 4,2   | 9,3   | 9,4   |
| Ordnerbaum                                   | 3,2   | 6,3   | 15,3  |
| Nachrichtenliste, 50 000 Mails im Ordner     | 4,1   | 5,7   | 7,5   |

Die Suche fragt bei jedem Aufruf den Anbieter (eine IMAP-Verbindung je Suche, kein Ergebnis-Cache im PHP-Backend); gemessen werden höchstens 9 Aufrufe, weil die Suche auf 10 pro Konto und Minute begrenzt ist.

### Gegen Dovecot (echter IMAP-Server)

Dovecot 2.3 im Container (`dovecot/dovecot:2.3.21`, Klartext-Login nur für den Test freigeschaltet, `LOADTEST_IMAP_PASSWORD=pass`), sonst wie oben:

| Lauf                                                       | Wert                                                                                                                       |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 3 Konten × 5000 Mails: Initial-Sync (je 200 neueste)       | **6,2 s** (gegen GreenMail 600 s), 0 fehlgeschlagen                                                                        |
| 3 Konten × 5000 Mails: inkrementeller Lauf ohne Änderungen | 0,23 s                                                                                                                     |
| 1 Konto × 50 000 Mails: inkrementeller Lauf                | 0,17 s                                                                                                                     |
| 1 Konto × 50 000 Mails: volle Historie (`--full-history`)  | 49 800 weitere Mails in 940 s (≈ 53 Mails/s, 249 Runden „Ältere laden“), alle 50 000 da; Spitzen-Speicher 72 MB, DB 289 MB |
| Suche bei 50 000 Mails im Ordner (p50)                     | 1,4 s – Dovecot durchsucht ohne Volltextindex (FTS) jede Mail beim Aufruf                                                  |

Damit ist der langsame Initial-Sync gegen GreenMail bestätigt als Artefakt des Testservers.

### Gefundene Engpässe

1. **Behoben: Die Nachrichtenliste sortierte den ganzen Ordner.** Sie ordnete nach dem Datum der verbundenen Nachricht, also musste MariaDB jede Zeile des Ordners samt verschlüsselter Spalten und Flag-Unterabfragen in eine temporäre Tabelle kopieren und sortieren (`Using temporary; Using filesort`): **475 ms (p50) je Seite bei 50 000 Mails** auf x86, auf dem Pi also mehrere Sekunden. Migration `0005_message_sort_key` kopiert das (unveränderliche) Sortierdatum nach `message_location.sort_at` und indiziert `(folder_id, sort_at, id)`; eine Seite wird jetzt in Indexreihenfolge gelesen: **4,1 ms**. Details: [Datenmodell](../architecture/data-model.md).
2. **Behoben: Datenverlust lokaler Kopien in großen Postfächern.** Der Lauf gegen Dovecot mit 50 000 Mails verlor beim ersten inkrementellen Abgleich alle synchronisierten Mails: Die IMAP-Antwort `* SEARCH` mit allen UIDs (≈ 290 KB in einer Zeile) wurde nach 64 KB abgeschnitten, und das Auslesen per Regex scheiterte bei so langen Zeilen ganz. Mit CONDSTORE galten damit fast alle lokalen Mails als beim Server gelöscht. Betroffen waren Ordner ab etwa 12 000 Mails auf Servern mit CONDSTORE; auf dem Server selbst ging nichts verloren. Behoben in `MailSocket::readLine()` und `ImapMailbox::searchResult()`; zusätzlich bricht der Abgleich ab, wenn die UID-Liste kürzer ist als die Zahl der Mails, die der Server meldet (`EXISTS`).
3. **Behoben: Threading wurde mit der Postfachgröße langsamer.** Die Suche nach verwandten Mails verknüpfte ihre Bedingungen mit `OR` und las dadurch für jede neue Mail alle schon einsortierten Mails des Kontos (≈ 30 000 Zeilen laut `EXPLAIN`); die volle Historie fiel so von ≈ 50 auf ≈ 12 Mails/s. Jetzt eine `UNION` aus indizierten Teilabfragen (`Threading::assign`); der Durchsatz bleibt bei ≈ 50 Mails/s.
4. **Sync-Durchsatz gegen GreenMail.** Wie schon beim Node-Backend (unten, Punkt 1) sucht GreenMail pro Befehl linear im Ordner; mit 5000 Mails im Ordner schafft der Sync ≈ 1 Mail/s. Das PHP-Backend arbeitet die Jobs zudem nacheinander ab (ein Prozess, ADR-0013), das Node-Backend parallel. Gegen indizierte Server bestimmt die Netzwerk-Latenz je Mail den Durchsatz. Gegen Dovecot sind es ≈ 100 Mails/s im Initial-Sync (oben); ob Bodies gebündelt geholt werden sollen, nach einer Messung auf dem Pi entscheiden.
5. **Unified Inbox** liest je INBOX aus dem Index, sortiert über die Konten aber noch zusammen (10,6 ms p50 bei 3 × 200 Mails). Bei vielen Konten mit großen Posteingängen erneut messen.
6. **Keine Fehler, Retries oder Lecks:** 8 Jobs, 0 fehlgeschlagen; der Speicher wächst nur mit den UID-Listen eines Ordners (20 MB Spitze bei 50 000 synthetischen Mails, 72 MB beim Synchronisieren der vollen Historie von 50 000 Mails).
7. **Offen:** Messung auf dem Pi (arm64, mit den Container-Limits aus `docker-compose.yml`: php 256 MB, worker 384 MB).

## Node-Backend (historisch, 2026-10-04)

> Das Lasttest-Werkzeug (`pnpm loadtest`, `apps/worker/loadtest/run.ts`) lag im Node-Worker und ist mit dem Umstieg auf das PHP-Backend ([ADR-0013](../adr/0013-php-backend.md), #110) entfallen. Die Werte gelten nur für den damaligen Stack (Fastify-API, Node-Worker mit paralleler Job-Ausführung, PostgreSQL).

### Methode (damals)

Das Skript befüllte ein GreenMail-Postfach per IMAP `APPEND` mit synthetischen Mails, legte in einer frischen PostgreSQL-Datenbank N Konten an (alle auf denselben GreenMail-Benutzer, für die App trotzdem getrennte Konten mit eigenem DEK), ließ den echten Worker-Code im selben Prozess synchronisieren und maß Sync-Dauer, Jobs/s, Spitzen-RSS, DB-Größe und die Latenz der wichtigsten API-Endpunkte (p50/p95/max per Fastify `inject`). Die Messwerte stammen von einer **Entwicklungsmaschine (x86_64, kein Raspberry Pi)**; ein Lauf auf dem Pi fand nicht mehr statt.

### Ergebnisse (Entwicklungsmaschine, kein Pi)

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

### Bewertung gegen die Speicherlimits

- **Worker (384 MB):** Der Sync wächst um ≈ 46 MB über die Grundlast (3 Konten parallel, Fenster von 200 Mails). Der Speicher hängt vom Fenster (`MESSAGE_SYNC_LIMIT` = 200) und von der Mailgröße ab, nicht von der Postfachgröße; einzig der UID/FLAGS-Abgleich hält pro Ordner eine Liste aller UIDs und Flags (grob 100–200 Byte je Mail, bei 50 000 Mails also ≈ 5–10 MB je laufendem Job). Mit dem gebündelten Worker (≈ 49 MB im Leerlauf, siehe [Systemanforderungen](system-requirements.md)) bleibt deutlich Luft unter 384 MB; der Richtwert für große Einzelmails (bis ≈ 100 MB je Job) gilt unverändert.
- **API (192 MB):** Die gemessenen Endpunkte laden nur eine Seite (50 Einträge) bzw. Aggregate per SQL; die Ergebnismenge wächst nicht mit dem Postfach. Kein Anzeichen, dass 192 MB knapp werden.
- **Einschränkung:** Gemessen wurde ein Prozess mit API, Worker und `tsx`-Loader auf x86_64. Ein Nachweis gegen die echten Container-Limits auf dem Pi wurde mit dem Node-Backend nicht mehr gemacht.

### Gefundene Engpässe und offene Punkte (damals)

1. **Sync-Durchsatz: ein IMAP-Roundtrip pro Mail.** `message_sync` lädt jede Mail einzeln (`UID FETCH` des Rohtexts nach dem Metadaten-Fetch). Gegen GreenMail mit 5000 Mails im Ordner waren das nur ≈ 2 Mails/s, mit 300 Mails ≈ 35 Mails/s: GreenMail sucht pro Befehl linear im Ordner (Java-Prozess bei 100 % CPU) – das ist überwiegend ein Artefakt des Testservers, nicht der App. Bei echten Anbietern (indizierte Server, aber Netzwerk-Latenz) bestimmt die Roundtrip-Zeit den Durchsatz. **Offen:** Rohtexte gebündelt pro Fenster abrufen (damals `message-sync.ts`; für das PHP-Backend nicht neu bewertet).
2. **Nachrichtenliste und Unified Inbox sortieren den ganzen Ordner.** Die Sortierung nach `coalesce(sent_at, received_at, created_at)` liegt in `message`, der Filter in `message_location`; PostgreSQL muss alle Zeilen des Ordners joinen und per Top-N sortieren (O(n) je Seite, ≈ 43 ms bei 50 000 Mails auf x86, auf dem Pi geschätzt mehrere 100 ms). **Offen:** Sortierschlüssel nach `message_location` denormalisieren und `(folder_id, sort_at DESC, id DESC)` indizieren – Migration mit Backfill auf befüllter DB, daher nicht als kleiner Fix umgesetzt.
3. **Keine Fehler/Retries, keine Lecks:** 12 Jobs, 0 fehlgeschlagen; der inkrementelle Lauf ohne Änderungen dauert für 3 × 5000 Mails ≈ 2 s; kein Hinweis auf mit der Postfachgröße linear wachsenden Speicher außer dem UID-Abgleich (s. o.).
4. **Volle Historie großer Postfächer** (20 × 50 000) wurde wegen der GreenMail-Langsamkeit nicht gemessen – auf dem Pi gegen einen Dovecot-Testserver nachholen.
