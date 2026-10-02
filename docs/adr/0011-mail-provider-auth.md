# ADR-0011: Anmeldung an Mailanbietern

- **Status:** Accepted
- **Datum:** 2026-10-02
- **Roadmap:** 2.1, 2.10 (vorher 6.3)

## Kontext

Der Produktowner nutzt **Gmail, Outlook, Fastmail und einen eigenen IMAP/SMTP-Server**. Microsoft erlaubt bei Outlook.com/365 kein IMAP mit Passwort mehr, nur noch OAuth2 (XOAUTH2). Gmail erlaubt App-Passwörter (mit 2FA) oder OAuth2. OAuth stand ursprünglich erst in Phase 6.

## Optionen

1. **Nur Passwort/App-Passwort im MVP**, OAuth später: Outlook wäre im MVP nicht nutzbar.
2. **OAuth2 für Microsoft und Google im MVP**, zusätzlich Passwort/App-Passwort.

## Entscheidung

**Option 2. OAuth2 kommt ins MVP** (neue Aufgabe 2.10):

| Anbieter                         | Anmeldung                                          |
| -------------------------------- | -------------------------------------------------- |
| Outlook / Microsoft 365          | OAuth2 (Pflicht)                                   |
| Gmail                            | OAuth2 **oder** App-Passwort, wählbar beim Anlegen |
| Fastmail, eigener Server, andere | Passwort / App-Passwort                            |

- **Jeder Self-Hoster registriert eine eigene OAuth-App** (Azure App Registration bzw. Google-Cloud-Projekt) und trägt Client-ID und Secret in `.env` ein. Es gibt keine zentrale App des Projekts, damit kein Dienst des Projekts zwischen Instanz und Provider steht (Self-hosted first).
- Access- und Refresh-Tokens liegen verschlüsselt wie Passwörter vor (`credential_enc`). Der Worker erneuert Tokens automatisch.
- Schlägt die Token-Erneuerung fehl, wechselt das Konto in den Status `auth_error` und die UI fordert zur Neuanmeldung auf. Andere Konten sind davon nicht betroffen.

## Konsequenzen

- **Gmail-OAuth ohne Google-Verifizierung** läuft im Testmodus: Refresh-Tokens laufen nach **7 Tagen** ab. Deshalb gibt es das App-Passwort als Alternative, und die Doku erklärt beides.
- Die Betreiber-Doku braucht eine Schritt-für-Schritt-Anleitung für die Azure- und Google-Registrierung (7.1, früher als bisher nötig).
- Der Zeitplan für Phase 2 wächst um etwa eine Woche (Aufwand L).
- Das Datenmodell bekommt das Feld `oauth_provider` (`microsoft | google | null`).
