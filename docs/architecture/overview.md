# Architekturüberblick

> Status: entschieden, siehe ADRs in [`../adr/`](../adr/README.md).

## Komponenten

```
                         ┌───────────────────────────────────────────────────────────┐
 iPhone-PWA / Browser    │ Docker Compose                                            │
 (später: native Apps)   │                                                           │
┌──────────────────────┐ │ ┌────────┐   ┌──────────────┐   ┌──────────────────────┐ │
│ Nuxt-PWA             │ │ │        │──►│ web (PWA)    │   │ php (Slim, php-fpm)  │ │
│ - Service Worker     │◄┼►│ caddy  │   └──────────────┘   │ - Auth, Geräte       │ │
│ - IndexedDB-Cache    │ │ │  TLS   │──────────────────────►│ - Konten, Ordner,    │ │
│ - Offline-Queue      │ │ │        │                       │   Nachrichten, Suche │ │
└──────────▲───────────┘ │ └────────┘                       └──────────┬───────────┘ │
           │ Web Push    │                                             │             │
┌──────────┴───────────┐ │ ┌──────────────────────┐  ┌───────────────▼───────────┐ │
│ Push-Dienst (Apple,  │ │ │ worker (PHP)         │  │ mariadb                   │ │
│ Google, Mozilla)     │◄┼─│ - IMAP-Sync (IDLE)   │◄►│ Metadaten (verschlüsselt),│ │
└──────────────────────┘ │ │ - SMTP-Versand       │  │ job-Tabelle, Sessions     │ │
                         │ │ - Push, Cleanup      │  └───────────────────────────┘ │
                         │ └───────┬──────────┬───┘  ┌───────────────────────────┐ │
                         │         │          └─────►│ Volume mail-data          │ │
                         │         │                 │ Mails + Anhänge (verschl.)│ │
                         │         │                 └───────────────────────────┘ │
                         └─────────┼─────────────────────────────────────────────────┘
                                   │ IMAP/SMTP (Passwort oder OAuth2)
                         ┌─────────▼──────────────────────────────┐
                         │ Gmail · Outlook · Fastmail · eigener   │
                         └────────────────────────────────────────┘
```

| Komponente    | Verantwortung                                                                                                                                                                                                                                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **caddy**     | TLS über Let's Encrypt, Reverse Proxy (ADR-0007)                                                                                                                                                                                                                                                                                                 |
| **web**       | Nuxt/Vue-PWA, zu statischen Dateien gebaut (`apps/web`): Service Worker, IndexedDB-Cache, Offline-Queue. Dünner Client ohne eigene Geschäftslogik (ADR-0010)                                                                                                                                                                                     |
| **php**       | PHP-Backend `apps/server-php` (PHP ≥ 8.2, Slim 4, php-fpm; ADR-0013): REST/JSON unter `/api/*` mit OpenAPI-Vertrag ([`docs/api/`](../api/README.md)). Keine IMAP-Verbindungen direkt aus Requests: Alles Langlaufende läuft über Jobs. Ausnahmen sind die Suche über IMAP `SEARCH` (ADR-0006) und der Verbindungstest beim Anlegen eines Kontos. |
| **worker**    | Dasselbe PHP-Image mit `bin/worker.php`: Job-Schleife (IMAP-Sync, SMTP-Versand, Push, Cleanup) plus IMAP IDLE pro Konto. Ohne Dauer-Worker (Shared Hosting) arbeitet `bin/cron.php` die Jobs minütlich ab, dann ohne IDLE                                                                                                                        |
| **mariadb**   | MySQL 8 / MariaDB 10.6+: Benutzer, Geräte, Konten, Ordner, Nachrichtenmetadaten (lesbare Felder verschlüsselt), Threads, Jobs, Push-Subscriptions, Rate-Limits                                                                                                                                                                                   |
| **mail-data** | Docker-Volume mit allen Mails und Anhängen, verschlüsselt pro Konto (ADR-0001)                                                                                                                                                                                                                                                                   |

## Kernabläufe

### Neue Mail

