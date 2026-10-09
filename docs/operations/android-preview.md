# Android-Vorschau ausprobieren

Anleitung für den Product Owner: Server aktualisieren, APK installieren, Login und Push testen. Stand: Vorschau aus Epic #136, nicht für den Alltag gedacht (siehe [Bekannte Einschränkungen](#bekannte-einschränkungen)).

Die App braucht eine Instanz, die per **HTTPS** mit gültigem Zertifikat erreichbar ist (`DOMAIN=<deine-domain>` in der `.env`, Caddy holt das Zertifikat). Mit `DOMAIN=:80` (nur HTTP im LAN) lässt die App keine Anmeldung zu.

## 1. Server auf dem Raspberry Pi aktualisieren

```sh
ssh raspberrypi
cd ~/fastmail-alternative
```

### 1.1 Branch auschecken, Images bauen, starten

Das Upgrade-Skript macht vorher ein Backup, wechselt auf den Branch, baut die Images und startet alles. Die neue Migration `0006_native_client` läuft beim Start des `php`-Containers automatisch.

```sh
./scripts/upgrade.sh claude/affectionate-cray-xyojni
```

Ohne Skript, von Hand:

```sh
git fetch origin
git checkout claude/affectionate-cray-xyojni
git pull --ff-only
docker compose build
docker compose up -d --wait
docker compose logs --tail=50 php worker   # auf "migration failed" prüfen
```

Prüfen: `curl -s https://<deine-domain>/api/health` liefert `"status":"ok"`.

