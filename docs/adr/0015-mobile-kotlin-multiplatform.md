# ADR-0015: Mobile-Clients mit Kotlin Multiplatform + Compose Multiplatform

- **Status:** Accepted (Owner-Entscheidung 2026-10-09, Epic #136)
- **Datum:** 2026-10-24
- **Roadmap:** Phase 9 – Native Apps (#136, #137); ersetzt teilweise [ADR-0010](0010-client-strategy.md), ergänzt [ADR-0005](0005-push.md)

## Kontext

[ADR-0010](0010-client-strategy.md) sieht native Clients pro Plattform „in der jeweils besten Technologie“ vor, also getrennte Codebasen für iOS und Android. Für die Native-Apps-Epic (#136) gelten neue Vorgaben des Owners:

- **Maximales Code-Sharing zwischen iOS und Android.** Ziel sind etwa 85–90 % geteilter Code, Logik und UI.
- **Push ist Pflicht** auf beiden Plattformen.
- **Möglichst volle Feature-Parität mit der Web-App** (Feature-Matrix, #154).
- iOS zuerst, danach Android. Vertrieb über App Store und Google Play.

Unverändert gilt: Die Logik liegt auf dem Server, die Clients bleiben dünn (ADR-0010), und alle Prinzipien aus `CLAUDE.md` gelten auch auf dem Gerät. Dazu gehören keine Mailinhalte in Push-Payloads, verschlüsselte Inhalte at rest, keine sensiblen Daten in Logs oder Crash-Reports und getrennte Konten.

## Optionen

1. **Capacitor + bestehende Nuxt-PWA** – Vorteil: ein Code für Web und Apps, schnellster Start. Nachteile: Die UI bleibt eine Web-UI und fühlt sich auf iOS nicht nativ an. Push, Hintergrund-Sync, Share-Sheet und Keychain laufen über Plugins. Bei großen Postfächern und Listen-Scrolling setzt die WebView die Grenze.
2. **React Native** – Vorteil: eine Codebasis für iOS und Android, TypeScript wie die PWA. Nachteile: Die geteilte Domänenlogik der PWA ist nicht direkt nutzbar, sie hängt an Browser-APIs wie IndexedDB und Service Worker. Dazu kommen eine zweite UI-Welt neben Vue und eine lange Abhängigkeitskette mit Bridge, Metro und nativen Modulen.
3. **Kotlin Multiplatform + SwiftUI/Jetpack Compose** – Vorteil: geteilte Logik in Kotlin, die UI pro Plattform voll nativ. Nachteil: zwei UI-Codebasen. Das verfehlt das Ziel „maximales Code-Sharing“, und die UI ist der größte Teil der App.
4. **Kotlin Multiplatform + Compose Multiplatform** – Vorteil: Logik **und** UI in einer Kotlin-Codebasis für iOS und Android; Plattform-APIs über `expect`/`actual` oder dünne native Schichten; auf Android ganz nativ, auf iOS mit nativer Performance (kein WebView). Nachteile: Compose auf iOS ist jünger als SwiftUI, einzelne iOS-Konventionen (Navigation, Textauswahl, Barrierefreiheit) brauchen Nacharbeit. Außerdem kommt eine zweite Sprache neben TypeScript und PHP ins Projekt.

## Entscheidung

**Option 4: Kotlin Multiplatform + Compose Multiplatform.**

- **Eine Kotlin-Codebasis** für Domänenlogik, Offline-Cache, Offline-Queue und UI auf iOS und Android.
- **Plattformspezifisch** über `expect`/`actual` bzw. dünne native Schichten: Push (APNs/FCM), Keychain/Keystore, Share-Sheet/Intents, Biometrie, Hintergrundaufgaben, App-Badge.
- **Kein Laufzeitcode mit der PWA geteilt** (TypeScript vs. Kotlin). Damit Web und Apps trotzdem gleich bleiben, werden geteilt:
  - der **API-Vertrag** `docs/api/openapi.yaml`, aus dem der Kotlin-Client generiert wird (#143),
  - **Design-Tokens** als plattformneutrales JSON, daraus generiert CSS und ein Compose-Theme (#141),
  - **gemeinsame Test-Fixtures** (JSON-Ein-/Ausgabepaare), gegen die `@fma/shared` (Vitest) und das KMP-Modul getestet werden (#144),
  - die **Logik auf dem Server** (ADR-0010).
- **Ablage:** `apps/mobile`, ein Gradle-Projekt im Monorepo (#142). Es gehört nicht zum pnpm-Workspace.
- **Anmeldung:** gerätegebundene Bearer-Tokens in derselben Geräte-/Session-Tabelle wie die PWA (ADR-0004, #138).
- **Push-Transporte** (ergänzt ADR-0005): neben `webpush` zusätzlich `apns` und `fcm`, direkt mit eigenen Keys aus `.env` für Self-Builder (#139), sowie `relay` über das optionale, inhaltsfreie Hosted Push Relay (#66, #140) für die Store-Apps. Die Payload bleibt `{type, installationId, badge}` (Prinzip 4).
- **Vertrieb:** App Store (#157) und Google Play (#160).

## Konsequenzen

- **Einfacher:** Features werden einmal gebaut und auf beiden Plattformen abgenommen (zuerst iOS). Android kostet danach im Wesentlichen nur Push, Plattform-Integration und Store-Release.
- **Schwieriger:** Eine dritte Sprache (Kotlin) und eine dritte Toolchain (Gradle, Xcode für das iOS-Framework) kommen ins Repo; CI braucht einen macOS-Runner für den iOS-Build. Domänenlogik existiert zweimal (TypeScript und Kotlin), die gemeinsamen Fixtures sind deshalb Pflicht.
- **Self-hosted first bleibt gültig:** Die App muss mit jeder eigenen Instanz funktionieren. Das Relay ist Komfort für die Store-Apps, kein Muss für den Server.
- **Push bleibt ein Hinweis:** Die App synchronisiert beim Start und bei Rückkehr in den Vordergrund (Prinzip 3).
- ADR-0010 bleibt für die Grundsätze gültig (Logik auf dem Server, OpenAPI, Design-Tokens, offline-first). Ersetzt ist nur „native Clients pro Plattform in der jeweils besten Technologie“ für iOS und Android. Desktop bleibt offen.
- Folgeaufgaben: Phase 9 in `ROADMAP.md` mit den Sub-Issues von #136; Tech-Stack in `CLAUDE.md`.