1. Der IMAP-Sync-Worker erkennt eine neue Nachricht (IDLE oder Polling).
2. Er schreibt die Metadaten verschlüsselt in die Datenbank (MySQL/MariaDB) und legt Rohmail und Anhänge verschlüsselt im Volume ab.
3. Der Worker erzeugt einen Push-Job: Web Push mit inhaltsfreiem Payload (siehe [push.md](push.md)).
4. Offene Clients werden live informiert; geschlossene Clients synchronisieren beim nächsten Start oder Fokuswechsel.

### Aktion (z. B. Archivieren)

1. Der Client aktualisiert die UI optimistisch und sendet die Aktion an die API, offline zuerst in die Offline-Queue.
2. Die API persistiert die Absicht und erzeugt einen Job.
3. Der Worker führt das IMAP-Kommando aus. Bei einem Fehler wird der Zustand zurückgesetzt und der Client informiert.

## PWA-Shell und Service Worker (Roadmap 4.1)

- `apps/web/public/manifest.webmanifest` (standalone, `start_url`/`scope` `/`, Icons 192/512 „any“ und „maskable“) plus iOS-Meta-Tags und `apple-touch-icon` (`nuxt.config.ts`). Die Icons erzeugt `apps/web/scripts/generate-icons.mjs` ohne Bildbibliothek; die PNGs sind eingecheckt.
- Handgeschriebener Service Worker (`apps/web/service-worker/sw.js`) statt `@vite-pwa/nuxt`: wenige Zeilen, keine Workbox-Abhängigkeit, volle Kontrolle darüber, was gecacht wird. Nach `nuxt generate` schreibt `apps/web/scripts/build-sw.mjs` die Precache-Liste (index.html, gehashte Assets, Manifest, Icons) und einen Inhalts-Hash als Cache-Version in `/sw.js`.
- **Nur die App-Shell wird gecacht.** Navigationen bekommen die gecachte `index.html`, Shell-Dateien kommen cache-first. `/api/*` geht immer ans Netz und landet nie im Cache Storage; Maildaten für offline liegen verschlüsselt in IndexedDB (siehe unten, 4.6).
- Updates: Eine neue Version wird im Hintergrund installiert und wartet. Die App zeigt „Neue Version verfügbar – Neu laden“; erst der Klick aktiviert sie (`SKIP_WAITING`) und lädt neu. Damit geht kein offener Entwurf durch einen erzwungenen Reload verloren. Geöffnete PWAs suchen beim Wiederanzeigen (höchstens alle 10 min) nach Updates.
- nginx: `sw.js`, `manifest.webmanifest` und `index.html` mit `no-cache`, `/_nuxt/` (gehasht) `immutable`.

## Offline-first (Roadmap 4.6)

