# ADR-0001: Mail-Cache-Modus

- **Status:** Accepted
- **Datum:** 2026-10-02 (Ergänzung 2026-10-03: Server-Kopie ist ein wiederherstellbarer Spiegel)
- **Roadmap:** 0.2, 2.2, 5.4

## Kontext

Wie viel Mailinhalt speichert der Server? Das bestimmt Geschwindigkeit, Offline-Fähigkeit, Suchqualität, Speicherbedarf und Datenschutz.

## Optionen

1. **Proxy**: Der Server speichert nur Metadaten; Bodies werden on demand vom IMAP-Server geladen.
2. **Index**: Metadaten und ein Volltextindex; Bodies on demand.
3. **Cache**: Metadaten, Bodies und Anhänge liegen vollständig auf dem Server.
4. **Konfigurierbar**: alle Modi als Instanz-Einstellung.

## Entscheidung

**Nur Cache-Modus: Der Server speichert alle Mails vollständig, also Texte und Anhänge, verschlüsselt.** (Entscheidung Produktowner, 2026-10-02: „Server soll Mails speichern, ist ja der Sinn am Self-hosted.")

- Bodies und Anhänge werden beim Sync geladen und verschlüsselt im **lokalen Docker-Volume** abgelegt (siehe ADR-0007, [`../architecture/data-model.md`](../architecture/data-model.md)).
- Wie weit die Historie beim ersten Sync zurückreicht, ist **pro Konto einstellbar** (z. B. 3 Monate, 1 Jahr, alles). Synchronisiert wird von neu nach alt.
- Es gibt keine weiteren Modi, keinen Moduswechsel und keinen Reindex-Pfad.

### Ergänzung 2026-10-03: Die Server-Kopie ist ein Spiegel, kein Archiv

Quelle der Wahrheit für Mails bleibt der IMAP-Server des Anbieters. Die gespeicherte Kopie (Rohmails in `mail-data`, Metadaten und Plaintext in der DB) spiegelt ihn. Was beim Anbieter gelöscht wird, löscht der Sync auch hier (Expunge-Abgleich, Roadmap 2.2). Daraus folgt eine verbindliche Regel:

**Alles, was der Server aus IMAP geladen hat, muss sich jederzeit aus IMAP neu aufbauen lassen.** Fehlt eine Rohmail-Datei oder das ganze Volume, ist das kein Datenverlust, sondern ein Fall für den Sync.

Damit gibt es zwei Arten von Daten:

| Art                                     | Beispiele                                                                                                                                                                                                     | Ohne Backup verloren?         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| **Instanzzustand** (nur auf dem Server) | `user`, `device`/`session`, `push_subscription`, `mail_account` inkl. Zugangsdaten und DEKs, `identity`, Ordnerrollen-Overrides, Einstellungen, `draft`, `outbox_message`, `attachment_upload`, offene `job`s | ja                            |
| **Spiegel** (aus IMAP ableitbar)        | `mail-data`, `message`, `message_location`, `message_body`, `thread`, Sync-Zustand der Ordner                                                                                                                 | nein, nur Zeit und Bandbreite |

Ziel ist, dass ein Betreiber für den Notfall nur **Instanzzustand und `MASTER_KEY`** sichern muss. Das ist klein und schnell. Das vollständige Backup mit `mail-data` bleibt der bequeme Weg für einen Umzug ohne erneuten Download ([Backup & Restore](../operations/backup-restore.md)).

Grund: Self-Hosting soll im Betrieb nicht aufwendiger sein als ein reiner IMAP-Webclient (z. B. SOGo, Roundcube), der gar keine Mails speichert. Der Mehrwert der Kopie (Geschwindigkeit, offline-first) darf nicht mit einem Backup-Zwang für viele Gigabyte erkauft werden.

**Grenze:** Mails, die beim Anbieter gelöscht oder von ihm weggeräumt wurden, sind nach einem Neuaufbau auch hier weg. Wer ein Archiv will, braucht ein Backup des Volumes (oder lässt die Mails beim Anbieter liegen).

## Konsequenzen

- Der Server ist unabhängig vom Provider schnell, und die Clients können offline-first arbeiten, weil der Server die vollständige Quelle ist.
- Der Speicherbedarf entspricht ungefähr der Größe aller synchronisierten Postfächer. Betreiber-Doku und Statusseite müssen ihn sichtbar machen.
- Ein vollständiges Backup umfasst Datenbank **und** Volume. Ohne Master-Key sind beide unlesbar. Für den Notfall reichen Instanzzustand und Master-Key; der Spiegel wird neu synchronisiert (siehe Ergänzung).
- Cleanup (5.5) betrifft nur verwaiste Dateien, nicht die Eviction.

### Folgeaufgaben aus der Ergänzung

- **Fehlende Rohmail selbst heilen:** Fehlt die Datei zu einer `message_body`-Zeile mit `storage_ref`, liefert die API eine verständliche Meldung statt eines Fehlers, und der Worker lädt die Mail per `UID FETCH` neu.
- **Neuaufbau ohne Volume:** Nach einem Restore ohne `mail-data` (oder mit leerem Volume) werden die Spiegel-Tabellen eines Kontos verworfen bzw. als veraltet markiert und neu synchronisiert, ohne Instanzzustand anzutasten.
- **Schlankes Backup:** `backup.js create` bekommt eine Variante ohne `mail-data` und ohne Spiegel-Tabellen; `restore` stößt danach den Neuaufbau an.
- **Nachgeladene Historie:** Per „Ältere Mails laden" geholte Mails liegen außerhalb des Standard-Sync-Fensters. Beim Neuaufbau muss die Tiefe pro Ordner erhalten bleiben (bzw. `sync_since` pro Konto gelten), sonst schrumpft die Historie unbemerkt.
- **Doku:** [Backup & Restore](../operations/backup-restore.md) und [Systemanforderungen](../operations/system-requirements.md) beschreiben beide Backup-Arten und was jeweils verloren geht.
