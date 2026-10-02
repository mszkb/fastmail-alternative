# Push-Strategie

## Grundsatz

Push ist ein **Hinweis**, nie die Quelle der Wahrheit. Die App synchronisiert immer beim Start und bei Fokuswechsel – sie muss auch ganz ohne Push korrekt funktionieren.

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
