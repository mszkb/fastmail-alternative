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

## MVP: Web Push

- Zielplattformen: installierte iOS-PWA (iOS/iPadOS ≥ 16.4, nur nach Hinzufügen zum Home-Bildschirm), Android-PWA, Desktop-Browser.
- Server erzeugt bei der Initialisierung ein **VAPID-Keypair** oder erhält es über Konfiguration. Der private Schlüssel wird wie andere Secrets behandelt.
- Push-Subscriptions werden pro Gerät persistent gespeichert.
- Abgelaufene/ungültige Endpoints (HTTP 404/410 vom Push-Service) werden automatisch bereinigt.
- Opt-in nur nach expliziter Nutzeraktion (iOS verlangt eine User-Geste).

## Payload

Erlaubt:

```json
{ "type": "new_mail", "installationId": "…", "badge": 7 }
```

**Nicht erlaubt:** Betreffzeilen, Absender, Mailinhalte, Kontonamen, E-Mail-Adressen.

Der Service Worker zeigt eine generische Benachrichtigung („Neue Nachricht") und aktualisiert das Badge. Details lädt die App nach dem Öffnen über die API.

## Optionales Hosted Push Relay (Phase 8)

- Kostenpflichtige Komfortfunktion, z. B. für Instanzen ohne öffentliche Erreichbarkeit oder für einen späteren nativen iOS-Client mit APNs.
- Erhält nur die gleichen inhaltsfreien Payloads.
- **Direkter Web-Push-Versand aus der Self-hosted-Instanz bleibt dokumentiert und voll funktionsfähig.**

## Später: native iOS-App

APNs erfordert ein Apple-Developer-Konto und ein Zertifikat/Key des App-Herausgebers. Self-Hoster können das nicht ohne Weiteres selbst stellen – hier ist das Hosted Push Relay der naheliegende Weg. Die Subscription-Tabelle sollte deshalb von Anfang an einen `transport` (z. B. `webpush`, `apns`) kennen.

## Externe Abhängigkeiten

Apple Web Push, Google FCM (Chrome), Mozilla Autopush – Verhalten und Limits ändern sich; siehe [`../process/external-dependencies.md`](../process/external-dependencies.md).
