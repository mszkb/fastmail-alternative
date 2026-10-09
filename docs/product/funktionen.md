# Funktionen im Überblick

Was die App kann, kurz erklärt für Nutzer und Betreiber – ohne technische Details. Je Funktion: was sie tut, wo sie in der App liegt, wie weit sie ist und wo es ausführlicher steht. Welche Datei eine Funktion umsetzt und ob es sie auch in der Android-App gibt, steht in der [Feature-Matrix](feature-matrix.md); den gesamten Änderungsverlauf führt das [CHANGELOG](../../CHANGELOG.md).

Legende: ✅ fertig · 🟨 offen: … · 📅 geplant

Die Liste beginnt mit den Funktionen aus PR #163 (Epic #111) und wird mit jeder neuen Funktion ergänzt.

## Suche

### Globale Suche über alle Konten

🟨 offen: Messung auf dem Raspberry Pi und mit echten Anbietern · Issue #121

**Was sie tut:** Durchsucht alle Konten auf einmal, und zwar direkt beim jeweiligen Mailanbieter (IMAP `SEARCH`). Es gibt keinen eigenen Suchindex, die Suche geht deshalb nur online. Die Treffer aller Konten erscheinen gemischt nach Datum in einer Liste.

**Wo in der App:** Suchfeld in der Kopfzeile, die Taste `/` springt hinein; auf dem Handy öffnet sich die Suche als Vollbild.

