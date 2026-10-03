# Push-Strategie

## Grundsatz

Push ist ein **Hinweis**, nie die Quelle der Wahrheit. Die App synchronisiert immer beim Start und bei Fokuswechsel – sie muss auch ganz ohne Push korrekt funktionieren.

## Sync bei Start und Fokuswechsel (Roadmap 4.5)

Damit die App auch ganz ohne Push aktuell ist:

1. **Auslöser:** App-Start/Anmeldung, `visibilitychange` → sichtbar, `focus` und `online`. Fokus- und Sichtbarkeits-Ereignisse, die kurz hintereinander kommen, werden clientseitig gedrosselt (höchstens alle 15 s; Start immer).
2. **Sync anfordern:** `POST /api/sync` reiht für jedes Konto des Benutzers einen `folder_sync` ein (`POST /api/accounts/:id/sync` für ein einzelnes Konto). Es gelten dieselben Regeln wie beim Scheduler: kein Job für Konten mit `auth_error`, `disabled` oder offenem Circuit Breaker (`next_retry_at` in der Zukunft), kein zweiter Job, solange einer wartet oder läuft. Zusätzlich gilt pro Konto höchstens ein neuer `folder_sync` je 30 s (gemessen am letzten `folder_sync` in der Job-Tabelle, gilt also über Geräte und API-Instanzen hinweg; Einzelkonto-Endpoint antwortet dann mit 429 und `Retry-After`). Die Antwort nennt je Konto `queued` und ggf. den Grund (`pending`, `rate_limited`, `backoff`, `auth_error`, `disabled`).
3. **Ergebnis abholen:** `GET /api/accounts` liefert je Konto `syncing` (ein Sync-Job läuft oder ist abholbereit), `lastSyncAt` und den Ungelesen-Zähler. Nach einem Auslöser fragt der Client diese Liste alle 3 s ab, solange ein Konto `syncing` meldet, höchstens 2 min lang. Ohne Auslöser bleibt es bei der minütlichen Aktualisierung, solange die App sichtbar ist; im Hintergrund wird nicht gepollt.
4. **UI aktualisieren:** Ändern sich beim aktiven Konto `lastSyncAt`, das Ende von `syncing` oder der Ungelesen-Zähler, lädt die Mailansicht Ordner (Zähler) und die erste Seite der Nachrichtenliste neu und führt sie mit der angezeigten Liste zusammen. Bereits nachgeladene Seiten, Scrollposition, Auswahl und die geöffnete Nachricht bleiben erhalten; während einer optimistischen Aktion wird die Aktualisierung zurückgestellt.

Die Regeln (Drosselung, Polling-Fenster, Änderungserkennung, Zusammenführen der Liste) liegen testbar in `@fma/shared` (`foreground-sync.ts`) und gelten genauso für spätere native Clients (ADR-0010). Ein eigener „changes since“-Endpoint ist dafür nicht nötig.

## MVP: Web Push (Roadmap 4.3)

- Zielplattformen: installierte iOS-PWA (iOS/iPadOS ≥ 16.4, nur nach Hinzufügen zum Home-Bildschirm), Android-PWA, Desktop-Browser.
- **VAPID-Keypair** aus der Umgebung (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`; `scripts/setup-env.mjs` erzeugt sie). Der private Schlüssel ist ein Secret und liegt nur beim Worker; die API kennt nur den öffentlichen. Ohne Keys ist Push aus (Einstellungen zeigen das an), alles andere funktioniert. Neue Keys machen alle bestehenden Subscriptions ungültig.
- **Opt-in** nur nach expliziter Nutzeraktion: „Benachrichtigungen aktivieren“ in den Einstellungen ruft `Notification.requestPermission()` direkt im Klick-Handler auf (iOS verlangt eine User-Geste). In Safari auf iPhone/iPad ohne Installation zeigt die App stattdessen den Hinweis „Zum Home-Bildschirm“. Deaktivieren meldet die Subscription im Browser und auf dem Server ab.
- **API:** `GET /api/push/vapid-public-key`, `POST /api/push/subscriptions` (PushSubscription-JSON), `DELETE /api/push/subscriptions` (Body: `endpoint`, dieser Browser), `GET /api/push/subscriptions` und `DELETE /api/push/subscriptions/:id` (Geräteverwaltung; die Liste zeigt nur den Host des Push-Dienstes, nie den Endpoint).
- **Subscriptions** gehören zum Gerät der aktuellen Session und werden über den Endpoint upserted (derselbe Browser nach neuer Anmeldung → neues Gerät). Ein Endpoint eines anderen Benutzers wird abgelehnt (409). Der Endpoint muss eine `https`-URL auf einem öffentlichen Host sein (SSRF-Schutz `@fma/shared/ssrf`, beim Speichern und vor jedem Versand erneut). `p256dh`/`auth` liegen mit dem DEK des Benutzers verschlüsselt in `keys_enc`. Abmelden (letzte Session des Geräts) und Gerät widerrufen löschen die Subscriptions des Geräts; der Worker sendet ohnehin nur an Geräte mit gültiger Session.
- **Auslöser:** Legt ein inkrementeller `message_sync` neue, ungelesene Nachrichten im INBOX ab (nicht beim Initial-Sync, nicht nach UIDVALIDITY-Wechsel), reiht er einen `push_notify`-Job für den Benutzer ein – nur wenn es eine aktive Subscription gibt, höchstens einen wartenden Job je Benutzer und mit mindestens 30 s Abstand zum vorigen. Viele neue Mails über mehrere Konten ergeben so eine Benachrichtigung.
- **Versand:** `web-push` (VAPID, `aes128gcm`), `TTL` 15 min, `Urgency: normal`, ohne Redirects, mit Timeout. Das Badge wird beim Versand berechnet (Summe der ungelesenen INBOX-Nachrichten aller Konten).
- **Bereinigung:** HTTP 404/410 vom Push-Service → Subscription wird gelöscht. Andere Fehler zählen `failure_count` hoch, der Job wird mit Backoff wiederholt (doppelte Zustellung ist harmlos, siehe unten).
- **Logs:** Endpoints sind Capability-URLs und erscheinen nie im Log, nur Host des Push-Dienstes und ein kurzer Hash.

## Optionales Hosted Push Relay (Phase 8)

- Kostenpflichtige Komfortfunktion, z. B. für Instanzen ohne öffentliche Erreichbarkeit oder für einen späteren nativen iOS-Client mit APNs.
- Erhält nur die gleichen inhaltsfreien Payloads.
- **Direkter Web-Push-Versand aus der Self-hosted-Instanz bleibt dokumentiert und voll funktionsfähig.**

## Später: native iOS-App

APNs erfordert ein Apple-Developer-Konto und ein Zertifikat/Key des App-Herausgebers. Self-Hoster können das nicht ohne Weiteres selbst stellen – hier ist das Hosted Push Relay der naheliegende Weg. Die Subscription-Tabelle sollte deshalb von Anfang an einen `transport` (z. B. `webpush`, `apns`) kennen.

## Externe Abhängigkeiten

Apple Web Push, Google FCM (Chrome), Mozilla Autopush – Verhalten und Limits ändern sich; siehe [`../process/external-dependencies.md`](../process/external-dependencies.md).
