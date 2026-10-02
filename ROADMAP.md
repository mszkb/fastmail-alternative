# Roadmap

Self-hosted Fastmail-Alternative mit PWA. Hintergrund und Prinzipien: [`docs/product/vision.md`](docs/product/vision.md).

**Legende**
- Priorität: **P0** = MVP-blockierend, **P1** = wichtig für MVP/Beta, **P2** = später
- Aufwand: **S** ≤ 2 Tage, **M** ≤ 1 Woche, **L** ≤ 3 Wochen, **XL** > 3 Wochen
- Status: ⬜ offen · 🟨 in Arbeit · ✅ fertig
- 🔗 = externe Abhängigkeit (siehe [`docs/process/external-dependencies.md`](docs/process/external-dependencies.md))

## Milestones

| Milestone | Umfang | Ziel |
| --- | --- | --- |
| **M1 – MVP** | Phasen 0–4 | Ein Self-Hoster kann mehrere Konten verbinden, Mails lesen/schreiben und erhält Web Push auf iOS. |
| **M2 – Beta** | Phasen 5–6 | Suche, Anhänge, Cache-Modi, OAuth, Backup/Restore, Security Review. |
| **M3 – Stable** | Phase 7 | Release-Images, vollständige Doku, Demo-Deployment, Support-Prozess. |
| **M4 – Managed Services** | Phase 8 | Hosted Push Relay, Managed Hosting, Business-Funktionen. |
| *Später* | – | Native iOS-App (siehe [Ausblick](#ausblick)). |

## Phasenübersicht

```
P0 Discovery ─► P1 Foundation ─► P2 Single account ─► P3 Multi-account ─► P4 PWA ─► [M1 MVP]
                                        └──────────────► P5 Search & attachments ─┐
                                 P1 ───────────────────► P6 Hardening ────────────┴─► [M2 Beta] ─► P7 Release [M3] ─► P8 Paid [M4]
```

---

## Phase 0 – Discovery 🟨

Ziel: Entscheidungsgrundlage schaffen, bevor Code entsteht.

| # | Epic / Aufgabe | Prio | Aufwand | Abhängigkeiten | Akzeptanz |
| --- | --- | --- | --- | --- | --- |
| 0.1 | Lizenz festlegen (AGPL vs. MIT/Apache; Auswirkung auf Paid Services) | P0 | S | – | Lizenzdatei im Repo, Begründung als ADR |
| 0.2 | ADRs 0001–0008 entscheiden | P0 | M | 0.4 | Alle ADRs „Accepted" oder bewusst vertagt |
| 0.3 | Bedrohungsmodell (STRIDE-light) | P0 | M | 0.4 | `docs/architecture/threat-model.md` existiert |
| 0.4 | ✅ Datenmodell-Entwurf (User, Device, Account, Folder, Message, Thread, Job, PushSubscription) | P0 | M | – | ER-Diagramm in `docs/architecture/` → [Entwurf](docs/architecture/data-model.md) |
| 0.5 | Liste unterstützter Mailanbieter + Kompatibilitätsmatrix 🔗 | P1 | S | – | Matrix mit IMAP-Extensions (IDLE, CONDSTORE, QRESYNC, MOVE) je Provider |
| 0.6 | UX-Flows: Onboarding, Konto hinzufügen, Kontowechsel, Compose, Push-Opt-in | P1 | M | – | Wireframes/Flows dokumentiert |

**Risiken:** Lizenzwahl beeinflusst Geschäftsmodell in Phase 8; Provider-Eigenheiten (Gmail-Labels, Exchange-IMAP) werden unterschätzt.

## Phase 1 – Foundation ⬜

Ziel: Lauffähiges Skelett mit CI, Auth und Docker Compose.

| # | Epic / Aufgabe | Prio | Aufwand | Abhängigkeiten | Akzeptanz |
| --- | --- | --- | --- | --- | --- |
| 1.1 | Monorepo-Struktur (`apps/web`, `apps/api`, `apps/worker`, `packages/*`) | P0 | S | ADR-0008 | Struktur + Tooling (Lint, Format, Typecheck) |
| 1.2 | CI-Pipeline (Lint, Test, Build, Container-Build) | P0 | S | 1.1 | Grün auf `main`, läuft für jeden PR |
| 1.3 | Docker Compose (web, api, worker, postgres, queue) mit Healthchecks | P0 | M | 1.1, ADR-0007 | `docker compose up` → alle Services healthy |
| 1.4 | Migrationssystem für PostgreSQL | P0 | S | ADR-0002 | Migrationen laufen automatisch beim Start, idempotent |
| 1.5 | Secrets & Verschlüsselung (Master-Key aus Env, Envelope-Encryption für Zugangsdaten) | P0 | M | 0.3 | Keine Klartext-Credentials in DB; Key-Rotation dokumentiert |
| 1.6 | Auth: Benutzerkonto, Sessions, Geräteverwaltung | P0 | M | ADR-0004 | Login/Logout, Session-Rotation, Geräteliste |
| 1.7 | Observability: strukturierte Logs, Metriken, Healthcheck-Endpoint, Log-Redaction | P1 | M | 1.3 | Redaction-Tests für Passwörter/Tokens/Betreff |

## Phase 2 – Single account ⬜

Ziel: Ein IMAP-/SMTP-Konto vollständig nutzbar.

| # | Epic / Aufgabe | Prio | Aufwand | Abhängigkeiten | Akzeptanz |
| --- | --- | --- | --- | --- | --- |
| 2.1 | Konto anlegen & Verbindungstest (IMAP + SMTP) inkl. SSRF-Schutz | P0 | M | 1.5 | Test zeigt verständliche Fehler; interne IPs blockiert |
| 2.2 | IMAP-Sync-Worker (Initial-Sync, IDLE/Polling, UIDVALIDITY-Handling) 🔗 | P0 | L | 2.1, ADR-0003 | Neue Mails erscheinen ohne Reload |
| 2.3 | Inbox- und Ordneransicht | P0 | M | 2.2 | Paginierte Liste, Ordnerbaum |
| 2.4 | Basisaktionen: gelesen/ungelesen, Flag, Archivieren, Löschen, Verschieben | P0 | M | 2.2 | Änderungen werden zum IMAP-Server zurückgeschrieben |
| 2.5 | Threading (References/In-Reply-To, Fallback Betreff) | P0 | M | 2.2 | Thread-Ansicht korrekt für Standard-Testkorpus |
| 2.6 | Compose: Neu, Antworten, Allen antworten, Weiterleiten | P0 | M | 2.7 | Korrekte Header, Zitat, Signatur |
| 2.7 | SMTP-Versand-Worker inkl. Kopie in „Gesendet" | P0 | M | 2.1 | Retry mit Backoff, Fehlerstatus sichtbar |
| 2.8 | Entwürfe (lokal + IMAP-Drafts-Ordner) | P1 | M | 2.6 | Entwurf übersteht Reload und Gerätewechsel |
| 2.9 | Sicheres HTML-Rendering (Sanitizing, Remote-Content-Blocking) | P0 | M | 2.3 | Kein Script-Ausführen, externe Bilder opt-in |

## Phase 3 – Multi-account ⬜

| # | Epic / Aufgabe | Prio | Aufwand | Abhängigkeiten | Akzeptanz |
| --- | --- | --- | --- | --- | --- |
| 3.1 | Kontoverwaltung (anlegen, bearbeiten, entfernen inkl. Datenlöschung) | P0 | M | Phase 2 | Entfernen löscht Credentials und Metadaten |
| 3.2 | Kontowechsel (getrennte Postfächer je Konto, Thunderbird-artig, Ungelesen-Zähler pro Konto) | P0 | M | 3.1 | Wechsel ohne Reload; Ansicht zeigt nur Daten des aktiven Kontos |
| 3.7 | Optionale Unified Inbox (opt-in in den Einstellungen, standardmäßig aus) | P2 | S | 3.2 | Abschaltbar; Konto-Kennzeichnung je Nachricht |
| 3.3 | Konto-spezifische Ordner + Ordner-Mapping (Sent/Trash/Archive/Drafts via SPECIAL-USE) | P0 | M | 3.1 | Aktionen landen im richtigen Ordner je Konto |
| 3.4 | Fehlerisolierung: Sync pro Konto isoliert, Circuit Breaker, Statusanzeige | P0 | M | 2.2 | Kaputtes Konto blockiert andere nicht (Test) |
| 3.5 | Quoten & Limits (Verbindungen pro Provider, Sync-Rate, Speicher) | P1 | S | 3.4 | Konfigurierbar, Provider-Limits respektiert |
| 3.6 | Absenderauswahl/Identitäten beim Verfassen | P1 | S | 3.1 | Antwort nutzt automatisch passendes Konto |

## Phase 4 – PWA ⬜ → **M1 MVP**

| # | Epic / Aufgabe | Prio | Aufwand | Abhängigkeiten | Akzeptanz |
| --- | --- | --- | --- | --- | --- |
| 4.1 | Manifest, Service Worker, App-Shell-Caching | P0 | M | Phase 2 | Lighthouse-PWA-Checks bestanden |
| 4.2 | Installationshinweise (iOS „Zum Home-Bildschirm", Android, Desktop) 🔗 | P0 | S | 4.1 | Anleitung je Plattform in der App |
| 4.3 | Web Push: VAPID, Subscriptions, Cleanup abgelaufener Endpoints 🔗 | P0 | M | 4.1, ADR-0005 | Push auf iOS-PWA nach explizitem Opt-in |
| 4.4 | Badge-Handling (Badging API, Fallback) 🔗 | P1 | S | 4.3 | Badge zeigt Ungelesen-Zahl |
| 4.5 | Sync bei Start & Fokuswechsel (Push-unabhängig) | P0 | S | 2.2 | App aktuell auch ohne Push |
| 4.6 | Offline-UI + IndexedDB-Cache, optionale Offline-Queue für Aktionen | P1 | L | 4.1 | Gelesene Mails offline sichtbar; Aktionen werden nachgereicht |
| 4.7 | Export der Serverkonfiguration + Migrationsdoku | P0 | S | 3.1 | Export ohne Klartext-Secrets |

## Phase 5 – Search and attachments ⬜

| # | Epic / Aufgabe | Prio | Aufwand | Abhängigkeiten | Akzeptanz |
| --- | --- | --- | --- | --- | --- |
| 5.1 | Suche über IMAP `SEARCH` beim Provider (Absender, Betreff, Text, Datum) pro Konto | P0 | M | Phase 3 | Ergebnisse ohne Klartext-Index in der DB |
| 5.2 | Eigener Suchindex (nur falls IMAP `SEARCH` nicht reicht; verträglich mit verschlüsselten Inhalten) | P2 | L | ADR-0006 | Entscheidung dokumentiert |
| 5.3 | Attachments: anzeigen, herunterladen, versenden; Sandboxing | P0 | M | 2.6 | Kein Inline-Ausführen aktiver Inhalte; Größenlimits |
| 5.4 | Cache-Modi Proxy / Index / Cache umsetzen | P1 | L | ADR-0001 | Modus pro Instanz konfigurierbar, dokumentiert |
| 5.5 | Cleanup-Jobs (Cache-Eviction, verwaiste Anhänge, alte Jobs) | P1 | S | 5.4 | Speicher wächst nicht unbegrenzt |

## Phase 6 – Hardening ⬜ → **M2 Beta**

| # | Epic / Aufgabe | Prio | Aufwand | Abhängigkeiten | Akzeptanz |
| --- | --- | --- | --- | --- | --- |
| 6.1 | Security Review (OWASP ASVS L2 als Leitfaden) | P0 | M | Phasen 1–5 | Findings behoben oder dokumentiert akzeptiert |
| 6.2 | Backup & Restore (verschlüsselt) inkl. Restore-Test in CI | P0 | M | 1.4 | Restore auf frischer Instanz automatisiert getestet |
| 6.3 | OAuth2 für Gmail/Microsoft 🔗 | P1 | L | 2.1 | XOAUTH2 für IMAP/SMTP, Token-Refresh |
| 6.4 | Rate Limits, CSRF, Session-Härtung, Security-Header/CSP | P0 | M | 1.6 | Tests für Rate Limit und CSRF |
| 6.5 | Upgrade-/Migrationspfad zwischen Versionen | P0 | S | 1.4 | Upgrade von vorheriger Version getestet |
| 6.6 | Lasttests (viele Konten, große Postfächer) | P1 | M | Phase 5 | Zielwerte dokumentiert und erreicht |

## Phase 7 – Release ⬜ → **M3 Stable**

| # | Epic / Aufgabe | Prio | Aufwand | Abhängigkeiten | Akzeptanz |
| --- | --- | --- | --- | --- | --- |
| 7.1 | Betreiber-Doku (Installation, Konfiguration, Backup, Upgrade, Troubleshooting) | P0 | M | Phase 6 | Fremde Person installiert nach Doku erfolgreich |
| 7.2 | Release-Images (multi-arch, signiert) + SemVer | P0 | S | 1.2 | Images in Registry, Signatur prüfbar |
| 7.3 | Changelog-Prozess | P1 | S | – | `CHANGELOG.md` gepflegt |
| 7.4 | Demo-Deployment | P2 | S | 7.2 | Öffentliche Demo mit Testkonten |
| 7.5 | Support-Prozess (Issue-Templates, Security-Policy) | P1 | S | – | `SECURITY.md`, Issue-Templates |

## Phase 8 – Paid services ⬜ → **M4 Managed Services**

| # | Epic / Aufgabe | Prio | Aufwand | Abhängigkeiten | Akzeptanz |
| --- | --- | --- | --- | --- | --- |
| 8.1 | Hosted Push Relay (optional, Inhalte-frei) | P1 | L | 4.3 | Self-hosted Direkt-Push bleibt voll funktionsfähig |
| 8.2 | Managed Hosting | P2 | XL | Phase 7 | – |
| 8.3 | Managed Backups | P2 | M | 6.2 | – |
| 8.4 | Business-Funktionen (Team-Delegation, SSO, Audit-Logs) | P2 | XL | 8.2 | – |

---

## MVP-Akzeptanzkriterien

- [ ] Neue Self-hosted-Installation ist mit Docker Compose nachvollziehbar in Betrieb zu nehmen.
- [ ] Ein IMAP-/SMTP-Konto kann sicher verbunden und getestet werden.
- [ ] Neue Nachrichten erscheinen ohne manuelle Seitenaktualisierung nach erfolgreicher Synchronisierung.
- [ ] Die PWA kann auf iOS zum Home-Bildschirm hinzugefügt werden und erhält Web Push nach expliziter Zustimmung.
- [ ] Die App funktioniert auch ohne Push durch Synchronisierung beim Start und Fokuswechsel.
- [ ] Ein Backup kann auf einer frischen Installation wiederhergestellt werden. *(Beta)*
- [ ] Ungültige Zugangsdaten und ausgefallene Mailanbieter isolieren nicht alle anderen Konten.
- [ ] Es gibt keine sensiblen Maildaten in Logs oder Push-Payloads.

## Ausblick

- **Native iOS-App** mit APNs-Push – das eigentliche Langfristziel (siehe README). Die PWA ist der Startpunkt; API und Push-Architektur sollen von Anfang an so gebaut werden, dass ein nativer Client ohne Backend-Umbau andocken kann.
- Erweiterte Regeln/Filter (Sieve-ähnlich), Kalender/Kontakte, KI-Funktionen – bewusst nach dem MVP.
