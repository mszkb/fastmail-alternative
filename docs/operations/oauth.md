# Anmeldung mit Google und Microsoft (OAuth2)

Microsoft (Outlook.com, Microsoft 365) lässt IMAP und SMTP nur noch mit OAuth2 zu. Gmail geht mit OAuth2 oder einem App-Passwort ([ADR-0011](../adr/0011-mail-provider-auth.md), #36). Diese Anleitung richtet die Anmeldung für eine eigene Instanz ein.

**Jede Instanz registriert eine eigene OAuth-App** beim Anbieter. Es gibt keine zentrale App des Projekts; zwischen Instanz und Anbieter steht kein fremder Dienst. Ohne Einrichtung bleibt alles wie bisher: Der Button „Mit … anmelden“ erscheint nicht, Gmail funktioniert weiter mit App-Passwort, Microsoft-Konten lassen sich nicht verbinden.

## Voraussetzungen

- Die Instanz ist unter einer **HTTPS-Adresse** erreichbar, die der Browser des Nutzers aufrufen kann. Öffentlich muss sie nicht sein (siehe unten). Die Anbieter leiten den Browser nach der Anmeldung dorthin zurück; Google akzeptiert ohne HTTPS nur `localhost`.
- Diese Adresse kennt das Backend:
  - aus `DOMAIN` (z. B. `mail.example.org` → `https://mail.example.org`), oder
  - aus `PUBLIC_URL`, wenn `DOMAIN=:80` hinter einem eigenen TLS-Proxy läuft oder die Instanz unter einem Pfad liegt.
- Die **Redirect-URI** für die Registrierung ist `<Adresse der Instanz>/api/oauth/callback`, also z. B. `https://mail.example.org/api/oauth/callback`. Die Einstellungsseite der App zeigt sie nicht an; `GET /api/oauth/providers` liefert sie (`redirectUri`).

Ein Raspberry Pi nur im Heimnetz ohne öffentliche Adresse genügt: Die Redirect-URI wird nur vom Browser aufgerufen, nicht vom Anbieter. Sie muss aber exakt so in der Registrierung stehen wie im Browser.

## Google (Gmail, Google Workspace)

1. In der [Google Cloud Console](https://console.cloud.google.com/) ein Projekt anlegen.
2. **Google Auth Platform → Branding/Zielgruppe** (früher „OAuth-Zustimmungsbildschirm“):
   - Nutzertyp **Extern** (privates Gmail) oder **Intern** (nur Konten der eigenen Workspace-Organisation).
   - App-Name frei wählbar, Support-Adresse eintragen.
   - Bei **Extern** im Status **Testen** bleiben und unter „Testnutzer“ alle Gmail-Adressen eintragen, die verbunden werden sollen.
3. **Datenzugriff → Bereiche hinzufügen:** `https://mail.google.com/` (voller IMAP/SMTP-Zugriff), dazu `openid` und `email`.
4. **Clients → Client erstellen:**
   - Typ **Webanwendung**.
   - Unter „Autorisierte Weiterleitungs-URIs“ die Redirect-URI von oben eintragen.
5. Client-ID und Clientschlüssel in die `.env` übernehmen (siehe [unten](#konfiguration)).
6. In Gmail muss **IMAP aktiviert** sein (Gmail → Einstellungen → „Weiterleitung & POP/IMAP“).

> **Wichtig, Testmodus:** Google lässt Refresh-Tokens externer Apps im Status „Testen“ nach **7 Tagen** ablaufen. Das Konto zeigt dann „Neu anmelden“; ein Klick genügt. Eine Veröffentlichung der App verlangt für `https://mail.google.com/` eine Sicherheitsprüfung durch Google und ist für eine private Instanz nicht sinnvoll. Wer die wöchentliche Neuanmeldung vermeiden will, nimmt für Gmail ein **App-Passwort**. Bei Workspace mit Nutzertyp **Intern** gilt die 7-Tage-Grenze nicht.

## Microsoft (Outlook.com, Hotmail, Microsoft 365)

1. Im [Microsoft Entra Admin Center](https://entra.microsoft.com/) unter **App-Registrierungen → Neue Registrierung**:
   - Unterstützte Kontotypen: „Konten in einem beliebigen Organisationsverzeichnis und persönliche Microsoft-Konten“ (für Outlook.com und Microsoft 365). Nur das eigene Microsoft 365: „Nur Konten in diesem Organisationsverzeichnis“ und `OAUTH_MICROSOFT_TENANT` auf die Mandanten-ID setzen.
   - Umleitungs-URI: Plattform **Web**, Redirect-URI von oben.
2. **Zertifikate & Geheimnisse → Neuer geheimer Clientschlüssel.** Den **Wert** (nicht die Geheimnis-ID) in die `.env` übernehmen. Das Ablaufdatum notieren, siehe [Fehlerbilder](#fehlerbilder).
3. **API-Berechtigungen → Berechtigung hinzufügen → Microsoft Graph → Delegierte Berechtigungen:**
   - `IMAP.AccessAsUser.All`, `SMTP.Send`;
   - `offline_access`, `openid`, `email`.

   In Organisationen ggf. „Administratorzustimmung erteilen“.

4. Die **Anwendungs-ID (Client)** aus der Übersicht ist `OAUTH_MICROSOFT_CLIENT_ID`.
5. **Microsoft 365:** Für das Postfach müssen IMAP und „Authentifiziertes SMTP“ eingeschaltet sein (Microsoft 365 Admin Center → Benutzer → E-Mail → E-Mail-Apps verwalten). Bei Outlook.com ist beides an.

## Konfiguration

In der `.env` (Docker) bzw. `config.php` (Webspace):

```dotenv
# nur nötig, wenn DOMAIN die öffentliche Adresse nicht ergibt
#PUBLIC_URL=https://mail.example.org
OAUTH_GOOGLE_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
OAUTH_GOOGLE_CLIENT_SECRET=GOCSPX-...
OAUTH_MICROSOFT_CLIENT_ID=00000000-0000-0000-0000-000000000000
OAUTH_MICROSOFT_CLIENT_SECRET=...
# common (Standard), consumers, organizations oder eine Mandanten-ID
OAUTH_MICROSOFT_TENANT=common
```

Danach `docker compose up -d`. Einzelne Anbieter lassen sich weglassen; ein Anbieter ist aktiv, sobald Client-ID **und** Secret gesetzt sind. Die Secrets gehören wie der `MASTER_KEY` nicht ins Repo und nicht in Support-Anfragen.

## Bedienung

- **Konto hinzufügen:**
  - Gmail: Die Vorlage „Gmail / Google Workspace“ (oder eine `@gmail.com`-Adresse) zeigt „Mit Google anmelden“; darunter bleibt der Weg mit App-Passwort.
  - Microsoft: Die Vorlage „Microsoft 365 / Outlook.com“ zeigt nur „Mit Microsoft anmelden“.
  - Nach der Anmeldung beim Anbieter testet der Server IMAP und SMTP und legt das Konto an. Es wird zunächst alles synchronisiert; der Zeitraum lässt sich danach unter „Bearbeiten“ einschränken.
- **Neu anmelden:** Ist die Anmeldung abgelaufen oder widerrufen, zeigt nur dieses Konto „Neu anmelden“. Andere Konten laufen weiter. Der Button steht beim Konto in den Einstellungen und im Hinweis über der Nachrichtenliste. Die Anmeldung muss mit derselben Adresse erfolgen.
- Server und Ports eines OAuth-Kontos sind fest; sie lassen sich nicht bearbeiten.
- **Export/Import der Konfiguration:** OAuth-Konten werden mit Anbieter exportiert, aber ohne Tokens. Nach dem Import warten sie auf „Neu anmelden“.

## Sicherheit

- Ablauf: Authorization Code mit **PKCE** (S256).
- Der `state` ist zufällig, einmal verwendbar und 10 Minuten gültig. In der Tabelle `oauth_state` steht nur sein SHA-256-Hash. Der PKCE-Verifier wird per HMAC aus `state` und `MASTER_KEY` abgeleitet und nicht gespeichert.
- Der Rücksprung vom Anbieter kommt ohne Session-Cookie an (`SameSite=Strict`). Der `state` ordnet ihn dem Nutzer zu, der die Anmeldung gestartet hat.
- Access- und Refresh-Token liegen nur verschlüsselt in `credential_enc` (wie Passwörter). Sie erscheinen nicht in Logs, Fehlermeldungen oder Backups im Klartext. `oauth_state` ist nicht im Backup.
- Der Server erneuert Access-Tokens selbst, wenn ein Job (oder die Suche) das Konto lädt und der Token in weniger als 2 Minuten abläuft. Eine Zeilensperre verhindert doppelte Erneuerungen.

## Fehlerbilder

| Anzeige                                                                  | Ursache / Abhilfe                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kein Button „Mit … anmelden“                                             | Client-ID oder Secret fehlt, oder `docker compose up -d` wurde nicht ausgeführt.                                                                                                                                                       |
| Fehler beim Start: „öffentliche Adresse … nicht eingerichtet“            | `DOMAIN=:80` ohne `PUBLIC_URL`. `PUBLIC_URL` setzen.                                                                                                                                                                                   |
| Anbieter meldet `redirect_uri_mismatch` o. Ä.                            | Redirect-URI in der Registrierung weicht ab (Schema, Host, Pfad, abschließender Schrägstrich).                                                                                                                                         |
| „Anmeldung … abgelaufen oder schon verwendet“                            | Mehr als 10 Minuten beim Anbieter, oder Zurück-Taste im Browser. Erneut starten.                                                                                                                                                       |
| „keinen dauerhaften Zugriff erteilt“                                     | Kein Refresh-Token: Bei Microsoft fehlt `offline_access`. Bei Google ggf. unter myaccount.google.com → „Drittanbieter-Apps“ den Zugriff entfernen und neu anmelden.                                                                    |
| „Mail-Abruf (IMAP) fehlgeschlagen“                                       | Gmail: IMAP in den Gmail-Einstellungen aus. Microsoft 365: IMAP für das Postfach aus, oder Berechtigung `IMAP.AccessAsUser.All` fehlt.                                                                                                 |
| „Mail-Versand (SMTP) fehlgeschlagen“                                     | Microsoft 365: „Authentifiziertes SMTP“ für das Postfach aus, oder Berechtigung `SMTP.Send` fehlt.                                                                                                                                     |
| Gmail-Konto jede Woche „Neu anmelden“                                    | Testmodus der Google-App (siehe oben). App-Passwort verwenden oder Workspace-App „Intern“.                                                                                                                                             |
| Alle Konten eines Anbieters „Neu anmelden“ mit Hinweis auf den Betreiber | Der Anbieter lehnt die OAuth-App ab, meist ist der geheime Clientschlüssel abgelaufen (Microsoft: höchstens 24 Monate gültig). Neuen Schlüssel anlegen, in die `.env` eintragen, `docker compose up -d`, dann je Konto „Neu anmelden“. |
| „auf dem Server nicht (mehr) richtig eingerichtet“                       | Client-ID oder Secret fehlt in der `.env` oder wurde abgelehnt. Die Konten dieses Anbieters pausieren; nach der Korrektur je Konto „Neu anmelden“.                                                                                     |
