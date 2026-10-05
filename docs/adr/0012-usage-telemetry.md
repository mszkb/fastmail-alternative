# ADR-0012: Anonyme Nutzungsstatistik (Opt-in)

- **Status:** Proposed
- **Datum:** 2026-10-05
- **Roadmap:** Phase 7, Aufgabe 7.6 (#78); Folgeaufgaben 7.7–7.10 (#79–#82)

## Kontext

Für Priorisierung und Support fehlt jede Rückmeldung, wie viele Instanzen laufen, auf welchen Versionen und Plattformen und welche Funktionen genutzt werden. Das Projekt ist self-hosted first (Prinzip 1), speichert Mailinhalte nur verschlüsselt (Prinzip 5) und gibt keine sensiblen Daten nach außen (Prinzipien 4 und 6). Eine Statistik darf diese Zusagen nicht aufweichen und keinen Rückschluss auf Personen, Konten oder Mailinhalte erlauben.

Rahmenbedingungen:

- Single-User-Instanzen, oft im Heimnetz oder auf einem Raspberry Pi; manche Betreiber wollen gar keine ausgehenden Verbindungen (Firma, Air-Gap).
- Es gibt noch keinen Projekt-Server; ein Collector ist eine externe Abhängigkeit (Hosting, Domain).
- Rechtsgrundlage in der EU: Einwilligung (DSGVO Art. 6 Abs. 1 lit. a); die Einwilligung muss freiwillig, informiert und jederzeit widerrufbar sein.

## Optionen

1. **Keine Telemetrie** – Null Risiko, aber keine Datengrundlage; Entscheidungen nur nach Issues und Einzelmeldungen.
2. **Opt-out-Telemetrie** – Viele Daten, widerspricht aber Datensparsamkeit, Einwilligungserfordernis und dem Vertrauen in ein Self-hosted-Projekt.
3. **Opt-in-Telemetrie mit fester Feld-Allowlist** – Wenige, aber saubere Daten; jede Instanz entscheidet selbst, Betreiber können die Funktion hart abschalten.
4. **Nur passive Signale** (z. B. Abrufe der Release-Images) – Keine Änderung an der App, aber nur Versions-Trends, keine Funktionsnutzung; Registry-Zahlen enthalten Rebuilds und CI.

## Entscheidung

**Option 3 (vorgeschlagen):** freiwillige, anonyme Nutzungsstatistik mit folgenden Regeln.

1. **Opt-in, nie Opt-out.** Standard ist aus. Gesendet wird erst nach ausdrücklicher Zustimmung im UI (Einstellungen, eigener Abschnitt mit Vorschau). Der Widerruf wirkt sofort: kein weiterer Report, die Telemetrie-ID wird gelöscht.
2. **Betreiber-Override.** `TELEMETRY=off` in `.env` schaltet die Funktion hart ab; die Frage erscheint dann nicht, der Worker sendet nie. Ohne konfigurierte Collector-URL ist die Funktion ebenfalls aus.
3. **Self-hosted first.** Die Instanz funktioniert ohne Collector vollständig. Ausfall, Sperre oder Fehler des Endpunkts haben keine Auswirkung auf Sync, Versand oder UI; Fehler werden nur als Code geloggt. Die Collector-URL ist konfigurierbar (`TELEMETRY_URL`), ein eigener Collector ist möglich.
4. **Datensparsamkeit.** Nur Felder aus einer versionierten Allowlist (7.7): Versionen, Architektur, Deployment-Art, Buckets statt exakter Zahlen, Booleans für Funktionsnutzung. Keine Freitexte. **Nie:** Mailinhalte, Betreffzeilen, Adressen, Dateinamen, Ordner-, Host- oder Domainnamen, Benutzernamen, IP-Adressen, exakte Zeitstempel einzelner Aktionen, Fehlertexte der Anbieter, Push-, Session- oder Konto-IDs. Das Schema liegt in `packages/shared`; unbekannte Felder werden vor dem Senden verworfen.
5. **Kennung.** Zufällige Telemetrie-ID, getrennt von Push-Installations-ID und Session-IDs, nicht aus anderen Daten abgeleitet. Sie rotiert jährlich und wird beim Widerruf gelöscht.
6. **Transport.** Höchstens ein Report pro Woche (Job in der bestehenden Job-Tabelle, ADR-0003), HTTPS, ohne Cookies und ohne Fingerprinting. Bei Fehlern kein Wiederholungssturm: nächster Versuch frühestens zum nächsten Wochentermin.
7. **Collector.** Speichert keine IP-Adressen, auch nicht in Access-Logs des Reverse Proxys. Er hält nur aggregierte Zählungen bzw. den letzten Report je Telemetrie-ID mit Löschfrist (90 Tage) und lehnt ungültige oder zusätzliche Felder ab.
8. **Transparenz.** Das UI zeigt vor der Zustimmung und jederzeit danach den exakten Payload. Die Doku listet jedes Feld mit Zweck („Was wird gesendet und warum“). Aggregate können öffentlich gemacht werden.
9. **Ort des Collectors (7.10).** Er kommt als eigene kleine App in dieses Repository (`apps/telemetry-collector`) und nutzt dasselbe Schema aus `packages/shared`. In `docker-compose.yml` läuft er nur über ein eigenes Compose-Profil und nie standardmäßig. Ein separates Repository würde das Schema duplizieren.

Prinzipien aus CLAUDE.md:

- **1 Self-hosted first:** Die Telemetrie ist optional und ohne Collector folgenlos; ein eigener Collector ist möglich.
- **4 Keine Mailinhalte nach außen:** Die Allowlist schließt Inhalte und Metadaten von Mails aus.
- **5 Secrets und Inhalte nie im Klartext:** Die Telemetrie liest keine verschlüsselten Felder und braucht keinen Master-Key.
- **6 Keine sensiblen Daten in Logs:** Fehler beim Senden werden nur als Code geloggt, nie mit Payload oder Antwort des Collectors.

## Konsequenzen

- **Einfacher:** Entscheidungen über Plattformen (arm64 vs. amd64), Versionen und genutzte Funktionen bekommen eine Datengrundlage.
- **Schwieriger:** Die Datenbasis ist durch Opt-in klein und verzerrt (eher technikaffine Nutzer); Zahlen sind Trends, keine Gesamtzahlen.
- **Pflege:** Jedes neue Feld braucht eine Schema-Version, eine Doku-Zeile und ein Review gegen die Verbotsliste.
- **Betrieb:** Für den Projekt-Collector braucht es Hosting und Domain (externe Abhängigkeit, `docs/process/external-dependencies.md`). Bis dahin ist `TELEMETRY_URL` leer und die Frage bleibt ausgeblendet.
- **Folgeaufgaben:** 7.7 Datenkatalog und Schema (#79), 7.8 Opt-in-UI und API (#80), 7.9 wöchentlicher Report-Job (#81), 7.10 Collector (#82).
