# ADR-0013: PHP-Backend mit Slim 4, MySQL/MariaDB und Cron

- **Status:** Proposed
- **Datum:** 2026-10-06
- **Roadmap:** Querschnitt (Epic #94), Milestone M3 Stable
- **Ersetzt:** ADR-0002 (PostgreSQL), ADR-0008 (Fastify), ADR-0007 teilweise
- **Ändert:** ADR-0003 (Job-Tabelle in MySQL), ADR-0005 (Push-Versand aus Cron)

## Kontext

Ziel ist Self-Hosting so einfach wie möglich (Prinzip 1, `CLAUDE.md`). Fast jeder Webhoster bietet PHP und MySQL, kaum einer Node.js, PostgreSQL oder Dauerprozesse. Heute braucht eine Instanz einen eigenen Server mit Docker (Raspberry Pi, VPS).

Betroffen sind `apps/api`, `apps/worker`, `packages/db` und `packages/crypto` (zusammen ca. 14 000 Zeilen TypeScript). Die Nuxt-PWA (`apps/web`, statischer Build) bleibt unverändert und spricht dasselbe HTTP-API – Pfade, Statuscodes, JSON-Formen und Cookies müssen identisch bleiben.

Rahmenbedingungen auf Shared Hosting:

- Keine Dauerprozesse; Hintergrundarbeit nur per Cron (oft 1–15 min Intervall) mit begrenzter Laufzeit (`max_execution_time`) und begrenztem Speicher (`memory_limit`).
- Ausgehende Verbindungen zu IMAP 993 / SMTP 465/587 sind nicht überall erlaubt (Installer-Check, #109).
- PHP-Extensions sind durch den Hoster vorgegeben; `ext-imap` ist seit PHP 8.4 nicht mehr im Kern (nur noch PECL) und fällt damit aus.
- Bestehende Installationen haben verschlüsselte Daten in PostgreSQL und im Volume `mail-data`; diese müssen lesbar bleiben.

## Optionen

1. **Node/Fastify + PostgreSQL beibehalten** – kein Aufwand, aber Self-Hosting bleibt auf Docker-fähige Server beschränkt.
2. **PHP mit Laravel/Symfony** – viel eingebaut (ORM, Queue, Scheduler), aber großer Footprint, eigene Konventionen und viel Magie für ein kleines API; Deploy-Größe auf Shared Hosting spürbar.
3. **PHP mit Slim 4 + schlanken Einzelpaketen** – kleines Micro-Framework (PSR-7/PSR-15), Routen und Middleware 1:1 auf die heutigen Fastify-Hooks abbildbar; alles Weitere (DB, Queue, Cron) bewusst einfach selbst.
4. **Go-Binary** – ein statisches Binary, aber auf Shared Hosting ebenso wenig lauffähig wie Node.

## Entscheidung

**Option 3: PHP ≥ 8.2 mit Slim 4, Datenbank MySQL 8 / MariaDB 10.6+, Hintergrundarbeit per Cron.** Der neue Server entsteht in `apps/server-php`, parallel zum Node-Backend, bis Contract-Tests (#96) und Playwright-Tests gegen PHP grün sind. Danach Umstellung und Rückbau (#110).

### Laufzeit und Extensions

| Pflicht                                        | Zweck                                                                       |
| ---------------------------------------------- | --------------------------------------------------------------------------- |
| PHP ≥ 8.2                                      | `readonly`-Klassen, Enums, aktuelle Sicherheits-Updates                     |
| `openssl`                                      | AES-256-GCM, TLS zu IMAP/SMTP, VAPID (ECDSA P-256)                          |
| `pdo_mysql`                                    | Datenbank                                                                   |
| `mbstring`, `iconv`                            | Zeichensätze in Mails (MIME-Header, Bodies)                                 |
| `json`, `hash`, `random` (im Kern ab 8.2)      | `hash_hkdf`, `hash_hmac`, `random_bytes`                                    |
| `sodium` (im Kern seit 7.2, fast immer gebaut) | Argon2id via `password_hash(PASSWORD_ARGON2ID)` bzw. `sodium_crypto_pwhash` |

Optional: `intl` (IDN-Hostnamen, sonst Fallback), `pcntl` (nur Dauer-Worker), `gmp` oder `bcmath` (beschleunigt Web Push). `ext-imap` wird **nicht** verwendet.

**Passwort-Hashes:** Bestehende Argon2id-Hashes aus `hash-wasm` liegen im PHC-Format (`$argon2id$v=19$m=…,t=…,p=…$salt$hash`) vor, das `password_verify()` direkt liest. Neue Hashes mit denselben Parametern.

### Bibliotheken (Composer)

| Aufgabe          | Paket                                                                                 | Lizenz      | Begründung                                                                                                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP-Framework   | `slim/slim` 4, `slim/psr7`                                                            | MIT         | PSR-7/15, klein, Middleware-Modell wie Fastify-Hooks                                                                                                                                                                |
| IMAP             | **eigener schlanker Client** in `apps/server-php/src/Mail` auf `stream_socket_client` | –           | Kein gepflegtes PHP-Paket ohne `ext-imap` deckt CONDSTORE/QRESYNC, `UID MOVE`, `APPEND`, `LIST … RETURN (SPECIAL-USE)` und IDLE gemeinsam ab. Benötigt wird nur eine überschaubare Befehlsmenge mit Literal-Parser. |
| SMTP             | **eigener schlanker ESMTP-Client** (`src/Mail/SmtpClient.php`)                        | –           | Muss zur geprüften IP verbinden (SSRF-Pinning) und STARTTLS erzwingen; das ist mit einem eigenen Client einfacher als mit `symfony/mailer`. MIME-Aufbau für den Versand folgt mit #105                              |
| MIME-Parsing     | `zbateson/mail-mime-parser`                                                           | BSD-2       | Streaming-Parser, Zeichensätze, Anhänge; Ersatz für `mailparser`                                                                                                                                                    |
| HTML-Sanitizing  | `masterminds/html5` (HTML5-Parser) + eigene Allow-List (`src/Mail/HtmlSanitizer.php`) | MIT         | Policy wie `sanitize-html` heute; `symfony/html-sanitizer` kann `<body>`-Umbau, `<style>`-Bereinigung und Text-Erhalt entfernter Tags nicht abbilden. HTMLPurifier scheidet wegen LGPL (ADR-0009) aus               |
| Web Push         | **eigene Implementierung** mit `ext-openssl` (`src/Push`)                             | –           | VAPID (ES256) und aes128gcm (RFC 8291, mit Testvektor geprüft) brauchen nur ECDH, HKDF und AES-GCM; spart `minishlink/web-push` samt Abhängigkeiten                                                                 |
| Tests / Qualität | `phpunit/phpunit`, `phpstan/phpstan`, `friendsofphp/php-cs-fixer` (nur dev)           | BSD-3 / MIT | Entspricht Vitest, `tsc` und ESLint/Prettier                                                                                                                                                                        |

Datenbankzugriff über **PDO mit vorbereiteten Statements** und einer dünnen Repository-Schicht, kein ORM. Neue Abhängigkeiten werden wie bisher auf Schwachstellen (`composer audit`) und Lizenz geprüft.

### Datenbank: Ersatz für PostgreSQL-Funktionen

Die vollständige Abbildung je Migration folgt mit #98 in [`../architecture/data-model.md`](../architecture/data-model.md). Grundregeln:

| PostgreSQL                                                 | MySQL 8 / MariaDB 10.6+                                                                                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `uuid`, `gen_random_uuid()`                                | `CHAR(36) CHARACTER SET ascii`, UUID v4 in PHP erzeugt, **kleingeschrieben mit Bindestrichen** (Teil der Verschlüsselungs-AAD) |
| `citext` (`user.email`), Unique auf `lower(email_address)` | Collation `utf8mb4_0900_ai_ci` bzw. `utf8mb4_unicode_ci`; generierte Spalte `lower(...)` mit Unique-Index                      |
| `timestamptz`, `now()`                                     | `DATETIME(6)`, Verbindung mit `time_zone = '+00:00'`, Werte immer UTC; `UTC_TIMESTAMP(6)`                                      |
| `bytea`                                                    | `LONGBLOB` / `VARBINARY`                                                                                                       |
| `text[]` mit `array_append`, `= ANY`, `&&` (GIN)           | Join-Tabellen (Flags, Referenzen) bzw. `JSON` für reine Anzeige-/Capability-Listen                                             |
| `jsonb` (`job.payload`)                                    | `JSON`                                                                                                                         |
| `bigserial`, Sequenzen (negative Platzhalter-UIDs)         | `AUTO_INCREMENT`; Zählertabelle mit `UPDATE … SET n = LAST_INSERT_ID(n - 1)`                                                   |
| partielle Indizes                                          | normaler Index über die Filterspalte(n) oder generierte Spalte, die außerhalb der Bedingung `NULL` ist                         |
| `RETURNING`                                                | ID vorab in PHP erzeugen (UUID) bzw. `LAST_INSERT_ID()`; Lesen in derselben Transaktion                                        |
| `ON CONFLICT … DO UPDATE/NOTHING`                          | `INSERT … ON DUPLICATE KEY UPDATE` bzw. `INSERT IGNORE` (nur mit eindeutigem Schlüssel)                                        |
| datenändernde CTEs                                         | mehrere Statements in einer Transaktion                                                                                        |
| `DISTINCT ON`                                              | `ROW_NUMBER() OVER (PARTITION BY …)` (MySQL 8 / MariaDB 10.2+)                                                                 |
| `count(*) FILTER (WHERE …)`                                | `SUM(CASE WHEN … THEN 1 ELSE 0 END)`                                                                                           |
| `interval`, `make_interval`                                | `DATE_ADD(…, INTERVAL ? SECOND)`; Intervalle als Sekunden übergeben                                                            |
| `SELECT … FOR UPDATE SKIP LOCKED`                          | identisch (MySQL 8.0.1+, MariaDB 10.6+) – Grund für die Mindestversionen                                                       |
| `pg_advisory_lock`, `hashtextextended`                     | `GET_LOCK(name, timeout)` / `RELEASE_LOCK(name)` mit lesbarem Namen (max. 64 Zeichen)                                          |

Sortierung: Paging-Cursor und Threading vergleichen nur ASCII-Spalten (UUID, Zeitstempel, UIDs) oder HMAC-Hex-Werte; diese Spalten bekommen `ascii_bin`, damit die Reihenfolge der von PostgreSQL entspricht.

### Prozessspeicher → Tabellen

Ohne Dauerprozess gibt es keinen gemeinsamen Speicher zwischen Requests. Deshalb liegen in Tabellen:

- **Rate-Limits** (heute `security/rate-limit.ts`): `rate_limit(bucket, ip, window_start, count)`, Upsert per `ON DUPLICATE KEY UPDATE count = count + 1`; alte Fenster räumt der Cron weg.
- **Login-Lockout** (heute `auth/lockout.ts`): eigene Tabelle, gleiche Regeln (5 Fehler / 15 min).
- **Verbindungslimit je IMAP-Host** (heute im Worker): Zähltabelle bzw. `GET_LOCK('imap-host:<host>:<slot>')`.
- **Metriken** (`/api/metrics`): Zähler in einer Tabelle; Prozesswerte (RSS, Uptime) entfallen.

### Hintergrundarbeit: Cron und optionaler Worker

- **Ein Einstiegspunkt** `bin/cron.php` (CLI) bzw. alternativ ein per Token geschützter HTTP-Aufruf für Hoster, die nur Web-Cron anbieten.
- **Lock:** `GET_LOCK('fma-cron', 0)` – läuft ein Durchlauf noch, beendet sich der nächste sofort.
- **Zeitbudget je Aufruf** (Standard 50 s, konfigurierbar, immer unter `max_execution_time`): Der Runner holt Jobs aus der `job`-Tabelle (`SKIP LOCKED`, ADR-0003 bleibt inhaltlich bestehen), startet nur Jobs, die ins Restbudget passen, und plant periodische Jobs (Sync, Cleanup, Push) selbst ein.
- **Optionaler Dauer-Worker** `bin/worker.php` für VPS/Docker: gleiche Job-Schleife plus IMAP IDLE für den Posteingang. Wo er läuft, verhält sich die Instanz wie heute (neue Mail in Sekunden).
- Ohne Dauer-Worker erfüllt sich MVP-Kriterium 3 („neue Mail ohne Reload“) nur mit Verzögerung im Cron-Intervall; der Sync beim App-Start und Fokuswechsel bleibt sofort (Prinzip 3). Push wird ebenfalls aus dem Cron verschickt (Änderung zu ADR-0005, Inhalt des Payloads unverändert, Prinzip 4).

### Konfiguration und `MASTER_KEY`

- Quelle ist die Umgebung **oder** eine `config.php` **außerhalb des Webroots** (Shared Hosting kennt oft keine Umgebungsvariablen). Umgebung hat Vorrang.
- Webroot ist nur `apps/server-php/public` (bzw. beim Shared-Hosting-Paket ein Unterordner); `config.php`, `vendor/`, `src/` und `bin/` liegen darüber.
- Der Installer (#109) schreibt `config.php` mit Rechten `0600`, prüft, dass sie per HTTP **nicht** erreichbar ist, und weist darauf hin, den `MASTER_KEY` getrennt zu sichern.
- Der `MASTER_KEY` landet nie in der Datenbank, in Logs oder in Fehlermeldungen (Prinzipien 5–6).

### Verschlüsselung

Das Format aus `packages/crypto` (ADR-0001, `fma.k1.`/`fma.f1.`/`fma.b1.`, Backups `fma.bk1`) wird byte-kompatibel mit `openssl_encrypt`/`openssl_decrypt` (AES-256-GCM), `hash_hkdf` und `hash_hmac` nachgebaut (#99). Bestehende Daten bleiben ohne Neuverschlüsselung lesbar.

### API-Vertrag

Die nach ADR-0008/0010 vorgesehene OpenAPI-Spezifikation existiert noch nicht. Sie wird mit #96 als `docs/api/openapi.yaml` aus dem Node-Backend nachgezogen und ist der Vertrag, gegen den beide Backends mit HTTP-Contract-Tests geprüft werden.

### Installationswege

- **Shared Hosting** (Hauptweg): ZIP mit `vendor/` und statischem PWA-Build, Web-Installer mit Systemcheck (#109).
- **Docker Compose** (Raspberry Pi, VPS): Image mit PHP-FPM + Caddy, MariaDB-Container, Dauer-Worker (#109). Ersetzt die heutigen `api`-, `worker`- und `postgres`-Container.

## Konsequenzen

- Self-Hosting wird auf praktisch jedem Webhoster möglich; Docker bleibt als Weg für eigene Server.
- Zwei Backends existieren für eine Übergangszeit parallel. Neue Features werden in dieser Zeit nicht ins Node-Backend gebaut (Epic #94: keine neuen Features).
- Geteilte TypeScript-Typen zwischen API und PWA (`@fma/shared`) entfallen für das Backend; der Vertrag ist die OpenAPI-Datei. `packages/shared` bleibt für die PWA.
- Der IMAP-Client ist Eigenbau und braucht eigene Tests gegen GreenMail und Dovecot (Nightly).
- Auf Shared Hosting kommen neue Mails mit Cron-Verzögerung; IDLE nur mit Dauer-Worker.
- Bestehende Installationen brauchen eine einmalige Migration PostgreSQL → MySQL (#108).
- Rate-Limits und Lockout kosten einen DB-Zugriff je Request; bei einem Single-User-System unkritisch.

Folgeaufgaben: #96 bis #110 (Epic #94).