- **Bereich:** „Alle Konten“, „Nur dieses Konto“ oder „Nur dieser Ordner“.
- **Ordner:** Durchsucht werden alle Ordner außer Spam und Papierkorb. Mit „Spam und Papierkorb einbeziehen“ kommen beide dazu; ihre Treffer sind farbig markiert. Gmails „Alle Nachrichten“ wird nie durchsucht, weil dort jede Mail ein zweites Mal liegt (sonst gäbe es doppelte Treffer).
- **Operatoren im Suchfeld:**
  - `from:`, `to:`, `subject:`
  - `before:` und `after:` mit Datum im Format `JJJJ-MM-TT`
  - `has:attachment`, `is:unread`
  - Werte mit Leerzeichen in Anführungszeichen, z. B. `from:"Anna Muster"`
  - `has:attachment` ist eine Näherung: Es findet die üblichen Mails mit Anhang, aber nicht jede (siehe [Mailanbieter – Suche beim Anbieter](mail-providers.md#suche-beim-anbieter)).
- **Trefferliste:**
  - Jeder Treffer zeigt Konto-Icon und Ordner; der Suchbegriff ist im Betreff hervorgehoben.
  - Oben steht der Stand, z. B. „1–50 von ca. 1 240“. Weitere Treffer laden beim Scrollen.
  - „Suche beenden“ führt zurück zur Liste.
- **Konten mit Problemen:** Antwortet ein Konto nicht rechtzeitig, hat es einen Anmeldefehler oder wurde es zu oft durchsucht, steht das mit eigener Meldung und „Erneut versuchen“ in der Liste. Die Treffer der anderen Konten kommen trotzdem.
- **Noch nicht synchronisierte Treffer:** Mails, die beim Anbieter gefunden wurden, aber noch nicht abgeglichen sind, erscheinen mit „Noch nicht synchronisiert“. Öffnen lassen sie sich erst nach dem Abgleich.
- **Treffer öffnen:** Ein Treffer öffnet sich im Konto und Ordner, in dem er liegt. Antworten und Aktionen wirken dort, also immer aus dem richtigen Konto.
- **Datenschutz:** Suchbegriffe werden nie gespeichert oder geloggt. Nur die Trefferlisten (Nummern der Mails, keine Inhalte) liegen 5 Minuten auf dem Server, damit das Weiterblättern nicht neu suchen muss.
- **Grenzen:**
  - je Konto höchstens 10 Suchen beim Anbieter pro Minute;
  - je Konto 10 Sekunden Zeit, für die ganze Suche 25 Sekunden;
  - langsamere Konten erscheinen mit „Zeitüberschreitung“.
- **Messwerte (Entwicklungsmaschine, noch nicht auf dem Pi):**
  - Die erste Seite über 3 Konten mit 10 500 Treffern kam nach 0,55 s.
  - Das Scrollen durch 10 000 Treffer lief flüssig (60 Bilder pro Sekunde).
- **Die bisherige Suche pro Konto bleibt:** der Filter über der Nachrichtenliste mit Von, Betreff, Zeitraum, Suchbegriff und „Nur in diesem Ordner“. Nach Empfänger, Ungelesen oder Anhang sucht man mit den Operatoren oben, für ein einzelnes Konto mit dem Bereich „Nur dieses Konto“.

**Ausführlich:**

- [ADR-0006, Nachtrag Globale Suche](../adr/0006-search-index.md#nachtrag-globale-suche-über-alle-konten-121-2026-10-09)
- [Mailanbieter – Suche beim Anbieter](mail-providers.md#suche-beim-anbieter)
- [Lasttest – Globale Suche](../operations/load-test.md#globale-suche-121-2026-10-09-entwicklungsmaschine-kein-pi)

### Offline-Suche in den gespeicherten Nachrichten

📅 geplant · Issue #162

**Was sie tun soll:** Auch ohne Netz in den Nachrichten suchen, die auf dem Gerät gespeichert sind. Bis dahin sucht die App nur online beim Anbieter.

## Darstellung

### Installierbare Themes

✅ fertig · Issue #126

**Was sie tun:** Ein Theme ändert das Aussehen der App:

- Farben für hell und dunkel, Abstände, Schriftgrößen und Rundungen;
- beim Aktivieren einmalig auch Lesebereich, Dichte der Liste und Kontoleiste (danach wie gewohnt änderbar).

Ein Theme ist eine reine Beschreibungsdatei: kein Code, kein CSS, keine externen Adressen.

**Wo in der App:** Einstellungen → Darstellung → „Theme installieren …“: Datei `*.fmatheme.json` hochladen, dann Vorschau, Aktivieren oder Löschen. „Standard“ ist immer verfügbar.

- **Pro Gerät:** Welches Theme aktiv ist, gilt je Gerät, auch offline. Die installierten Themes liegen auf dem Server; Installieren und Löschen gehen nur online.
- **Kontrastprüfung:** Ein Theme mit zu wenig Kontrast (unter WCAG AA) wird trotzdem installiert, aber mit Warnung. Die Meldung nennt die betroffenen Farben; in der Liste steht „geringer Kontrast“.
- **Notausgang:** Macht ein Theme die Oberfläche unbenutzbar, die Adresse mit `?theme=default` öffnen (z. B. `https://mail.example.org/?theme=default`).
- **Umsteiger-Themes:** Das Zusatzpaket im Ordner `themes/` enthält drei Themes:
  - „Kompakt (wie Gmail)“
  - „Klassisch (wie Outlook)“
  - „Übersichtlich (wie Fastmail)“

  Sie übernehmen nur Anordnung und Dichte und haben eigene Farben, keine Logos und keine anderen Markenelemente. Es besteht keine Verbindung zu Google, Microsoft oder Fastmail.

- **Eigene Themes:** Anleitung und Schema in der Doku.

**Ausführlich:**

- [Eigene Themes erstellen](../themes/README.md) (mit [Schema](../themes/schema.json))
- [Umsteiger-Themes](../../themes/README.md)

## Verbesserungen

Behobene Fehler aus PR #163:

- **Verfassen:**
  - Der Knopf „Rückgängig“ beim Senden war unsichtbar, jetzt ist er sichtbar.
  - Empfänger-Vorschläge gingen verloren, wenn man schnell zwischen An, Cc und Bcc wechselte.
- **Tastenkürzel:**
  - Nach `?` und `Esc` öffnete `Enter` wieder die Hilfe statt der Nachricht.
  - Während die Suche oder der gemeinsame Posteingang offen war, wirkten Kürzel wie Archivieren oder Löschen auf das verdeckte Postfach. Jetzt nicht mehr.
- **Handy:** Das Sync-Panel lag unter der Nachrichtenliste, „Stoppen“ war nicht erreichbar.

## Für Betreiber

Was sich mit PR #163 am Server ändert:

- **Migrationen**, laufen automatisch beim Start bzw. mit `bin/migrate.php` und `scripts/upgrade.sh` ([Upgrade](../operations/upgrade.md)):
  - `0006_search_result`: kurzlebige Trefferlisten der globalen Suche, ohne Suchbegriffe und Inhalte. Das ist Laufzeitzustand und nicht im Backup.
  - `0007_user_theme`: installierte Themes, im Backup enthalten.
- **Keine Änderung an der `.env` nötig.**
- **Neue API-Endpunkte** (siehe [`docs/api/openapi.yaml`](../api/openapi.yaml)):
  - `GET /api/search` für die globale Suche;
  - `GET /api/themes` und `POST /api/themes` für Themes auflisten und installieren;
  - `DELETE /api/themes/{id}` für Theme löschen.