Die Regeln gelten für jeden Client gleich (ADR-0010); die Logik liegt testbar in `@fma/shared` (`offline.ts`), die PWA setzt sie in `apps/web/app/utils/offline-store.ts` und `offline-queue.ts` um. Sicherheit des lokalen Speichers: [security.md](security.md#offline-cache-im-client).

- **Lesen (stale-while-revalidate):** Kontoliste, Ordner, die ersten Listenseiten je Ordner, geöffnete Nachrichten, Unterhaltungen, HTML-Body und Identitäten werden zuerst aus dem lokalen Cache angezeigt und dann aus dem Netz aktualisiert; die Netzantwort ersetzt den Cache-Stand. Was nie geöffnet wurde, ist offline nicht da.
- **Start ohne Server:** Ist `GET /api/auth/status` nicht erreichbar, startet die App mit den Daten der letzten Sitzung und zeigt „Offline“. Sobald sie wieder online ist (`online`, Fokus, Minuten-Takt), prüft sie zuerst die Sitzung; ohne gültige Sitzung wird alles Lokale gelöscht.
- **Offline-Queue:** Aktionen (gelesen/ungelesen, markieren, archivieren, löschen, verschieben) und der Versand werden lokal sofort angewendet. Ohne Verbindung (`navigator.onLine` false oder Netzwerkfehler beim Senden) – oder solange ältere Einträge warten, damit die Reihenfolge stimmt – landen sie in der Queue. Neue Flag-Aktionen ersetzen ältere derselben Art auf derselben Nachricht (gelesen → ungelesen → gelesen wird einmal „gelesen“), nicht aber über ein Verschieben hinweg. Wartende Aktionen werden über neu geladene Listen gelegt, bis sie nachgereicht sind. Die App zeigt „N Aktionen ausstehend“.
- **Nachreichen:** beim Start, bei `online` und bei Fokus, streng in Reihenfolge, über Tabs hinweg per Web Lock serialisiert. Antwort 2xx → erledigt; Netzwerkfehler → später erneut (zählt nicht als Versuch); 409 (z. B. Nachricht nach Verschieben noch ohne UID) bis zu 3 Versuche, 5xx/429 bis zu 10, danach verworfen; andere 4xx (z. B. Nachricht inzwischen weg) → verworfen mit Hinweis; 401 → Abbruch, lokale Daten werden gelöscht. Danach lädt die Ansicht neu.
- **Entwürfe (Roadmap 2.8):** Das Verfassen-Formular speichert Änderungen nach 2 s automatisch auf dem Server (`PUT /api/drafts/:id`, Client-ID). Offline – oder solange ältere Einträge warten – landet das Speichern in der Queue (nur der neueste Stand je Entwurf bleibt, mit `force`; ein Versand mit `draftId` verwirft wartende Speicherungen seines Entwurfs). Die Entwurfsliste wird gecacht und mit wartenden Speicherungen überlagert, so dass offline geschriebene Entwürfe auch nach einem Reload sichtbar sind.
- **Versand ohne Doppelung:** Jedes Verfassen-Formular erzeugt eine `clientId` (UUID). `POST /api/outbox` mit einer schon bekannten `clientId` desselben Kontos legt nichts neu an und antwortet `200` mit dem vorhandenen Eintrag (eindeutiger Index `(account_id, client_id)`); das gilt auch für gleichzeitige Wiederholungen.

## Fehlerisolierung

- Jedes Konto hat einen eigenen Sync-Zustand, eigene Fehlerzähler und eigenen Backoff.
- Circuit Breaker pro Konto/Provider: Ein ausgefallener Provider hält die Jobs anderer Konten nicht auf.
- Ein abgelaufener OAuth-Token setzt nur dieses Konto auf `auth_error` (ADR-0011).
- Der Kontostatus (ok / Auth-Fehler / Provider nicht erreichbar) ist in der UI sichtbar.
- Umsetzung (Roadmap 3.4, ADR-0013): Es läuft immer nur ein Runner (`GET_LOCK`, egal ob Cron oder Dauer-Worker), der die Jobs nacheinander innerhalb eines Zeitbudgets abarbeitet; höchstens ein Job pro Konto ist `running`. Lange Jobs prüfen ihr Zeitbudget und setzen im nächsten Lauf ohne Duplikate fort. Verbindungsfehler werden als Code klassifiziert: Auth-Fehler → `auth_error` ohne automatische Wiederholung, bis die Zugangsdaten per `PATCH /api/accounts/:id` aktualisiert sind; Netzwerk-/TLS-/Timeout-Fehler → exponentieller Backoff über `next_retry_at` (1 min, verdoppelnd bis 1 h), ab 3 Fehlern in Folge Status `unreachable`. Solange der Circuit offen ist, werden keine Jobs des Kontos geholt. Ein erfolgreicher Sync setzt Status und Zähler zurück. Absturz-Erholung: Vor jedem Durchlauf reiht der Runner Jobs neu ein, die länger als 30 min als `running` markiert sind. Jobs, die ihre Versuche (`MAX_JOB_ATTEMPTS`) bereits aufgebraucht haben, gehen dabei auf `failed` (`WORKER_LOST`) statt endlos neu zu starten – ein abgebrochener Versand wird als fehlgeschlagen angezeigt.

## Quoten & Limits (Roadmap 3.5)

Alle Werte kommen aus der `.env` bzw. `config.php`, ungültige Werte fallen auf den Standard zurück:

- **Verbindungen pro Provider:** Höchstens `IMAP_MAX_CONNECTIONS_PER_HOST` (Standard 4) Jobs laufen gleichzeitig gegen denselben IMAP-Host (Groß-/Kleinschreibung egal), egal wie viele Konten dort liegen. Gezählt wird in der Datenbank (`running`-Jobs je Host). Ist ein Host ausgelastet, bleiben seine Jobs einfach in der Queue; Konten anderer Hosts laufen weiter. Pro Konto läuft weiterhin höchstens ein Job (3.4). IMAP-IDLE-Verbindungen zählen bewusst **nicht** mit: Sie sind eine zusätzliche, dauerhafte Verbindung je Konto und separat über `IMAP_IDLE_MAX_CONNECTIONS` begrenzt. Ein Konto belegt also höchstens zwei Verbindungen (ein Job + IDLE) – deutlich unter den üblichen Provider-Grenzen (z. B. Gmail 15 je Konto).
- **Sync-Rate:** Die periodische Synchronisation läuft je Konto höchstens alle `SYNC_INTERVAL_SECONDS` (Standard 120 s), und es gibt nie mehr als einen wartenden Sync je Konto bzw. Ordner. IDLE-Ereignisse (jede neue Mail, jede Flag-Änderung) lösen höchstens alle `SYNC_MIN_INTERVAL_SECONDS` (Standard 10 s, 0 = aus) je Ordner einen Sync aus: Der Job wird sofort angelegt, aber frühestens so lange nach dem Start des letzten abgeschlossenen Syncs dieses Ordners ausgeführt.
- **Provider-Drosselung:** Antwortet der Provider mit `[LIMIT]`, `[THROTTLED]` oder einem Text wie „too many (simultaneous) connections“ / „rate limit“ / „try again later“, wird das als Code `RATE_LIMITED` klassifiziert und bekommt denselben exponentiellen Konto-Backoff wie ein nicht erreichbarer Server (1 min, verdoppelnd bis 1 h) – keine Fehlerspirale. Das wird **vor** Auth-Fehlern geprüft, weil manche Provider (Gmail) schon den Login wegen zu vieler Verbindungen ablehnen; das Konto landet dann nicht fälschlich auf `auth_error`. Der Provider-Text wird nur geprüft, nie geloggt oder gespeichert. IDLE-Verbindungen nutzen bei Drosselung ihren eigenen Reconnect-Backoff.
- **Speicher:** Rohmails über `MAX_RAW_MESSAGE_BYTES` (Standard 20 MB) werden nicht gespeichert (nur Kopfdaten und Vorschau); für den Versand gelten `MAX_ATTACHMENT_BYTES` und `MAX_ATTACHMENTS_TOTAL_BYTES`; parallele Uploads begrenzt php-fpm selbst. RAM-Richtwerte: [system-requirements.md](../operations/system-requirements.md). Den Speicherverbrauch pro Konto zeigen die Kontoeinstellungen (Roadmap 5.4, `GET /api/storage` bzw. `GET /api/accounts/:id/storage`): summiert aus DB-Spalten – `message.size_bytes` (Provider-Größe RFC822.SIZE) der Nachrichten mit gespeicherter Rohmail plus `attachment_upload.size_bytes` – in einem gruppierten Durchlauf, ohne das `mail-data`-Volume zu scannen. Die verschlüsselte Datei ist etwas größer, deshalb zeigt die UI „ca.“; die verschlüsselten Anzeige-Texte in der DB (`message_body.text_plain_enc`) zählen nicht mit. Nur Zahlen, keine Inhalte oder Dateinamen. Ein Gesamt-Speicherlimit pro Konto gibt es noch nicht.

## Deployment

- Docker Compose (ADR-0007, ADR-0013): `caddy` (TLS; `/api/*` per FastCGI an `php`, alles andere an `web`), `web` (statische PWA), `php` (php-fpm), `worker` (gleiches Image, `bin/worker.php`), `mariadb`; Volumes `mariadb-data`, `mail-data`, `caddy-data`, `caddy-config`. Anleitung: [installation.md](../operations/installation.md).
- Alternativ ohne Docker auf Webspace mit PHP und MySQL plus Cron: [installation-php.md](../operations/installation-php.md).
- Konfiguration über `.env` (erzeugt von `scripts/setup-env.sh`: Domain, `MASTER_KEY`, VAPID, DB-Passwort) bzw. `config.php`.
- Healthchecks für alle Services; Migrationen laufen beim Start des `php`-Containers (`bin/migrate.php`).

## Observability

- Strukturierte JSON-Logs mit zentraler Redaction (Passwörter, Tokens, Betreff, Adressen).
- Metriken: Sync-Latenz, Fehlerraten pro Konto, Länge der Job-Tabelle, Push-Erfolgsrate, Speicherverbrauch pro Konto.
- Diagnoseseite mit Konto- und Worker-Status.
