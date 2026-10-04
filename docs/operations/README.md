# Betrieb

Doku für alle, die eine eigene Instanz betreiben. In dieser Reihenfolge lesen:

| Schritt | Dokument                              | Inhalt                                                                                |
| ------- | ------------------------------------- | ------------------------------------------------------------------------------------- |
| 1       | [Installation](installation.md)       | Voraussetzungen, `.env` erzeugen, Domain, Start, Ersteinrichtung, Konto, App und Push |
| 2       | [Konfiguration](configuration.md)     | Alle Variablen der `.env` mit Standardwerten, Ports, Volumes, Speicherlimits          |
| 3       | [Backup & Restore](backup-restore.md) | Verschlüsselte Backups, Cron, Offsite-Kopie, Restore, Bedeutung des `MASTER_KEY`      |
| 4       | [Upgrade](upgrade.md)                 | Neue Version einspielen, Migrationen, Rollback                                        |
| 5       | [Troubleshooting](troubleshooting.md) | Logs, Healthchecks, Kontostatus, TLS, Push, Speicher, Migrationsfehler                |

Außerdem:

- [Systemanforderungen](system-requirements.md) – gemessener Ressourcenverbrauch, Hardware-Empfehlung
- [Umzug auf einen neuen Server](migration.md) – vollständig per Backup oder per Konfigurations-Export
- [Master-Key-Rotation](../process/key-rotation.md)
- [Changelog](../../CHANGELOG.md) – vor jedem Upgrade auf **Betreiber:**-Einträge prüfen

## Support

- Fehler oder Wünsche: [GitHub-Issue](https://github.com/mszkb/fastmail-alternative/issues/new/choose) über die Vorlagen – vorher [Troubleshooting](troubleshooting.md#erste-diagnose) lesen. Keine Mailinhalte, Betreffzeilen, Adressen, Zugangsdaten, `.env` oder `MASTER_KEY` posten.
- Sicherheitslücken **nicht** öffentlich, sondern vertraulich nach der [Security-Policy](../../SECURITY.md) melden.

**Das Wichtigste in einem Satz:** Die `.env` – vor allem der `MASTER_KEY` – getrennt von Server und Backups sichern; ohne ihn sind Datenbank und Backups nicht mehr lesbar.
