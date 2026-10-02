# Produktvision

## Produktziel

Eine moderne Multi-Account-Mail-Anwendung, die bestehende IMAP-/SMTP-Konten in einer **Unified Inbox** bündelt.

- Muss **self-hosted** betrieben werden können.
- Optionale Managed Cloud und optionales Push-Relay sind Komfortfunktionen – sie dürfen **keine künstlichen Sperren** für die Self-hosted-Nutzung erzeugen.
- Startpunkt ist eine **PWA** mit iOS-Home-Screen-Unterstützung und Web Push.
- Eine **native iOS-App** ist das langfristige Ziel, aber keine Voraussetzung für das MVP.

### Motivation

Bestehende Self-hosted-Lösungen (z. B. Nextcloud Mail) bündeln zwar mehrere Konten, aber:

1. sehen nicht gut aus,
2. bieten zu wenig Einstellungsmöglichkeiten und Regeln,
3. sind langsam,
4. haben keine iOS-App mit Push-Benachrichtigungen.

Daraus folgen die Qualitätsziele: **Geschwindigkeit, gutes UI, konfigurierbare Regeln, zuverlässiger Push.**

## Zielgruppen

- Technik-affine Einzelanwender mit mehreren bestehenden Mailkonten.
- Self-Hoster, die **keinen** vollständigen öffentlichen Mailserver betreiben wollen.
- Kleine Teams mit Bedarf an einer zentralen, datensparsamen Mailoberfläche.

**Positionierung:** Unified Inbox für bestehende Mailkonten – self-hostbar, exportierbar, mit iOS-fähiger PWA.

## Produktprinzipien

- **Self-hosted first:** Docker-Deployment, klare Konfiguration, Backups und Migrationen.
- **Privacy by design:** Mailinhalte bleiben standardmäßig auf dem eigenen Server und werden nicht an ein Push-Relay übertragen.
- **Keine künstliche Paywall** für PWA, Export, Grundfunktionen oder eigene Serverinstanz.
- **Push ist ein Hinweis**, niemals die Quelle der Wahrheit. Die App synchronisiert beim Start und bei Fokuswechsel.
- **Sensible Zugangsdaten** werden verschlüsselt gespeichert.

## MVP-Funktionsumfang

- Benutzerkonto und Geräteverwaltung
- Mehrere IMAP-Konten anlegen, testen, bearbeiten, entfernen
- SMTP-Versand je Konto
- Unified Inbox
- Ordner, Flags, gelesen/ungelesen, Archivieren, Löschen, Verschieben
- Thread-Ansicht
- Antworten, Weiterleiten, neue Nachricht
- Entwürfe
- Anhänge anzeigen, herunterladen, versenden
- Grundlegende Volltext- und Metadatensuche
- PWA-Installation und Web Push
- Export der Serverkonfiguration und Migrationsdokumentation
- Docker-Compose-Deployment mit Healthcheck und Datenbankmigrationen

## Bewusst nicht im MVP

- Eigener Mailserver, SMTP-Relay für Fremddomains, Zustellbarkeitsmanagement
- Komplexe Kalender- und Kontakteverwaltung
- KI-Zusammenfassungen und automatische Klassifikation
- Team-Delegation, SSO, Audit-Logs
- Vollständige Ende-zu-Ende-Verschlüsselung über beliebige externe Mailanbieter
- Native iOS-App