Zurück auf `main` geht später mit `./scripts/upgrade.sh main` – die Migration ist abwärtskompatibel (nur eine neue Spalte mit Standardwert). Ein Downgrade auf einen Stand **vor** dieser Migration verweigert der Server allerdings („Schema zu neu“); dann gilt der [Rollback](upgrade.md#rollback) mit Backup.

### 1.2 Push über Firebase Cloud Messaging einrichten (optional, empfohlen)

Ohne diesen Schritt funktioniert die App auch, fragt dann aber nur alle 15 Minuten nach neuen Mails (Notlösung, siehe unten).

1. In der [Firebase-Konsole](https://console.firebase.google.com/) ein Projekt anlegen (Analytics kann aus bleiben).
2. **Android-App hinzufügen** mit dem Paketnamen `net.fma.mail`. Die angebotene `google-services.json` herunterladen.
3. Unter _Projekteinstellungen → Dienstkonten_ einen **neuen privaten Schlüssel** erzeugen (JSON-Datei). Das ist ein Secret: nicht ins Repo, nicht in Chats.
4. Die Projekt-ID steht unter _Projekteinstellungen → Allgemein_.
5. Auf dem Pi in die `.env` eintragen:

   ```sh
   # Datei vorher per scp auf den Pi kopieren, danach löschen
   echo "FCM_PROJECT_ID=<projekt-id>" >> .env
   echo "FCM_SERVICE_ACCOUNT_JSON=$(base64 -w0 ~/fma-service-account.json)" >> .env
   rm ~/fma-service-account.json
   chmod 600 .env
   docker compose up -d --wait
   ```

   `FCM_PROJECT_ID` bekommen `php` und `worker`, den Schlüssel nur der `worker`.

6. Die `google-services.json` für den App-Build als GitHub-Secret hinterlegen (Repository → _Settings → Secrets and variables → Actions_):

   - `GOOGLE_SERVICES_JSON_B64` = Ausgabe von `base64 -w0 google-services.json`

   Danach den Workflow **mobile-android** neu starten (_Actions → mobile-android → Run workflow_ auf dem Branch). Erst dieses APK enthält FCM.

Optional, damit spätere APKs sich über die vorige Version installieren lassen (sonst muss die App vor jedem Update deinstalliert werden):

```sh
keytool -genkeypair -v -keystore debug.keystore -storepass android -alias androiddebugkey \
  -keypass android -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Android Debug,O=Android,C=US"
base64 -w0 debug.keystore   # als Secret ANDROID_DEBUG_KEYSTORE_B64 hinterlegen
```

## 2. APK laden und installieren

1. Auf GitHub: _Actions → mobile-android_ → den neuesten grünen Lauf auf dem Branch öffnen → unten unter _Artifacts_ **fma-android-debug** herunterladen (ZIP, darin `androidApp-debug.apk`).
2. Die APK aufs Handy bringen (z. B. per USB, Cloud-Speicher oder `adb install androidApp-debug.apk`).
3. Am Handy die APK antippen. Android fragt nach der Erlaubnis, **Apps aus unbekannten Quellen** zu installieren (für den Browser bzw. Dateimanager, mit dem die Datei geöffnet wurde) – erlauben, installieren.
4. Play Protect kann warnen („unbekannte App“) – „Trotzdem installieren“.

Voraussetzung: Android 8.0 (API 26) oder neuer.

## 3. Login und Push testen

1. App **FMA Mail** öffnen, Adresse der Instanz eingeben (z. B. `mail.example.org`, `https://` ergänzt die App), **Weiter**. Die App prüft `/api/health`.
2. E-Mail-Adresse und Passwort der Instanz eingeben, **Anmelden**.
3. Android 13+ fragt nach **Benachrichtigungen** – erlauben.
4. Unter **Einstellungen** (Zahnrad) steht der Push-Status:
   - „Push über Firebase Cloud Messaging aktiv.“ – alles bereit;
   - „… Notlösung aktiv: Abfrage alle 15 Minuten.“ – App ohne Firebase gebaut oder Server ohne FCM.
   - Unter **Geräte** erscheint das Handy; in der Web-App unter _Einstellungen → Geräte_ ebenfalls, dort lässt es sich auch abmelden.
5. **Schneller Push-Test:** In den Einstellungen **Test-Benachrichtigung senden** tippen und die App sofort in den Hintergrund schicken. Nach dem nächsten Lauf des Servers erscheint „Neue E-Mail“. Damit ist die Kette Server → FCM → Handy geprüft, ohne dass eine Mail nötig ist. Bei offener App gibt es absichtlich keine Benachrichtigung, sie aktualisiert dann nur die Liste.
6. **Push-Test mit echter Mail:** App in den Hintergrund schicken (Home-Taste) und von einer anderen Adresse eine Testmail an eines der verbundenen Konten senden. Nach dem nächsten Sync des Servers (mit IMAP IDLE wenige Sekunden, sonst bis `SYNC_INTERVAL_SECONDS`) erscheint die Benachrichtigung **„Neue E-Mail“** – absichtlich ohne Absender und Betreff. Antippen öffnet den Posteingang und synchronisiert.
7. Zum Prüfen auf dem Pi: `docker compose logs --tail=50 worker | grep push_notify` zeigt `sent`/`removed`/`failed` (ohne Tokens oder Inhalte).

Mit der Notlösung kommt die Benachrichtigung erst beim nächsten Abfragezeitpunkt (alle ~15 Minuten, Android kann das im Energiesparmodus weiter verzögern).

## Was die Vorschau kann

- Instanz verbinden (nur HTTPS), Anmelden, Abmelden; das Geräte-Token liegt verschlüsselt im Android-Keystore
- Konten wechseln (Konten bleiben getrennt), Ungelesen-Zahlen, Fehlerhinweis pro Konto, Fortschrittsbalken während des Syncs; „Alle Konten“ nur, wenn der gemeinsame Posteingang in der Web-App eingeschaltet ist (Antworten gehen immer aus dem Ursprungskonto)
- Ordner, Nachrichtenliste mit Nachladen beim Scrollen, Ziehen zum Aktualisieren, Sync beim Start und bei Rückkehr in die App
- Nachricht lesen (bereinigtes HTML ohne JavaScript, externe Bilder erst auf Knopfdruck, Links öffnen im Browser, Dunkelmodus), Verlauf (Thread) aufklappbar
- Anhänge öffnen: die Datei wird direkt an die passende App gestreamt und nicht in der App gespeichert
- Gelesen/ungelesen, markieren, archivieren, löschen, verschieben, als Spam markieren; Wischen in der Liste: nach links = archivieren, nach rechts = gelesen/ungelesen
- Suche im aktiven Konto (beim Mailanbieter per IMAP `SEARCH`)
- „Ältere Nachrichten vom Server laden“ am Ende eines Ordners
- Neue Mail, Antworten, Allen antworten, Weiterleiten mit Absenderauswahl (nur Text, ohne eigene Anhänge)
- Push über FCM, sonst Abfrage alle 15 Minuten; ist die App offen, aktualisiert ein Push nur die Liste
- Andere Geräte in den Einstellungen abmelden

## Bekannte Einschränkungen

- Kein Offline-Cache: Mails werden nur im Speicher gehalten (#145). Ohne Netz zeigt die App nichts an.
- Keine Anhänge senden (auch beim Weiterleiten nicht), keine Entwürfe, kein Rückgängig.
- Konten, Identitäten und Geräte-Widerruf nur in der Web-App.
- Debug-Build: ohne `ANDROID_DEBUG_KEYSTORE_B64` muss die App vor einem Update deinstalliert werden.
- Dunkelmodus für Mailinhalte per Farbumkehr: bei aufwendig gestalteten Mails können Farben ungewohnt wirken.
