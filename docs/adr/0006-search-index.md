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
- **Schutz wie bei jeder Provider-Verbindung:** SSRF-Prüfung des Hosts, Port-Allowlist und STARTTLS-Pflicht (Transport-Policy), Connect-/Greeting-/Socket-Timeouts und eine Gesamtfrist, danach wird die Verbindung geschlossen. Konten mit Anmeldefehler oder deaktivierte Konten werden nicht kontaktiert (`409`). Rate Limit: 10 Provider-Suchen pro Konto und Minute (`429`); im PHP-Backend in der Tabelle `rate_limit` (früher im Speicher der Node-API).
- **Ordner:** ein angegebener Ordner, sonst INBOX und alle auswählbaren Ordner außer Spam und Papierkorb (höchstens 20, INBOX und Rollen-Ordner zuerst). Kriterien: `q` → `TEXT` (Kopf und Text), `from` → `FROM`, `subject` → `SUBJECT`, `since`/`before` → `SINCE`/`BEFORE` (Eingangsdatum, `before` exklusiv).
- **Zuordnung:** Die UIDs des Providers werden mit der aktuellen UIDVALIDITY auf lokal synchronisierte Nachrichten (`message_location`) abgebildet; angezeigt werden nur diese (neueste 100). Treffer ohne lokale Kopie werden nur gezählt („weitere Treffer beim Anbieter“) – kein Nachladen auf Verdacht.
- **Kein Klartext gespeichert oder geloggt:** Suchbegriffe und Ergebnisse landen weder in der DB noch in Logs (Request-URLs werden ohne Query-String geloggt, Fehler nur als Code). Das PHP-Backend hält keinen Ergebnis-Cache (PHP behält zwischen Requests keinen Zustand), jede Suche fragt den Anbieter neu und zählt fürs Rate Limit; die frühere Node-API hielt die UID-Listen höchstens 60 s im Speicher. Flags und Inhalte werden bei jeder Antwort frisch aus der DB gelesen. Antworten tragen `Cache-Control: no-store` und werden im Client nicht offline gespeichert.
- Die Suchqualität hängt vom Provider ab (z. B. vergleicht GreenMail `FROM` nur mit der vollständigen Adresse, RFC 3501 verlangt Teilstrings).

## Wann ein eigener Index wieder auf den Tisch kommt (Roadmap 5.2, 2026-10-05)

