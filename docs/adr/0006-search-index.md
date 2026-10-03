# ADR-0006: Suche

- **Status:** Accepted
- **Datum:** 2026-10-02
- **Roadmap:** 0.2, 5.1, 5.2

## Kontext

Suche nach Absender, Betreff, Text und Datum. Betreff, Adressen und Bodies liegen verschlüsselt auf dem Server (siehe [`../architecture/data-model.md`](../architecture/data-model.md#verschlüsselung)). Ein Klartext-Index würde diese Verschlüsselung unterlaufen.

## Optionen

1. **PostgreSQL Full-Text Search**: kein zusätzlicher Service, braucht aber Klartext in der DB.
2. **Meilisearch / Typesense**: sehr gute Relevanz, aber ein zusätzlicher Service, ebenfalls mit Klartext-Index.
3. **IMAP `SEARCH` beim Provider**: kein Index nötig, aber langsamer und je nach Provider uneinheitlich.

## Entscheidung

**IMAP `SEARCH` beim Provider im MVP**, pro Konto, hinter einer Such-Schnittstelle. Es gibt keinen eigenen Index.

Ein eigener Index wird erst erwogen, wenn IMAP `SEARCH` in der Praxis nicht reicht, und muss dann mit verschlüsselten Inhalten verträglich sein (z. B. ein verschlüsselter Index oder eine Suche über den Offline-Cache auf dem Gerät).

## Konsequenzen

- Im MVP gibt es keinen Indexierungs-Worker und keinen zusätzlichen Speicher.
- Suchqualität und -geschwindigkeit hängen vom Provider ab. Die Unterschiede werden in der Kompatibilitätsmatrix (0.5) erfasst.
- Die Suche funktioniert nur online und jeweils in einem Konto. Das passt zu den getrennten Konten.

## Umsetzung (Roadmap 5.1, 2026-10-03)

- **Die API sucht selbst beim Provider** (`GET /api/accounts/:id/search?q=&from=&subject=&since=&before=&folderId=`), mit genau einer kurzlebigen IMAP-Verbindung pro Suche. Das ist die in [`overview.md`](../architecture/overview.md) vorgesehene Ausnahme von „keine IMAP-Verbindungen aus Requests“. Ein Worker-Job mit Ergebnis-Polling wäre ebenfalls möglich, brächte aber zusätzliche Latenz (Job-Takt, Warteschlange hinter laufenden Syncs) und Zwischenzustand in der DB, ohne die Last beim Provider zu verringern.
- **Schutz wie bei jeder Provider-Verbindung:** SSRF-Prüfung des Hosts (`assertPublicHost`), Connect-/Greeting-/Socket-Timeouts und eine Gesamtfrist von 30 s, danach wird die Verbindung geschlossen. Konten mit Anmeldefehler oder deaktivierte Konten werden nicht kontaktiert (`409`). Rate Limit: 10 Provider-Suchen pro Konto und Minute (`429`), im Speicher der API.
- **Ordner:** ein angegebener Ordner, sonst INBOX und alle auswählbaren Ordner außer Spam und Papierkorb (höchstens 20, INBOX und Rollen-Ordner zuerst). Kriterien: `q` → `TEXT` (Kopf und Text), `from` → `FROM`, `subject` → `SUBJECT`, `since`/`before` → `SINCE`/`BEFORE` (Eingangsdatum, `before` exklusiv).
- **Zuordnung:** Die UIDs des Providers werden mit der aktuellen UIDVALIDITY auf lokal synchronisierte Nachrichten (`message_location`) abgebildet; angezeigt werden nur diese (neueste 100). Treffer ohne lokale Kopie werden nur gezählt („weitere Treffer beim Anbieter“) – kein Nachladen auf Verdacht.
- **Kein Klartext gespeichert oder geloggt:** Suchbegriffe und Ergebnisse landen weder in der DB noch in Logs (Request-URLs werden ohne Query-String geloggt, Fehler nur als Code). Die UID-Listen einer Suche liegen höchstens 60 s im Speicher der API, unter einem gesalzenen Hash der Anfrage; Flags und Inhalte werden bei jeder Antwort frisch aus der DB gelesen. Antworten tragen `Cache-Control: no-store` und werden im Client nicht offline gespeichert.
- Die Suchqualität hängt vom Provider ab (z. B. vergleicht GreenMail `FROM` nur mit der vollständigen Adresse, RFC 3501 verlangt Teilstrings).
