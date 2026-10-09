# ADR-0015: Mobile-Clients mit Kotlin Multiplatform + Compose Multiplatform

- **Status:** Accepted
- **Datum:** 2026-10-09
- **Roadmap:** Phase 9 (Epic #136, #137)

## Kontext

ADR-0010 sieht native Clients pro Plattform „in der jeweils besten Technologie“ vor. Neu gilt: Zwischen iOS und Android soll **möglichst viel Code geteilt** werden. Push ist Pflicht, und die App soll möglichst alle Funktionen der Web-App bekommen. Weiter gelten die Prinzipien aus `CLAUDE.md`: keine Mailinhalte in Push oder Logs, Inhalte auf dem Gerät nur verschlüsselt, Konten getrennt, Self-hosted first.

## Optionen

1. **Capacitor + Nuxt (die PWA als Hülle):**
   - Vorteil: am meisten geteilter Code, auch mit dem Web.
   - Nachteil: native Einbindung (Push, Hintergrund, Teilen) nur über Plugins.
   - Nachteil: Die Web-Oberfläche fühlt sich auf dem Telefon nicht nativ an. Genau das wollte ADR-0010 vermeiden.
2. **React Native:**
   - Vorteil: eine Codebasis für iOS und Android.
   - Nachteil: ein zweiter JavaScript-Stack neben der PWA, aber ohne Laufzeitcode, der sich sinnvoll teilen ließe.
   - Nachteil: native Module trotzdem pro Plattform.
3. **Kotlin Multiplatform (KMP) mit nativer UI (SwiftUI/Compose):**
   - Vorteil: Logik geteilt, UI jeweils ideal.
   - Nachteil: Die UI entsteht doppelt, Feature-Parität kostet den doppelten Aufwand.
4. **KMP + Compose Multiplatform:**
   - Logik **und** UI in einer Kotlin-Codebasis.
   - Plattformspezifisches wird über `expect`/`actual` bzw. eine schmale Schnittstelle gelöst (Push, Keystore/Keychain, WebView, Teilen).

## Entscheidung

**Option 4: Kotlin Multiplatform + Compose Multiplatform** in `apps/mobile`, als Gradle-Projekt im Monorepo.

- **Module:**
  - `shared`: API-Client, DTOs, Domänenregeln.
  - `composeApp`: Oberfläche und ViewModel, gemeinsame `Platform`-Schnittstelle.
  - `androidApp`: Einstieg, FCM, WorkManager, Keystore, WebView.
  - Später `iosApp` (Swift-Einstieg).
- **Paketname:** `net.fma.mail`. Android minSdk 26, targetSdk aktuell.
- **Mit der PWA teilt die App keinen Laufzeitcode.** Gleiche Logik und gleiches Design entstehen über diese Wege:
  - die Logik auf dem Server (ADR-0010);
  - den API-Vertrag `docs/api/openapi.yaml`. Der Kotlin-Client ist vorerst handgeschrieben, weil der Generator die OpenAPI-3.1-Spec nicht sauber umsetzt (#143). Ein Smoke-Test gegen die echte PHP-API in CI prüft ihn;
  - Design-Tokens in `packages/design-tokens`, aus denen das Compose-Theme erzeugt wird. Ein Test prüft, dass sie zu den daisyUI-Themes passen (#141);
  - später gemeinsame Test-Fixtures für Domänenlogik (#144).
- **Anmeldung:** gerätegebundenes Bearer-Token (ADR-0004, #138).
- **Push:** Transporte `fcm` (umgesetzt, #139), `apns` und `relay` (geplant) zusätzlich zu `webpush` (ergänzt ADR-0005). Der Payload enthält weiterhin nur Ereignistyp, Installations-ID und Badge.
- **Vertrieb:** App Store und Google Play. Bis dahin gibt es Sideload-APKs aus CI (`mobile-android`).

## Konsequenzen

- **Einfacher:**
  - Eine Codebasis für zwei Plattformen.
  - Neue Funktionen kommen auf iOS und Android gleichzeitig.
  - Eine UI-Testsuite (Compose-Tests gegen einen simulierten Server) deckt beide ab.
- **Schwieriger:**
  - Ein zweiter Technologie-Stack (Kotlin/Gradle) neben PHP und TypeScript.
  - Android-Builds brauchen das Android-SDK, iOS-Builds einen macOS-Runner.
  - Compose Multiplatform auf iOS ist jünger als SwiftUI.
- **Folgeaufgaben:**
  - Verschlüsselter Offline-Cache (#145).
  - iOS-Target in CI und APNs (#155).
  - Store-Releases (#157, #160).
  - Generierter API-Client, sobald die Spec es zulässt (#143).
- ADR-0010 bleibt als Leitlinie gültig (Logik auf dem Server, gleiches Design). Nur „pro Plattform in der jeweils besten Technologie“ ersetzt diese ADR.
