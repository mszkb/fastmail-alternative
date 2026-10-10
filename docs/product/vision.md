# Produktvision

## Produktziel

Eine moderne Multi-Account-Mail-Anwendung, die bestehende IMAP-/SMTP-Konten in einer Oberfläche zusammenführt: **getrennte Konten mit schnellem Kontowechsel** (wie bei Thunderbird), eine Unified Inbox nur als optionale, abschaltbare Ansicht.

- Muss **self-hosted** betrieben werden können.
- Optionale Managed Cloud und optionales Push-Relay sind Komfortfunktionen – sie dürfen **keine künstlichen Sperren** für die Self-hosted-Nutzung erzeugen.
- Startpunkt ist eine **PWA** mit iOS-Home-Screen-Unterstützung und Web Push.
- Eine **native iOS-App** ist das langfristige Ziel, aber keine Voraussetzung für das MVP.
- Die App soll **super einfach** sein – in der Einrichtung wie in der Bedienung, mit **minimalem Setup**.

### Minimales Setup

Vom leeren Server bis zur ersten Mail sollen nur wenige Schritte nötig sein:

- Installation mit einem Befehl (`docker compose up`) bzw. Hochladen auf Shared Hosting – keine zusätzlichen Dienste, die extra eingerichtet werden müssen.
- Sinnvolle Standardwerte statt Pflichtkonfiguration: Was sich automatisch erzeugen oder erkennen lässt (Schlüssel, Server-Einstellungen der Mailanbieter), wird automatisch erzeugt oder erkannt.
- Ein Mailkonto hinzufügen heißt im Normalfall: E-Mail-Adresse und Passwort eingeben bzw. per OAuth2 anmelden – fertig.
- Jede zusätzliche Einstellung, jeder zusätzliche Container und jeder zusätzliche Setup-Schritt muss sich rechtfertigen; im Zweifel wird er weggelassen.

### Motivation

Bestehende Self-hosted-Lösungen (z. B. Nextcloud Mail) bündeln zwar mehrere Konten, aber:

1. sehen nicht gut aus,
2. bieten zu wenig Einstellungsmöglichkeiten und Regeln,
3. sind langsam,
4. haben keine iOS-App mit Push-Benachrichtigungen.

Daraus folgen die Qualitätsziele: **Geschwindigkeit, gutes UI, konfigurierbare Regeln, zuverlässiger Push.**

## Zielgruppen

- Technik-affine Einzelanwender mit mehreren bestehenden Mailkonten (primär; eine Instanz = ein Benutzer).
- Self-Hoster, die **keinen** vollständigen öffentlichen Mailserver betreiben wollen.
- Kleine Teams mit Bedarf an einer zentralen, datensparsamen Mailoberfläche.

**Positionierung:** Ein Client für alle bestehenden Mailkonten – Konten bleiben getrennt, der Nutzer entscheidet über eine Sammelansicht – self-hostbar, exportierbar, mit iOS-fähiger PWA.

## Produktprinzipien

- **Self-hosted first:** Docker-Deployment, klare Konfiguration, Backups und Migrationen.
- **Privacy by design:** Mailinhalte bleiben standardmäßig auf dem eigenen Server und werden nicht an ein Push-Relay übertragen.
- **Keine künstliche Paywall** für PWA, Export, Grundfunktionen oder eigene Serverinstanz.
- **Push ist ein Hinweis**, niemals die Quelle der Wahrheit. Die App synchronisiert beim Start und bei Fokuswechsel.
- **Sensible Zugangsdaten und lesbare Mailinhalte** (Betreff, Adressen, Bodies) werden verschlüsselt gespeichert.
- **Konten bleiben getrennt.** Keine erzwungene Sammel-Inbox; eine Unified Inbox ist optional und standardmäßig aus.
- **So einfach wie möglich.** Erst die einfachste Lösung, die funktioniert; Komplexität nur bei echtem Bedarf.
- **Minimales Setup.** Installation und Kontoeinrichtung in wenigen Schritten, mit sinnvollen Standardwerten statt Pflichtkonfiguration.

## MVP-Funktionsumfang

- Benutzerkonto und Geräteverwaltung
- Mehrere IMAP-Konten anlegen, testen, bearbeiten, entfernen – inkl. OAuth2 für Outlook und Gmail
- Server speichert alle Mails vollständig und verschlüsselt (Initial-Sync-Zeitraum pro Konto wählbar)
- Offline-first: gelesene Mails und Aktionen funktionieren ohne Verbindung
- SMTP-Versand je Konto
- Getrennte Konten mit Kontowechsel (Standard, keine erzwungene Sammel-Inbox)
- Ordner, Flags, gelesen/ungelesen, Archivieren, Löschen, Verschieben
- Thread-Ansicht
- Antworten, Weiterleiten, neue Nachricht
- Entwürfe
- Anhänge anzeigen, herunterladen, versenden
- Grundlegende Suche (im MVP über IMAP `SEARCH` beim Provider, da Inhalte in der DB verschlüsselt sind)
- PWA-Installation und Web Push
- Export der Serverkonfiguration und Migrationsdokumentation
- Docker-Compose-Deployment mit Healthcheck und Datenbankmigrationen

## Bewusst nicht im MVP

- Mehrere Benutzer pro Instanz (Single-User; Datenmodell bleibt vorbereitet)
- 2FA (TOTP/Passkeys) für den Instanz-Login
- Eigener Suchindex (Suche über IMAP `SEARCH`)

- Eigener Mailserver, SMTP-Relay für Fremddomains, Zustellbarkeitsmanagement
- Komplexe Kalender- und Kontakteverwaltung
- KI-Zusammenfassungen und automatische Klassifikation
- Team-Delegation, SSO, Audit-Logs
- Vollständige Ende-zu-Ende-Verschlüsselung über beliebige externe Mailanbieter
- Native iOS-App