Die Entscheidung bleibt: kein eigener Index. Roadmap 5.2 (#52) wird erst begonnen, wenn mindestens einer dieser Punkte eintritt. Die ersten beiden müssen im Betrieb belegt sein (Issue mit Anbieter und Messwert, ohne Suchbegriffe oder Inhalte); der dritte ist eine Produktentscheidung:

- Ein in der [Anbieter-Matrix](../product/mail-providers.md) gelisteter Anbieter liefert für `TEXT`/`FROM`/`SUBJECT` regelmäßig falsche oder keine Treffer (z. B. nur exakte Adressen statt Teilstrings).
- Suchen dauern bei üblichen Postfächern (bis 10 000 Nachrichten je Ordner) regelmäßig länger als 10 s oder laufen in die 30-s-Frist.
- Offline-Suche wird zur Anforderung; dann zuerst die Suche über den verschlüsselten Offline-Cache auf dem Gerät prüfen, bevor ein Server-Index entsteht.

Ein Index muss dann die Bedingungen aus „Entscheidung“ erfüllen (verträglich mit der Verschlüsselung at rest) und braucht eine neue ADR.

## Nachtrag: Globale Suche über alle Konten (#121, 2026-10-09)

Die Entscheidung (IMAP `SEARCH`, kein eigener Index) bleibt. Ergänzt wird eine Suche über alle Konten, `GET /api/search`; die Suche pro Konto bleibt unverändert bestehen.

- **Fan-out nacheinander statt parallel:** PHP hat keine günstige Parallelität (Shared Hosting eingeschlossen). Die Konten werden deshalb nacheinander durchsucht, jedes mit eigener Frist (10 s, Verbindungsaufbau höchstens 8 s) innerhalb einer Gesamtfrist von 25 s. Ein Konto, das scheitert, in die Frist läuft, einen Anmeldefehler hat oder sein Rate Limit erreicht hat, bekommt den Status `error`/`timeout`/`auth_error`/`rate_limited` in `accounts`; die Treffer der anderen kommen trotzdem (Prinzip 7). Echte Parallelität (nicht-blockierende Sockets) folgt erst, wenn Messungen sie verlangen.
- **Ergebnis-Zwischenspeicher:** Die UID-Listen einer Suche (je Ordner höchstens 10 000, neueste zuerst) liegen 5 Minuten in der Tabelle `search_result` – nur Konto-, Ordner-IDs, UIDVALIDITY und UIDs, nie Suchbegriffe oder Inhalte. Spätere Seiten lesen sie, statt erneut zu suchen. Ist der Eintrag abgelaufen, sucht der Cursor transparent neu (zählt fürs Rate Limit) und setzt an derselben Stelle fort. Abgelaufene Einträge löschen die nächste Suche und der Cleanup-Job; die Tabelle ist Laufzeitzustand und nicht im Backup. 5 statt der früheren 60 s, damit Lesen und Weiterblättern nicht ständig neue Provider-Suchen auslösen.
- **Zusammenführen:** Jeder Ordner ist ein nach UID absteigend sortierter Strom; eine Seite nimmt jeweils den Stromkopf mit dem neuesten Datum (k-way merge). UIDs folgen dem Eingang, so ist die Liste über Konten und Ordner nach Datum sortiert, und jede Seite schließt lückenlos und ohne Duplikate an die vorige an (Position = letzte gezeigte UID je Ordner).
- **Cursor:** opak, mit einem aus `MASTER_KEY` abgeleiteten Schlüssel per HMAC signiert. Er enthält die Ergebnis-ID, einen Schlüssel-Hash der Anfrage (ein Cursor passt nur zu seiner Suche, die Begriffe stehen nicht lesbar darin) und die UID-Positionen je Ordner und UIDVALIDITY (ändert sich die UIDVALIDITY, beginnt der Ordner nach einer erneuten Suche von vorn).
- **Treffer ohne lokale Kopie** werden jetzt angezeigt statt nur gezählt: Ihre Listen-Kopfdaten (Betreff, Absender, Datum, Flags, Anhang ja/nein) holt `UID FETCH (ENVELOPE FLAGS INTERNALDATE BODYSTRUCTURE)` nur für die aktuelle Seite. **Sie werden nicht zwischengespeichert**, weder verschlüsselt noch im Klartext: Sie erscheinen ohnehin nach dem nächsten Sync verschlüsselt in der DB, und ein zweiter Speicherort für Inhalte wäre zusätzliche Angriffsfläche. Solche Treffer tragen `id: null, synced: false` und lassen sich erst nach dem Sync öffnen.
- **Neue Kriterien** (beide Endpunkte): `to` → `TO`, `unread` → `UNSEEN`, `attachment` → `HEADER Content-Type "multipart/mixed"` (IMAP kennt kein Anhang-Kriterium; das ist eine Näherung, die Mails mit Anhang üblicherweise trifft). Die PWA übersetzt Operatoren im Suchfeld (`from:`, `to:`, `subject:`, `before:`, `after:`, `has:attachment`, `is:unread`) in diese Parameter.
- **Ordner** wie bisher: INBOX und alle auswählbaren Ordner außer Spam und Papierkorb, höchstens 20 je Konto.
- **Abbruch:** Der Client bricht laufende Anfragen ab (AbortController). PHP bemerkt den Abbruch erst beim Schreiben der Antwort; die IMAP-Verbindungen werden spätestens mit dem Request-Ende geschlossen.
