# apps/mobile – native Apps (Kotlin Multiplatform)

Epic #136. Logik und UI in Kotlin, geteilt zwischen Android und (später) iOS.

| Modul        | Inhalt                                                                                  |
| ------------ | --------------------------------------------------------------------------------------- |
| `shared`     | API-Client (Ktor, kotlinx.serialization), DTOs, Domänenregeln (Sync-Drossel, Antworten) |
| `composeApp` | Oberfläche mit Compose Multiplatform, ViewModel, `Platform`-Schnittstelle               |
| `androidApp` | Android-Einstieg: Activity, Keystore-Speicher, WebView, FCM, WorkManager                |

## Bauen

Voraussetzung: JDK 17+ und ein Android-SDK (`ANDROID_HOME` oder `local.properties` mit `sdk.dir`).

```sh
./gradlew :shared:jvmTest              # Tests der geteilten Logik (ohne Android-SDK nicht konfigurierbar)
./gradlew :androidApp:assembleDebug    # androidApp/build/outputs/apk/debug/androidApp-debug.apk
FMA_API_URL=http://127.0.0.1:3001 ./gradlew :shared:jvmTest --tests 'net.fma.mail.ApiSmokeTest'   # gegen pnpm dev:api
```

CI: `.github/workflows/mobile-android.yml` (APK als Artifact `fma-android-debug`, Emulator-Smoke-Test, Client gegen die PHP-API). Das iOS-Target wird nur auf macOS angelegt und ist noch nicht in CI.

## Push

Mit `androidApp/google-services.json` (nie committen; CI schreibt sie aus dem Secret `GOOGLE_SERVICES_JSON_B64`) wird FCM eingebaut, sonst fragt die App alle 15 Minuten ab. Server-Seite und Einrichtung: [`docs/operations/android-preview.md`](../../docs/operations/android-preview.md).

## Regeln

- Keine Mailinhalte in Benachrichtigungen oder Logs; Benachrichtigungen zeigen nur „Neue E-Mail“.
- Keine Mails auf dem Gerät speichern, solange der verschlüsselte Cache (#145) fehlt.
- Keine Telemetrie- oder Crash-SDKs (Firebase nur Messaging, Analytics aus).
