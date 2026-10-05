# Dokumentation

| Bereich                                                                | Inhalt                                                                                |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [product/vision.md](product/vision.md)                                 | Produktziel, Zielgruppen, Prinzipien, MVP-Scope und Nicht-Ziele                       |
| [product/mail-providers.md](product/mail-providers.md)                 | Unterstützte Mailanbieter, Zugangsdaten, Kompatibilitätsmatrix der IMAP-Erweiterungen |
| [product/offene-fragen.md](product/offene-fragen.md)                   | Offene Produktfragen mit gewähltem Default (z. B. Sync-Verhalten bei offener App)     |
| [architecture/overview.md](architecture/overview.md)                   | Komponenten, Datenfluss, Deployment                                                   |
| [architecture/data-model.md](architecture/data-model.md)               | Datenmodell-Entwurf mit ER-Diagramm                                                   |
| [architecture/security.md](architecture/security.md)                   | Daten- und Sicherheitsmodell                                                          |
| [architecture/push.md](architecture/push.md)                           | Push-Strategie (Web Push, Relay, später APNs)                                         |
| [security/asvs-l2.md](security/asvs-l2.md)                             | Security Review nach OWASP ASVS L2: Befunde, Status, akzeptierte Abweichungen         |
| [adr/](adr/README.md)                                                  | Architecture Decision Records                                                         |
| [process/definition-of-done.md](process/definition-of-done.md)         | Definition of Done                                                                    |
| [process/changelog.md](process/changelog.md)                           | Changelog-Prozess (Keep a Changelog, SemVer)                                          |
| [process/release.md](process/release.md)                               | Release-Prozess: SemVer, signierte Multi-Arch-Images, Signatur prüfen                 |
| [process/external-dependencies.md](process/external-dependencies.md)   | Externe Abhängigkeiten und Risiken                                                    |
| [process/key-rotation.md](process/key-rotation.md)                     | Master-Key-Rotation und Crypto-Shredding                                              |
| [process/mvp-status.md](process/mvp-status.md)                         | MVP-Status (M1): Akzeptanzkriterien mit Belegen, offene Punkte bis zum Release        |
| [operations/](operations/README.md)                                    | **Betreiber-Doku:** Installation, Konfiguration, Backup, Upgrade, Troubleshooting     |
| [operations/installation.md](operations/installation.md)               | Installation Schritt für Schritt (Docker Compose, Domain, Ersteinrichtung)            |
| [operations/configuration.md](operations/configuration.md)             | Referenz aller Umgebungsvariablen (`.env`)                                            |
| [operations/troubleshooting.md](operations/troubleshooting.md)         | Fehlersuche: Logs, Healthchecks, Kontostatus, TLS, Push, Migrationen                  |
| [operations/system-requirements.md](operations/system-requirements.md) | Systemanforderungen und gemessener Ressourcenverbrauch                                |
| [operations/load-test.md](operations/load-test.md)                     | Lasttest: viele Konten, große Postfächer (Methode, Messwerte)                         |
| [operations/migration.md](operations/migration.md)                     | Umzug auf einen neuen Server, Konfigurations-Export/-Import                           |
| [operations/backup-restore.md](operations/backup-restore.md)           | Verschlüsselte Backups, Cron, Restore, Restore-Test                                   |
| [operations/upgrade.md](operations/upgrade.md)                         | Upgrade auf neue Version, Migrationen, Rollback                                       |

Die Phasen- und Aufgabenplanung steht in [`../ROADMAP.md`](../ROADMAP.md).
