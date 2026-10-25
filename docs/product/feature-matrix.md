# Feature-Matrix Web ↔ App

Stand der PWA und Plan für die nativen Apps (Phase 9, Epic #136, [ADR-0015](../adr/0015-mobile-kotlin-multiplatform.md)). Ziel ist Parität: Jede Funktion der PWA kommt in die Apps. Ausnahmen sind unten begründet.

Legende: ✅ vorhanden · 🟨 teilweise · ⬜ geplant · ➖ bewusst nicht vorgesehen (Begründung in der Spalte „Anmerkung“)

Nicht aufgeführt sind reine Server- und Betreiberfunktionen ohne Client-Anteil, z. B. Sync-Worker, Backups, Cleanup, Metriken und Deployment. Für Web- und App-Clients gelten sie gleich.

**Pflege:** Neue Funktionen der PWA bekommen hier eine Zeile. Fehlt sie in den Apps, wird ein Mobile-Folge-Issue angelegt und verlinkt ([Definition of Done](../process/definition-of-done.md)).

## Anmeldung, Instanz, Geräte

| Funktion                                          | Web | iOS | Android | App-Issue  | Anmerkung                                                                               |
| ------------------------------------------------- | --- | --- | ------- | ---------- | --------------------------------------------------------------------------------------- |
| Instanz-URL eingeben und verbinden                | ➖  | ⬜  | ⬜      | #146       | Die PWA läuft auf der Instanz selbst, die App muss deren Adresse kennen.                |
| Ersteinrichtung mit Setup-Code (Benutzer anlegen) | ✅  | ➖  | ➖      | –          | Einmalig beim Self-Hosting, im Browser; die App meldet sich an eine fertige Instanz an. |
| Login mit Passwort                                | ✅  | ⬜  | ⬜      | #146, #138 | Web: Session-Cookie; App: gerätegebundenes Bearer-Token (#138, Server fertig).          |
| Geräteliste, Gerät widerrufen                     | ✅  | ⬜  | ⬜      | #146       | Widerrufenes Token → App löscht ihren lokalen Cache.                                    |
| Passwort ändern                                   | ✅  | ⬜  | ⬜      | #153       |                                                                                         |
| App-Sperre mit Face ID / Biometrie                | ➖  | ⬜  | ⬜      | #156, #159 | Nur nativ möglich.                                                                      |

## Konten

| Funktion                                                           | Web | iOS | Android | App-Issue | Anmerkung                                                           |
| ------------------------------------------------------------------ | --- | --- | ------- | --------- | ------------------------------------------------------------------- |
| Konto hinzufügen mit Anbieter-Vorlagen (#117)                      | ✅  | ⬜  | ⬜      | #153      |                                                                     |
| Server-Einstellungen automatisch erkennen (Autoconfig, #165)       | ✅  | ⬜  | ⬜      | #153      | Läuft auf dem Server (`GET /api/autoconfig`), die App ruft ihn auf. |
| Verbindungstest                                                    | ✅  | ⬜  | ⬜      | #153      |                                                                     |
| OAuth2 mit Google / Microsoft (#36)                                | ✅  | ⬜  | ⬜      | #153      | App: System-Browser (ASWebAuthenticationSession / Custom Tabs).     |
| Konto bearbeiten, löschen, Sync-Limit (`sync_since`)               | ✅  | ⬜  | ⬜      | #153      |                                                                     |
| Identitäten / Aliase                                               | ✅  | ⬜  | ⬜      | #153      |                                                                     |
| Ordnerrollen zuordnen                                              | ✅  | ⬜  | ⬜      | #153      |                                                                     |
| Kontoleiste mit Initialen, Kontofarbe, Ungelesen-Zahl, Fehlerpunkt | ✅  | ⬜  | ⬜      | #147      | Kontofarben aus `packages/design-tokens`.                           |
| Kontowechsel                                                       | ✅  | ⬜  | ⬜      | #147      |                                                                     |
| Konten per Drag & Drop sortieren                                   | ✅  | ⬜  | ⬜      | #147      |                                                                     |
| Gemeinsamer Posteingang (optional, standardmäßig aus)              | ✅  | ⬜  | ⬜      | #147      |                                                                     |
| „Neu anmelden“ bei abgelaufenem OAuth-Zugang                       | ✅  | ⬜  | ⬜      | #153      |                                                                     |

## Ordner, Liste, Lesen

| Funktion                                                                       | Web | iOS | Android | App-Issue | Anmerkung                                                                    |
| ------------------------------------------------------------------------------ | --- | --- | ------- | --------- | ---------------------------------------------------------------------------- |
| Ordnerliste mit Rollen-Symbolen                                                | ✅  | ⬜  | ⬜      | #148      |                                                                              |
| Nachrichtenliste mit Datumsgruppen, älteres Nachladen                          | ✅  | ⬜  | ⬜      | #148      |                                                                              |
| Threads                                                                        | ✅  | ⬜  | ⬜      | #148      |                                                                              |
| Mehrfachauswahl und Sammelaktionen (#114)                                      | ✅  | ⬜  | ⬜      | #151      | App: langes Drücken statt Checkbox/Shift-Klick.                              |
| Aktionen beim Überfahren mit der Maus                                          | ✅  | ➖  | ➖      | –         | Kein Hover auf Touch; in den Apps übernehmen Wischgesten (#151) diese Rolle. |
| Wischgesten auf Listeneinträgen (archivieren, löschen)                         | ➖  | ⬜  | ⬜      | #151      | In der PWA nur Wisch-Navigation (#75), keine Gesten auf Einträgen.           |
| Wisch-Navigation zurück/vor (#75)                                              | ✅  | ⬜  | ⬜      | #148      | App: System-Zurück-Geste (iOS-Kante, Android Predictive Back).               |
| Nachricht lesen mit sicherem HTML-Rendering                                    | ✅  | ⬜  | ⬜      | #149      | Sanitizing auf dem Server; App rendert ohne Skripte.                         |
| Externe Inhalte blockieren, auf Wunsch laden                                   | ✅  | ⬜  | ⬜      | #149      |                                                                              |
| Inline-Bilder und Anhänge anzeigen, herunterladen                              | ✅  | ⬜  | ⬜      | #149      | App: Teilen/Öffnen mit (#156, #159).                                         |
| Basisaktionen: gelesen/ungelesen, markieren, archivieren, löschen, verschieben | ✅  | ⬜  | ⬜      | #151      |                                                                              |

## Verfassen und Senden

| Funktion                                                | Web | iOS | Android | App-Issue  | Anmerkung                                                                   |
| ------------------------------------------------------- | --- | --- | ------- | ---------- | --------------------------------------------------------------------------- |
| Neue Mail, Antworten, Allen antworten, Weiterleiten     | ✅  | ⬜  | ⬜      | #150       |                                                                             |
| Absenderwahl (Identitäten), Cc/Bcc                      | ✅  | ⬜  | ⬜      | #150       |                                                                             |
| Empfänger-Vorschläge aus bekannten Adressen             | ✅  | ⬜  | ⬜      | #150       |                                                                             |
| Entwürfe mit Autosave und IMAP-Drafts-Sync              | ✅  | ⬜  | ⬜      | #150       |                                                                             |
| Anhänge hinzufügen                                      | ✅  | ⬜  | ⬜      | #150       | Web auch per Drag & Drop; App aus Dateien/Fotos.                            |
| Postausgang (Outbox) mit Wiederholung                   | ✅  | ⬜  | ⬜      | #150       |                                                                             |
| Rückgängig-Senden-Fenster                               | ✅  | ⬜  | ⬜      | #150       |                                                                             |
| Antwort direkt unter der Nachricht (breite Bildschirme) | ✅  | ⬜  | ⬜      | #150       | Auf dem Handy Vollbild wie in der PWA; iPad/Tablet wie Web.                 |
| Als Mail-App für `mailto:`-Links registrieren           | ➖  | ⬜  | ⬜      | #156, #159 | Die PWA registriert sich nicht als Handler (iOS erlaubt es Web-Apps nicht). |
| Teilen aus anderen Apps als Anhang                      | ➖  | ⬜  | ⬜      | #156, #159 | Share-Target nur nativ zuverlässig (iOS kennt kein Web Share Target).       |

## Suche

| Funktion                                                    | Web | iOS | Android | App-Issue  | Anmerkung                                      |
| ----------------------------------------------------------- | --- | --- | ------- | ---------- | ---------------------------------------------- |
| Suche im aktiven Konto (IMAP `SEARCH`)                      | ✅  | ⬜  | ⬜      | #152       |                                                |
| Globale Suche über alle Konten (#121)                       | ✅  | ⬜  | ⬜      | #152       |                                                |
| Such-Operatoren (`from:`, `to:`, `subject:`, `is:unread` …) | ✅  | ⬜  | ⬜      | #152       | Parser aus `@fma/shared` wird portiert (#144). |
| Offline-Suche im lokalen Cache (#162)                       | ✅  | ⬜  | ⬜      | #152, #145 |                                                |

## Sync, Offline, Push

| Funktion                                              | Web | iOS | Android | App-Issue  | Anmerkung                                                                |
| ----------------------------------------------------- | --- | --- | ------- | ---------- | ------------------------------------------------------------------------ |
| Sync beim Start und bei Rückkehr in den Vordergrund   | ✅  | ⬜  | ⬜      | #147       | Prinzip 3: Push ist nur ein Hinweis.                                     |
| Manueller Sync: Button und Pull-to-Refresh            | ✅  | ⬜  | ⬜      | #148       |                                                                          |
| Sync-Status je Konto, Sync stoppen (#119)             | ✅  | ⬜  | ⬜      | #147       |                                                                          |
| Verschlüsselter Offline-Cache                         | ✅  | ⬜  | ⬜      | #145       | Web: IndexedDB; App: verschlüsselte DB, Schlüssel in Keychain/Keystore.  |
| Offline-Warteschlange für Aktionen                    | ✅  | ⬜  | ⬜      | #145       |                                                                          |
| Hintergrund-Sync                                      | ➖  | ⬜  | ⬜      | #156, #159 | Browser erlauben keinen verlässlichen Hintergrund-Sync.                  |
| Push-Benachrichtigung ohne Inhalte                    | ✅  | ⬜  | ⬜      | #155, #158 | Web Push (VAPID); App: APNs/FCM direkt oder über das Relay (#139, #140). |
| App-Badge mit Ungelesen-Zahl                          | ✅  | ⬜  | ⬜      | #155, #158 |                                                                          |
| Benachrichtigung öffnet die App und stößt den Sync an | ✅  | ⬜  | ⬜      | #155, #158 |                                                                          |

## Darstellung und Bedienung

| Funktion                                                | Web | iOS | Android | App-Issue  | Anmerkung                                                                 |
| ------------------------------------------------------- | --- | --- | ------- | ---------- | ------------------------------------------------------------------------- |
| Hell / Dunkel / wie das System                          | ✅  | ⬜  | ⬜      | #153       | Farben aus `packages/design-tokens` (#141).                               |
| Dichte Normal / Kompakt                                 | ✅  | ⬜  | ⬜      | #153       |                                                                           |
| Installierbare Themes (`*.fmatheme.json`, #126)         | ✅  | ⬜  | ⬜      | #153       | Gleiches Format, Werte auf das Compose-Theme abgebildet.                  |
| Lesebereich rechts / unten / aus, Spaltenbreiten (#113) | ✅  | ⬜  | ⬜      | #156, #159 | Nur auf iPad/Tablets sinnvoll; auf dem Handy immer Liste → Nachricht.     |
| Tastenkürzel mit Übersicht unter `?` (#115)             | ✅  | ⬜  | ➖      | #156       | Nur mit Hardware-Tastatur am iPad; auf Android-Tablets später bei Bedarf. |
| Kopfzeile mit Suche, Hilfe, Profil-Menü                 | ✅  | ⬜  | ⬜      | #147       | App: native Navigationsleiste.                                            |
| Karte „Erste Schritte“                                  | ✅  | ⬜  | ⬜      | #146       |                                                                           |
| Speicherverbrauch je Konto, Export der Konfiguration    | ✅  | ⬜  | ⬜      | #153       |                                                                           |

## Nur im Web

| Funktion                                                 | Web | iOS | Android | Anmerkung                                              |
| -------------------------------------------------------- | --- | --- | ------- | ------------------------------------------------------ |
| Installationshinweise (Zum Home-Bildschirm, Roadmap 4.2) | ✅  | ➖  | ➖      | Die App ist bereits installiert.                       |
| Update-Hinweis für den Service Worker                    | ✅  | ➖  | ➖      | Apps werden über App Store / Google Play aktualisiert. |

## E2E-Tests der Apps

Offen in #154: Login, Mail lesen, senden und Push-Registrierung gegen eine Test-Instanz mit GreenMail (z. B. Maestro), Android in CI, iOS mindestens nightly. Voraussetzung ist das App-Gerüst mit CI (#142).
