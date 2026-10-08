# Security Review – OWASP ASVS 4.0.3 Level 2

> Hinweis: Dieser Review bezieht sich auf das frühere Node-Backend (`apps/api`, `apps/worker`, `packages/crypto`, `packages/db`) mit PostgreSQL, das mit #110 entfernt wurde. Befunde und Pfadangaben bleiben als Stand des Reviews unverändert; die Entsprechungen liegen heute in `apps/server-php` (aktueller Stand der Maßnahmen: [architecture/security.md](../architecture/security.md)).

Audit für Roadmap 6.1 / Issue #56, Stand 2026-10-04. Leitfaden ist [OWASP ASVS 4.0.3](https://owasp.org/www-project-application-security-verification-standard/) Level 2; geprüft wurden Code in `apps/api`, `apps/worker`, `apps/web`, `packages/crypto`, `packages/db`, `packages/shared` sowie `Caddyfile`, `apps/web/nginx.conf`, `docker-compose.yml`, Dockerfiles und CI. Zeilenangaben beziehen sich auf den Stand **vor** den Fixes. Das Daten- und Sicherheitsmodell selbst steht in [architecture/security.md](../architecture/security.md).

## Status der Befunde

| Befund                                        | Stufe   | Status            | Wo                                                                                                                 |
| --------------------------------------------- | ------- | ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| M1 Ersteinrichtung ohne Setup-Geheimnis, Race | Mittel  | ✅ behoben        | Paket B: Setup-Code (Log oder `SETUP_TOKEN`), Transaktion mit Advisory-Lock                                        |
| M2 Brute-Force-Schutz nur pro IP              | Mittel  | ◐ teilweise       | Paket B: Security-Events für fehlgeschlagene Logins/Passwortwechsel; Lockout bleibt pro IP (siehe Abweichungen)    |
| M3 SSRF per IPv6-Literal                      | Mittel  | ✅ behoben        | Paket A (`7210395`)                                                                                                |
| M4 STARTTLS nur opportunistisch               | Mittel  | ✅ behoben        | Paket A (`7210395`), Fehlercode `TLS_REQUIRED`                                                                     |
| N1 DNS-Rebinding                              | Niedrig | ✅ behoben        | Mail-Hosts in Paket A; Push-Endpoints per geprüftem Socket-`lookup`                                                |
| N2 beliebige Ziel-Ports                       | Niedrig | ✅ behoben        | Port-Allowlist (IMAP 143/993, SMTP 25/465/587/2525), Ausnahmen per `MAIL_EXTRA_PORTS`, Fehlercode `BLOCKED_PORT`   |
| N3 kein zentraler Error-Handler               | Niedrig | ✅ behoben        | Paket B: `setErrorHandler`, UUID-/Typprüfung                                                                       |
| N4 `console.warn` umgeht Redaction            | Niedrig | ✅ behoben        | Paket A (`7210395`)                                                                                                |
| N5 Supply Chain                               | Niedrig | ✅ behoben        | Dependabot, `permissions: contents: read`, `pnpm audit --prod --audit-level=high` in CI; Digest-Pins bewusst nicht |
| N6 AES-GCM-Tag-Länge                          | Niedrig | ✅ behoben        | Paket A (`7210395`)                                                                                                |
| N7 Metrics-Token konstantzeitig               | Niedrig | ✅ behoben        | Paket A (`7210395`)                                                                                                |
| N7 Cookie `__Host-`-Präfix                    | Niedrig | ❌ zurückgestellt | siehe Abweichungen                                                                                                 |
| N7 `MAIL_ALLOW_PRIVATE_HOSTS` trennen         | Niedrig | ✅ behoben        | `MAIL_ALLOW_PRIVATE_HOSTS` nur SSRF (TLS bleibt Pflicht), `MAIL_INSECURE_TRANSPORT` nur Dev/Test                   |
| N7 `Secure`-Cookie bei `DOMAIN=:80`           | Niedrig | ✅ behoben        | `COOKIE_SECURE=1` für eigenen TLS-Proxy vor `DOMAIN=:80`                                                           |

„Paket B" ist der Commit „Harden first-run setup, error handling and supply chain (ASVS review)".

Die folgende Checkliste und die Befundbeschreibungen geben den Stand des Audits wieder (vor den Fixes); der aktuelle Status steht in der Tabelle oben und jeweils unter **Status**.

Legende: ✅ erfüllt · ◐ teilweise · ❌ offen · n. a. nicht anwendbar

---

## 1. Checkliste (relevante ASVS-L2-Punkte)

### V1 Architektur, Design, Threat Modeling

| ASVS                                          | Status | Beleg                                                                                                                                                    |
| --------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.1.2 Threat Model                            | ❌     | `docs/architecture/security.md` „Offene Punkte": `threat-model.md` fehlt noch                                                                            |
| 1.2.x Getrennte Komponenten/least privilege   | ✅     | api mountet `mail-data` read-only (`docker-compose.yml` api.volumes), Container laufen als `USER node` (`apps/api/Dockerfile`, `apps/worker/Dockerfile`) |
| 1.4.1 Zugriffskontrolle serverseitig, zentral | ✅     | `requireAuth` als `onRequest` auf allen Routen (`apps/api/src/auth/routes.ts:83`), alle Mail-/Push-Routen geprüft                                        |
| 1.5.x Validierung serverseitig                | ◐      | handgeschriebene Parser (`accounts.ts:122`, `compose.ts`), aber kein Schema; Typfehler → 500 (siehe Befund N3)                                           |
| 1.6.x Key-Management dokumentiert             | ✅     | Envelope-Encryption + Rotation (`packages/crypto/src/index.ts:1-22`, `docs/process/key-rotation.md`)                                                     |
| 1.14.x Konfiguration/Segmentierung            | ✅     | postgres nur `127.0.0.1:5432`, api/web nur `expose` (`docker-compose.yml`)                                                                               |

### V2 Authentifizierung

| ASVS                                           | Status | Beleg                                                                                                 |
| ---------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------- |
| 2.1.1 Passwort ≥ 12 Zeichen                    | ◐      | Minimum 10 (`apps/api/src/auth/routes.ts:131-133`)                                                    |
| 2.1.2 bis ≥ 64/128 Zeichen erlaubt             | ✅     | max. 200 (`routes.ts:132`)                                                                            |
| 2.1.3/2.1.4 keine Truncation, Unicode erlaubt  | ✅     | Passwort unverändert an Argon2 (`routes.ts:139`)                                                      |
| 2.1.5/2.1.6 Passwortwechsel mit altem Passwort | ✅     | `routes.ts:245-299`                                                                                   |
| 2.1.7 Breached-Password-Prüfung                | ❌     | keine (bewusste Abweichung, s. u.)                                                                    |
| 2.1.9 keine Komposition-Regeln                 | ✅     | nur Länge (`routes.ts:131`)                                                                           |
| 2.2.1 Anti-Automation                          | ◐      | Lockout + Rate-Limit nur pro IP (`auth/lockout.ts:29`, `security/rate-limit.ts:67`), siehe M2         |
| 2.2.2/2.4.x MFA                                | ❌     | keine MFA (bewusste Abweichung)                                                                       |
| 2.4.1/2.4.4 Passwort-Hashing                   | ✅     | Argon2id m=19 MiB, t=2, p=1, 16-Byte-Salt (`auth/password.ts:13-27`)                                  |
| 2.5.x Credential Recovery                      | n. a.  | kein Reset-Flow (Single-User, Self-hosted)                                                            |
| 2.2.x/2.5.x Ersteinrichtung                    | ◐      | `POST /api/auth/setup` ohne Setup-Token, Race (siehe M1)                                              |
| 2.10.x Service-Credentials                     | ✅     | IMAP/SMTP-Passwörter verschlüsselt (`mail/accounts.ts:109-111`), nie in Antworten (`accounts.ts:156`) |
| User-Enumeration                               | ✅     | gleiche Antwort + Dummy-Argon2 (`routes.ts:214-219`, `password.ts:44-47`)                             |

### V3 Session-Management

| ASVS                                                              | Status | Beleg                                                                                                                                  |
| ----------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| 3.1.1 Token nie in URL                                            | ✅     | nur Cookie `fma_session` (`routes.ts:90-98`)                                                                                           |
| 3.2.1 neues Token bei Login                                       | ✅     | `routes.ts:233-241` (alte Session wird gelöscht)                                                                                       |
| 3.2.2 ≥ 64 Bit Entropie                                           | ✅     | 32 Byte `randomBytes` (`auth/sessions.ts:33-35`), DB speichert nur SHA-256 (`sessions.ts:29-31`)                                       |
| 3.3.1 Logout invalidiert serverseitig                             | ✅     | `routes.ts:301-305`, `sessions.ts:98-110`                                                                                              |
| 3.3.2 Re-Auth nach 12 h / 30 min Idle (L2)                        | ❌     | absolut 30 d, Idle 14 d (`sessions.ts:18-19`) – bewusste Abweichung (PWA/Push)                                                         |
| 3.3.3 Option „alle anderen Sessions beenden" nach Passwortwechsel | ✅     | `sessions.ts:164-206`                                                                                                                  |
| 3.3.4 aktive Sessions sichtbar/widerrufbar                        | ✅     | `GET/DELETE /api/auth/devices` (`routes.ts:307-327`)                                                                                   |
| 3.4.1 Secure                                                      | ✅     | automatisch, wenn `DOMAIN != :80`; hinter eigenem TLS-Proxy mit `DOMAIN=:80` per `COOKIE_SECURE=1` (N7, PHP: `Auth/SessionCookie.php`) |
| 3.4.2 HttpOnly / 3.4.3 SameSite                                   | ✅     | `httpOnly: true`, `sameSite: 'strict'` (`routes.ts:93-94`)                                                                             |
| 3.4.4 `__Host-`-Präfix                                            | ❌     | Cookie heißt `fma_session` (`routes.ts:31`) – Niedrig, siehe N7                                                                        |
| 3.4.5 Path                                                        | ✅     | `path: '/'` bewusst, Origin dediziert                                                                                                  |
| 3.5.x Token-Rotation                                              | ✅     | alle 24 h (`routes.ts:71-74`)                                                                                                          |
| 3.7.1 Re-Auth vor sensiblen Aktionen                              | ◐      | Passwortwechsel ja; Konto anlegen/löschen, Export, Geräte-Widerruf ohne Re-Auth                                                        |

### V4 Zugriffskontrolle

| ASVS                                      | Status | Beleg                                                                                                                                                                                                   |
| ----------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4.1.1/4.1.3 serverseitig, deny by default | ✅     | jede Route mit `onRequest: requireAuth` (geprüft per Skript für `apps/api/src/mail/*`, `push/routes.ts`); `/api/health`, `/api/auth/status`, `/api/auth/login`, `/api/auth/setup` bewusst öffentlich    |
| 4.2.1 IDOR                                | ✅     | Besitzprüfung via `a.user_id = $2` z. B. `message-html.ts:154-161`, `attachments.ts:307-313`, `message-actions.ts:143-149`, `outbox.ts:353-356` (Uploads an `account_id` gebunden), `drafts.ts:400-404` |
| 4.2.2 CSRF                                | ✅     | SameSite=Strict + Origin/Sec-Fetch-Site-Prüfung vor Body-Parsing (`security/csrf.ts:25-49`)                                                                                                             |
| 4.3.1 Admin-Interfaces                    | ✅     | `/api/metrics` nur mit Token, sonst 404 (`app.ts:103-114`)                                                                                                                                              |

### V5 Validierung, Sanitizing, Encoding

| ASVS                                          | Status | Beleg                                                                                                                                                                                                                       |
| --------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5.1.3/5.1.4 Allowlist-Validierung             | ◐      | IDs per `UUID_RE` (`accounts.ts:100`, `message-html.ts:26`), Ports `1..65535` (`accounts.ts:118-120`), Hosts in `accounts.ts` **ohne** Format-Prüfung (`accounts.ts:136-150`, Import hat `HOST_RE` `config-transfer.ts:48`) |
| 5.2.1 HTML-Sanitizing (HTML-Mails)            | ✅     | sanitize-html-Allowlist, CSS-Filter, URL-Policy (`mail/html-sanitizer.ts:39-401`)                                                                                                                                           |
| 5.2.6 SSRF                                    | ✅     | DNS-Prüfung vor jeder Verbindung, Verbindung an die geprüfte Adresse (M3, N1 behoben); Port-Allowlist (N2 behoben, PHP: `Mail/TransportPolicy.php`)                                                                         |
| 5.2.7 SVG/Script in Inhalten                  | ✅     | Inline-Bilder nur Raster (`html-sanitizer.ts:165`, `message-html.ts:27-35`)                                                                                                                                                 |
| 5.3.1 kontextbezogenes Output-Encoding        | ✅     | Vue-Interpolation, kein `v-html` (`MessageBody.vue:138`); Mail-HTML nur via `srcdoc`                                                                                                                                        |
| 5.3.3 XSS-Schutz Mail-HTML (Defense in Depth) | ✅     | iframe `sandbox="allow-popups allow-popups-to-escape-sandbox"` + eigene CSP (`MessageBody.vue:47-53,126`)                                                                                                                   |
| 5.3.4/5.3.5 SQL-Injection                     | ✅     | durchgehend parametrisierte Queries; dynamische `SET`-Listen nur aus festen Spaltennamen (`accounts.ts:391`, `identities.ts:230`)                                                                                           |
| 5.3.x Mail-Header-Injection                   | ✅     | Message-IDs per Regex (`packages/shared/src/compose.ts:12-20`), Betreff CR/LF entfernt (`compose.ts:90`), Header baut nodemailer                                                                                            |
| 5.5.x Deserialisierung                        | ✅     | nur JSON (Fastify-Parser), Import mit Body-Limit 2 MB (`config-transfer.ts:46,305`)                                                                                                                                         |

### V6 Kryptografie at rest

| ASVS                                        | Status | Beleg                                                                                                              |
| ------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------ |
| 6.1.1/6.1.2 sensible Daten verschlüsselt    | ✅     | AES-256-GCM pro Feld mit AAD (`packages/crypto/src/index.ts:94-119`), Raw-Mails/Anhänge binär (`index.ts:125-132`) |
| 6.2.1 Fehlerbehandlung ohne Oracle          | ✅     | Decrypt-Fehler → `null`/leere Antwort (`message-html.ts:121-139`)                                                  |
| 6.2.2/6.2.3 geprüfte Algorithmen, Nonce     | ✅     | Node `crypto`, 12-Byte-Zufallsnonce pro Feld (`index.ts:95`)                                                       |
| 6.2.x Tag-Länge fixiert                     | ◐      | kein `authTagLength: 16` bei `createDecipheriv` (`index.ts:82,112`) – Niedrig, siehe N6                            |
| 6.3.1 CSPRNG                                | ✅     | `randomBytes` überall (`sessions.ts:34`, `index.ts:45`)                                                            |
| 6.4.1/6.4.2 Key-Management, Key nicht in DB | ✅     | `MASTER_KEY` nur aus Env (`docker-compose.yml` api/worker), DEKs gewrappt (`index.ts:52-91`)                       |
| Backups verschlüsselt                       | ✅     | `apps/worker/src/backup.ts` (HKDF + AES-GCM, laut `security.md`)                                                   |
| Client-Cache verschlüsselt                  | ✅     | WebCrypto non-extractable Key (`apps/web/app/utils/offline-store.ts`, laut `security.md`)                          |

### V7 Fehlerbehandlung und Logging

| ASVS                                          | Status | Beleg                                                                                                                                                                                               |
| --------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 7.1.1/7.1.2 keine Credentials/Inhalte in Logs | ◐      | zentrale pino-Redaction (`packages/shared/src/redact.ts:22-60`, `apps/api/src/logging.ts:25-48`), Query-String entfernt; aber `console.warn` mit vollem Fehlerobjekt (`connection-test.ts:114`, N4) |
| 7.1.3 Security-Events geloggt                 | ◐      | Job-Fehler strukturiert (`apps/worker/src/runner.ts:381-392`); fehlgeschlagene Logins/Lockouts werden **nicht** explizit geloggt (nur Access-Log mit Status 401/429)                                |
| 7.3.x Log-Injection                           | ✅     | JSON-Logs (pino)                                                                                                                                                                                    |
| 7.4.1 generische Fehlermeldungen              | ◐      | kein `setErrorHandler` (`apps/api/src/app.ts:50-61`) → Fastify-Default gibt `error.message` bei 500 zurück (N3)                                                                                     |
| 7.4.x Log-Rotation                            | ✅     | json-file 10 MB × 3 (`docker-compose.yml` x-logging)                                                                                                                                                |

### V8 Datenschutz

| ASVS                               | Status | Beleg                                                                                                                                     |
| ---------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 8.1.1 kein Caching sensibler Daten | ✅     | `Cache-Control: no-store` für alle API-Antworten (`security/headers.ts:22`), SW lässt `/api/*` durch (`apps/web/service-worker/sw.js:57`) |
| 8.2.x Client-Speicher              | ✅     | IndexedDB verschlüsselt, Löschen bei Logout/401 (`security.md` „Offline-Cache")                                                           |
| 8.3.1 sensible Daten nicht in URL  | ◐      | Suchbegriffe in Query (`GET /api/accounts/:id/search?q=`), aber aus Logs entfernt (`logging.ts:18-22`)                                    |
| 8.3.x Push ohne Inhalte            | ✅     | `buildPushPayload` nur Typ/Installations-ID/Badge (`packages/shared/src/push.ts:23-29`), Notification-Text generisch (`sw.js:101`)        |
| 8.3.4 Datenexport ohne Secrets     | ✅     | Export ohne Passwörter/DEKs (`config-transfer.ts:1-17`)                                                                                   |

### V9 Kommunikation

| ASVS                                                      | Status | Beleg                                                                                       |
| --------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------- |
| 9.1.1 TLS für Clients                                     | ✅     | Caddy Auto-HTTPS, HSTS 1 Jahr (`Caddyfile` header)                                          |
| 9.1.2/9.1.3 aktuelle TLS-Konfig                           | ✅     | Caddy-Defaults (TLS 1.2+)                                                                   |
| 9.2.1 TLS-Zertifikatsprüfung ausgehend                    | ✅     | `rejectUnauthorized` nur im Testmodus aus (`connection-test.ts:89`, `worker/src/jobs/*.ts`) |
| 9.2.2 verschlüsselte Verbindungen zu Backends (IMAP/SMTP) | ❌     | STARTTLS nur opportunistisch, Downgrade → Passwort im Klartext (M4)                         |
| 9.2.x Push-Service                                        | ✅     | nur `https:` + `redirect: 'manual'` (`worker/src/jobs/push-notify.ts:215-235`)              |
| intern api↔postgres                                       | ◐      | Klartext im Compose-Netz (akzeptabel, internes Bridge-Netz)                                 |

### V10 Malicious Code / Supply Chain

| ASVS                                 | Status | Beleg                                                                                                                                                                          |
| ------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 10.3.2 Integrität von Abhängigkeiten | ◐      | `pnpm install --frozen-lockfile` (Dockerfiles), aber Basis-Images nur per Tag (`node:24-alpine`, `nginx:alpine`, `caddy:2-alpine`, `postgres:17-alpine`), kein Digest-Pin (N5) |
| 14.2.1/10.x Schwachstellen-Scan      | ❌     | kein `pnpm audit`/Dependabot/Renovate in `.github/` (N5)                                                                                                                       |
| 10.2.x keine Hintertüren/Phone-home  | ✅     | keine Telemetrie gefunden; Testmodus nur per `MAIL_INSECURE_TRANSPORT`                                                                                                         |

### V12 Dateien und Ressourcen

| ASVS                                            | Status | Beleg                                                                                                                                                 |
| ----------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 12.1.1 Größenlimits                             | ✅     | `bodyLimit` = `MAX_ATTACHMENT_BYTES` (`attachments.ts:511`), Gesamtlimit (`outbox.ts:360-361`), max. gleichzeitige Uploads (`attachments.ts:107-118`) |
| 12.3.1 Pfad-Traversal                           | ✅     | `storage_ref` auf Volume begrenzt (`message-html.ts:127-129`); Uploads liegen verschlüsselt in der DB                                                 |
| 12.3.x Dateiname                                | ✅     | `sanitizeFilename` (`attachments.ts:538`), RFC-5987-Disposition                                                                                       |
| 12.4.1 Ablage außerhalb Webroot                 | ✅     | `mail-data`-Volume / DB                                                                                                                               |
| 12.5.2 / 12.6.1 Download-Header, kein Ausführen | ✅     | `attachment` + `nosniff` + CSP `sandbox` + `application/octet-stream` für unsichere Typen (`attachments.ts:87,449-460`)                               |
| 12.6.1 SSRF über URLs                           | ◐      | siehe 5.2.6                                                                                                                                           |

### V13 API

| ASVS                               | Status | Beleg                                                                                                        |
| ---------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------ |
| 13.1.3 keine Secrets in URLs       | ✅     | Metrics-Token im Header (`app.ts:109`)                                                                       |
| 13.1.4 Autorisierung pro Ressource | ✅     | siehe V4                                                                                                     |
| 13.2.1 nur benötigte Methoden      | ✅     | explizite Routen, GET ohne Zustandsänderung (Ausnahme: Token-Rotation in `GET /api/auth/status`, unkritisch) |
| 13.2.2 Schema-Validierung JSON     | ◐      | keine Fastify-JSON-Schemas; manuelle Prüfung (N3)                                                            |
| 13.2.5 Content-Type-Prüfung        | ✅     | Upload nur `application/octet-stream` (`attachments.ts:465-468,524-527`), sonst Fastify-JSON                 |
| 13.2.6 Rate Limits                 | ✅     | `security/rate-limit.ts:30-47` + Login-Lockout + Suchlimit                                                   |
| 13.1.5 OpenAPI-Vertrag             | ◐      | ADR-0010 sieht OpenAPI vor; im Code kein Schema hinterlegt (nicht sicherheitskritisch)                       |

### V14 Konfiguration und HTTP-Header

| ASVS                          | Status | Beleg                                                                                                                                                                                                         |
| ----------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 14.1.x reproduzierbarer Build | ✅     | Multi-Stage-Dockerfiles, Lockfile                                                                                                                                                                             |
| 14.2.x Abhängigkeiten aktuell | ◐      | siehe V10                                                                                                                                                                                                     |
| 14.3.2 kein Debug in Prod     | ✅     | `NODE_ENV=production`, `MAIL_INSECURE_TRANSPORT` nicht in Compose                                                                                                                                             |
| 14.3.3 keine Versions-Header  | ✅     | `-Server` (Caddy), `server_tokens off` (`nginx.conf:5`); `/api/health` liefert App-Version (unkritisch)                                                                                                       |
| 14.4.1 Content-Type + charset | ✅     | Fastify JSON `charset=utf-8`                                                                                                                                                                                  |
| 14.4.3 CSP                    | ◐      | API `default-src 'none'` (`security/headers.ts:14-15`); PWA ohne `unsafe-inline` für Skripte, aber `style-src 'unsafe-inline'` und `img-src http: https:` (`apps/web/scripts/build-csp.mjs`) – bewusst, s. u. |
| 14.4.4 nosniff                | ✅     | API, nginx, Caddy-Fallback                                                                                                                                                                                    |
| 14.4.5 HSTS                   | ✅     | `Caddyfile` (ohne `includeSubDomains`, bewusst)                                                                                                                                                               |
| 14.4.6 Referrer-Policy        | ✅     | `no-referrer` überall                                                                                                                                                                                         |
| 14.4.7 Framing                | ✅     | `frame-ancestors 'none'` + `X-Frame-Options: DENY`                                                                                                                                                            |
| 14.5.3 CORS                   | ✅     | kein CORS-Plugin → keine `Access-Control-Allow-*`-Header                                                                                                                                                      |
| 14.5.x Slowloris/Body-DoS     | ✅     | `requestTimeout` 120 s (`app.ts:27,60`), Caddy `read_header`/`read_body`, Auth vor Body-Parsing                                                                                                               |

---

## 2. Befunde (im Code verifiziert)

Kontext für die Einstufung: Single-User-Instanz. Viele Angriffe setzen eine gültige Session voraus,
also den Besitzer selbst (oder jemanden, der die Session übernommen hat). Deshalb ist nichts als „Hoch"
eingestuft. M4 betrifft echte Zugangsdaten gegenüber einem Netzwerkangreifer und ist der wichtigste Punkt.

### Mittel

**M4 – IMAP/SMTP: STARTTLS nur opportunistisch → Downgrade, Passwort im Klartext** _(wichtigster Befund)_

- **Status:** behoben in `7210395` (zentrale Transport-Policy `packages/shared/src/mail-transport.ts`).
- Belege: `apps/api/src/mail/connection-test.ts:82-92` (ImapFlow ohne `doSTARTTLS`) und `:131-139` (nodemailer ohne `requireTLS`). Genauso in `apps/api/src/mail/search.ts:192-203`, `apps/worker/src/jobs/message-sync.ts:317-325`, `send-message.ts:168-198`, `message-action.ts:160-168`, `folder-sync.ts:45-53`, `draft-sync.ts:66-74`, `apps/worker/src/idle.ts:232-241`. `secure` ist nur bei 993/465 gesetzt (`accounts.ts:114-116`).
- Bibliothek geprüft (`apps/worker/dist/main.js:62893-62917`): Bei `doSTARTTLS === undefined` und fehlender STARTTLS-Capability gibt ImapFlow `false` zurück und meldet sich im Klartext an. nodemailer macht STARTTLS nur, wenn der Server es anbietet oder `requireTLS` gesetzt ist (`main.js:73487`).
- Angriff: Der Nutzer konfiguriert Port 143/587 (das ist üblich und die UI erlaubt es). Ein aktiver Angreifer im Pfad (öffentliches WLAN des Pi-Hosters, kompromittierter Router, ISP) entfernt `STARTTLS` aus CAPABILITY bzw. EHLO. Dann gehen LOGIN/AUTH PLAIN samt Passwort und danach alle Mails im Klartext über die Leitung. Das passiert bei jedem Sync und Versand, ohne dass der Nutzer es merkt.
- Minimaler Fix: Für Nicht-TLS-Ports außerhalb des Testmodus `doSTARTTLS: true` (ImapFlow) und `requireTLS: true` (nodemailer) setzen, am besten zentral als Helper in `@fma/shared` oder `worker/src/ports.ts`. Ein Klartext-Opt-in pro Konto gibt es höchstens explizit und mit Warnung. Dazu ein Test mit GreenMail ohne STARTTLS, der die Verbindung ablehnen muss.

**M1 – Ersteinrichtung ohne Setup-Geheimnis, dazu Race Condition (Instanz-Übernahme)**

- **Status:** behoben in Paket B. `POST /api/auth/setup` verlangt einen Setup-Code (`apps/api/src/auth/setup-code.ts`): `SETUP_TOKEN` aus `.env` oder ein zufälliger Code (6×4 Base32, 120 Bit), den die api einmalig ins Log schreibt, solange kein Benutzer existiert; Vergleich in konstanter Zeit, nach dem Setup verworfen. Prüfung und INSERT laufen in einer Transaktion mit `pg_advisory_xact_lock` und erneuter Prüfung. Auf eine DB-Constraint (eindeutiger Index auf `((true))`) wurde bewusst verzichtet: Das Datenmodell ist mandantenfähig (`user_id` überall), die IDOR-Tests legen absichtlich einen zweiten Benutzer an, und die Setup-Route ist der einzige Pfad, der Benutzer anlegt.
- Beleg: `apps/api/src/auth/routes.ts:166-193`. Jeder unauthentifizierte Client darf `POST /api/auth/setup` aufrufen, solange `count(*) FROM "user" = 0`. Prüfung (`:172-176`) und INSERT (`:178-181`) laufen ohne Transaktion oder Lock, und `"user"` hat nur `email UNIQUE` (`packages/db/src/migrations/0001_users_devices_sessions.ts:11`), keine Single-Row-Constraint.
- Angriff: (a) Zwischen `docker compose up` (Caddy holt sofort ein Zertifikat, die Domain steht damit öffentlich in den CT-Logs) und der Einrichtung durch den Betreiber legt ein Scanner den Benutzer an und gehört dann zur Instanz. (b) Zwei parallele Setup-Requests mit verschiedenen E-Mails erzeugen zwei Benutzer. Damit bricht die Single-User-Annahme (u. a. `/api/auth/status` → `needsSetup=false`, zweiter Account ist dauerhaft vorhanden).
- Minimaler Fix: Ein einmaliges `SETUP_TOKEN` in `.env` erzeugen (`scripts/setup-env.mjs`), das `setup` verlangt, oder Setup nur ab Loopback/per CLI erlauben. Check und INSERT in eine Transaktion mit `LOCK TABLE "user" IN EXCLUSIVE MODE` oder `pg_advisory_xact_lock`. Optional ein Unique-Index auf einen konstanten Ausdruck (`CREATE UNIQUE INDEX ON "user" ((true))`).

**M2 – Brute-Force-Schutz nur pro IP; mit IPv6 oder verteilt umgehbar**

- **Status:** teilweise. Fehlgeschlagene Logins und Passwortwechsel werden als Security-Event geloggt (`auth.login_failed`, `auth.password_change_failed`, Feld `lockedOut`) – ohne E-Mail, Passwort und IP; die Zuordnung zur Client-Adresse läuft über die Request-ID des Access-Logs. Ein globaler bzw. kontobezogener Zähler wurde bewusst nicht gebaut (siehe Abweichungen).
- Beleg: `apps/api/src/auth/lockout.ts:19-42` (Map nach `ip`), `apps/api/src/security/rate-limit.ts:67` (`${rule.name}|${ip}`), Aufruf `routes.ts:196,209,217,228`.
- Angriff: Ein Angreifer mit einem IPv6-/64-Präfix (Standard bei jedem VPS) oder einem Botnetz rotiert die Quelladresse. Jede Adresse bekommt 5 Versuche pro 15 min, die Anzahl der Adressen ist praktisch unbegrenzt. Es gibt keine kontobezogene Drosselung, und die einzige zu erratende E-Mail ist meist bekannt. Argon2id und ≥ 10 Zeichen bremsen, aber ASVS 2.2.1 verlangt Schutz unabhängig von der Quelle. Nebeneffekt: Jedes Argon2-Verify (19 MiB, CPU) läuft unauthentifiziert. Viele parallele Login-Versuche erzeugen also CPU-Last auf dem Pi. _(Unsicher: ob hash-wasm den Event-Loop blockiert und wie stark, wurde nicht gemessen.)_
- Minimaler Fix: IPv6-Adressen für Lockout und Rate-Limit auf /64 normalisieren. Zusätzlich ein globaler bzw. benutzerbezogener Zähler (z. B. > 20 Fehlversuche/15 min → exponentielles Delay für alle Login-Versuche). Fehlgeschlagene Logins und Lockouts als Security-Event loggen (ohne Passwort).

**M3 – SSRF-Schutz per IPv6-Literal umgehbar (v4-mapped in Langform)**

- **Status:** behoben in `7210395` (vollständige IPv6-Normalisierung, eingebettete IPv4 geprüft, Teredo gesperrt). Hosts beim Anlegen/Ändern eines Kontos müssen jetzt ein Hostname oder IP-Literal sein (`parseHostName` in `accounts.ts`, Test in `apps/api/test/accounts.test.ts`).
- Beleg: `packages/shared/src/ssrf.ts:41-43` übernimmt IP-Literale unverändert, `isPublicIpv6` (`:87-124`) prüft nur das Präfix `::ffff:`. Hosts aus `POST/PATCH /api/accounts` werden nur getrimmt und kleingeschrieben (`apps/api/src/mail/accounts.ts:136-150`), ohne Format-Prüfung und ohne Normalisierung.
- Verifiziert (`node --experimental-strip-types`): `isPublicIp('0:0:0:0:0:ffff:127.0.0.1') === true`, `'0::ffff:10.0.0.1' → true`, `'::0:ffff:a00:1' → true`, `'0:0:0:0:0:ffff:ac12:2' → true` (172.18.0.2). Zum Vergleich: `'::ffff:127.0.0.1' → false`.
- Angriff: Der eingeloggte Nutzer, eine übernommene Session oder ein manipulierter Konfig-Import (danach PATCH mit Passwort) setzt `imap.host = "0:0:0:0:0:ffff:172.18.0.5"` und einen beliebigen Port. Die api und der Worker verbinden sich dann mit internen Diensten im Compose-Netz oder LAN (postgres:5432, Router-Admin, Metadaten-Dienste). Möglich sind Port-Scan über die Fehlercodes `CONNECTION_REFUSED`/`TIMEOUT` und Banner-Leaks über `UNKNOWN: ${text}` (`connection-test.ts:73`). _(Unsicher: Ein Connect auf eine v4-mapped-Adresse braucht IPv6-Sockets im Container. In dieser Sandbox kam `EAFNOSUPPORT`, im Docker-Default gehen IPv6-Sockets meist trotzdem.)_ Push-Endpoints sind nicht betroffen, weil `URL.hostname` normalisiert.
- Minimaler Fix: In `isPublicIp` das IPv6-Literal kanonisieren, etwa über `new net.SocketAddress({address, family:'ipv6'}).address` oder die vorhandene `expandIpv6()`, und danach `::ffff:0:0/96`, `::/96` (IPv4-compatible) und `2001::/32` (Teredo) prüfen. Alternativ mit `net.BlockList` (`addSubnet('::ffff:0:0', 96, 'ipv6')` usw.) arbeiten, das IPv6-Formate selbst normalisiert. Zusätzlich Hosts in `accounts.ts` per `HOST_RE` wie in `config-transfer.ts:48` validieren. Am robustesten: nach der Prüfung mit der **aufgelösten** IP verbinden (siehe N1).

### Niedrig

**N1 – DNS-Rebinding-TOCTOU bei Mail-Hosts und Push-Endpoints**

- **Status:** behoben. Mail-Hosts in `7210395` (Verbindung zur geprüften Adresse, Hostname als TLS-`servername`). Push-Endpoints: Versand über `node:https` mit eigenem Socket-`lookup` (`checkedLookup` in `push-notify.ts`), der den Host genau einmal auflöst, jede Adresse prüft und nur eine geprüfte Adresse an die Verbindung gibt; TLS prüft weiter gegen den Hostnamen.
- Beleg: `connection-test.ts:80` prüft per `assertPublicHost(config.host)`, danach löst `new ImapFlow({ host: config.host })` (`:82-84`) den Namen erneut auf. Dasselbe Muster in `worker/src/ports.ts:17-19` + Jobs und in `push-notify.ts:218` + `fetch(details.endpoint)` (`:229`).
- Angriff: Ein Angreifer-DNS mit TTL 0 liefert zuerst eine öffentliche, dann eine interne Adresse. Damit sind die gleichen Ziele erreichbar wie in M3 (Push: HTTPS-POST an ein internes Ziel, Antwort wird verworfen).
- Fix: Die von `assertPublicHost` zurückgegebene Adresse für die Verbindung verwenden (`host: resolved[0].address`, `servername: originalHost` für TLS/SNI) oder ein eigenes `lookup` an `net.connect` bzw. undici `connect` übergeben.

**N2 – Beliebige Ziel-Ports für Mail-Hosts**

- **Status:** behoben. `@fma/shared/mail-transport` lässt nur IMAP 143/993 und SMTP 25/465/587/2525 zu (`isAllowedMailPort`), geprüft vor DNS-Auflösung und Verbindung für jeden Verbindungstest, Sync, Versand, IDLE und jede Suche; der Konfig-Import lehnt andere Ports ab. Weitere Ports gibt der Betreiber per `MAIL_EXTRA_PORTS` frei. Fehlercode `BLOCKED_PORT`. Tests: `apps/worker/test/starttls-required.test.ts`, `apps/api/test/connection-test-tls.test.ts`.
- Beleg: `accounts.ts:118-120` (1–65535). `security.md` (Tabelle „SSRF") verspricht „nur erlaubte Ports".
- Angriff: Port-Scan öffentlicher Hosts über die api bzw. den Server des Betreibers (Abuse-Meldungen an dessen IP).
- Fix: Allowlist (IMAP 143/993, SMTP 25/465/587, optional 2525) mit Konfig-Ausnahme, oder die Doku anpassen.

**N3 – Kein zentraler Error-Handler: interne Fehlermeldungen und 500 bei Typfehlern**

- **Status:** behoben in Paket B. Zentraler `setErrorHandler` (`apps/api/src/app.ts`): 4xx → generischer Statustext, 5xx → `{ "message": "Internal error" }`; geloggt werden nur Fehlername, -code, Status und Stack-Frames (ohne Message). `DELETE /api/auth/devices/:id` prüft die UUID (→ 404), `POST /api/accounts` prüft die Laufzeittypen aller Felder (→ 400). Fastify-JSON-Schemas bleiben mittelfristig offen.
- Beleg: `apps/api/src/app.ts:50-61` ohne `setErrorHandler`. Beispiele: `DELETE /api/auth/devices/:id` reicht eine Nicht-UUID an Postgres durch (`auth/routes.ts:312-327` → `sessions.ts:146-151`) → `22P02` → 500. `POST /api/accounts` mit `imap.host: 1` → `imap.host.trim is not a function` (`accounts.ts:122-138`, Body nur per TS-Typ „validiert").
- Auswirkung: Der Fastify-Default schickt bei 500 `error.message` an den Client (DB-/Stack-Interna), und das pino-Error-Log enthält pg-Felder wie `detail` (z. B. `Key (...)=(...)`), die die Redaction-Pfade nicht abdecken. _(Unsicher: Ob ein konkreter Pfad heute Mailinhalte in `detail` schreibt, wurde nicht gefunden.)_
- Fix: `app.setErrorHandler`: bei `statusCode >= 500` nur `{ message: 'Interner Fehler' }` und im Log nur `err.code`/`name`/Stack wie `describeJobError` im Worker. Mittelfristig Fastify-JSON-Schemas für die Bodies.

**N4 – `console.warn` mit vollem Fehlerobjekt umgeht die Log-Redaction**

- **Status:** behoben in `7210395`.
- Beleg: `apps/api/src/mail/connection-test.ts:114` (`console.warn('[connection-test] imap error:', err)`).
- Auswirkung: Das ImapFlow-Fehlerobjekt (inkl. `response`/`responseText` des Servers, Host) landet unredigiert und nicht als JSON im Log. Ein Passwort ist darin nach Code-Lage nicht enthalten. Server können aber Benutzername/Adresse in der Antwort spiegeln. Das widerspricht Prinzip 6 und dem einheitlichen Log-Format.
- Fix: `request.log.warn({ errName, errCode, accountErrorCode, stack: frames }, ...)` wie `describeJobError` (`worker/src/runner.ts:402-424`), den Logger als Parameter übergeben.

**N5 – Supply Chain: keine Abhängigkeitsprüfung, Images nicht gepinnt**

- **Status:** behoben. Paket B: `.github/dependabot.yml` (npm/pnpm gruppiert, GitHub Actions, Docker, Compose; wöchentlich) und `permissions: contents: read` in `ci.yml`. Dazu jetzt `pnpm audit --prod --audit-level=high` als blockierender CI-Schritt. Die zwei Advisories ohne Patch (`node-forge` über `listhen`, `braces` über `micromatch`) betreffen nur die Nuxt-Build-Werkzeuge von `apps/web` – das Web-Image liefert nur statische Dateien mit nginx aus – und sind mit Begründung in `pnpm-workspace.yaml` (`auditConfig.ignoreGhsas`) ausgenommen. Images bleiben bewusst ohne Digest (siehe Abweichungen).
- Beleg: `.github/workflows/ci.yml` ohne `pnpm audit`/SCA, kein `dependabot.yml`. `docker-compose.yml` nutzt `caddy:2-alpine`, `postgres:17-alpine`, Dockerfiles `node:24-alpine`, `nginx:alpine`, ohne Digest. Die CI-Workflow-Datei setzt keinen `permissions:`-Block.
- Fix: Dependabot/Renovate für npm, Docker und GitHub Actions; `pnpm audit --prod` als (nicht blockierender) CI-Job; `permissions: contents: read`; optional Digests pinnen.

**N6 – AES-GCM ohne fixierte Tag-Länge**

- **Status:** behoben in `7210395`.
- Beleg: `packages/crypto/src/index.ts:82-84,112-114` (und `decryptBytes`): `createDecipheriv` ohne `{ authTagLength: 16 }`. Bei einem Ciphertext < 16 Byte nimmt `ct.subarray(ct.length - 16)` den ganzen Rest als (kürzeren) Tag. Node akzeptiert dann 4–15-Byte-Tags.
- Auswirkung: Ein Angreifer mit DB-Schreibzugriff könnte kurze Felder mit einem verkürzten Tag fälschen (z. B. 4 Byte → 2^32 Versuche). Das ist theoretisch, aber ein einfacher Härtungs-Fix.
- Fix: `createDecipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES })` und eine Mindestlänge `buf.length >= NONCE_BYTES + TAG_BYTES` prüfen.

**N7 – Kleinere Härtungen**

- Metrics-Token-Vergleich nicht konstantzeitig (`apps/api/src/app.ts:109`); im Netz praktisch nicht ausnutzbar. Fix: `timingSafeEqual` auf SHA-256-Digests. **Status:** behoben in `7210395`.
- Cookie ohne `__Host-`-Präfix (`auth/routes.ts:31`). Fix: `__Host-fma_session`, wenn `Secure` aktiv ist (Migration: altes Cookie einmalig mitlesen). **Status:** zurückgestellt (siehe Abweichungen).
- `MAIL_ALLOW_PRIVATE_HOSTS=1` schaltet SSRF-Schutz **und** TLS-Prüfung/STARTTLS ab (`connection-test.ts:37-39,89-91,137-138`, `worker/src/ports.ts:9-11`). `security.md` beschreibt die Freigabe interner Mailserver als Betreiber-Option. Wer sie nutzt, verliert unbemerkt auch die Transportverschlüsselung. Fix: getrennte Flags (`MAIL_ALLOW_PRIVATE_HOSTS` nur SSRF, `MAIL_TEST_MODE` für TLS) oder die Doku korrigieren. **Status:** offen; `security.md` warnt inzwischen ausdrücklich. **Behoben:** `MAIL_ALLOW_PRIVATE_HOSTS=1` erlaubt nur noch private Ziele (STARTTLS-Pflicht und Zertifikatsprüfung bleiben, per Compose durchgereicht); Klartext/ohne Zertifikatsprüfung und http-Push-Fakes nur mit `MAIL_INSECURE_TRANSPORT=1` (nur Dev/Test, nicht in Compose). Test: `apps/api/test/connection-test-tls.test.ts`.
- `Secure`-Cookie hängt an `DOMAIN != :80` (`auth/routes.ts:35-37`). Hinter einem eigenen TLS-Proxy mit `DOMAIN=:80` fehlt `Secure`. Fix: Doku-Hinweis oder `COOKIE_SECURE`-Override. **Status:** behoben: `COOKIE_SECURE=1` erzwingt `Secure` (`0` schaltet es ab), leer bleibt es automatisch; Test `apps/api/test/cookie-secure.test.ts`.

---

## 3. Bewusst akzeptierte Abweichungen

| ASVS                    | Abweichung                                                             | Begründung / Kompensation                                                                                                                                                                                                                                                                                                                          |
| ----------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.2.2, 2.4.x, 2.8 (MFA) | Keine Zwei-Faktor-Authentifizierung                                    | Single-User, Self-hosted (ADR-0004). Kompensation: Argon2id, Lockout, Rate-Limit, Geräteübersicht mit Widerruf. TOTP/WebAuthn als späteres Epic.                                                                                                                                                                                                   |
| 2.1.1                   | Mindestlänge 10 statt 12                                               | Bestehende Instanzen; Empfehlung: bei nächster Änderung auf 12 anheben (nur für neue Passwörter).                                                                                                                                                                                                                                                  |
| 2.1.7                   | Keine Prüfung gegen geleakte Passwörter                                | Self-hosted ohne externe Abhängigkeiten (Prinzip 1, keine HIBP-Abfrage); optional lokale Top-N-Liste.                                                                                                                                                                                                                                              |
| 2.5.x                   | Kein Passwort-Reset                                                    | Single-User; Reset nur per CLI/DB durch den Betreiber (dokumentieren).                                                                                                                                                                                                                                                                             |
| 3.3.2                   | Session 30 d absolut / 14 d Idle statt 12 h / 30 min                   | PWA mit Offline-Betrieb und Push braucht langlebige Sessions; Kompensation: 24-h-Rotation, Gerätebindung, Widerruf, Passwortwechsel beendet alle anderen Sessions.                                                                                                                                                                                 |
| 3.7.1                   | Keine Re-Auth vor Konto anlegen/löschen, Export, Geräte-Widerruf       | Einzelnutzer; Export enthält keine Secrets. Optional später Re-Auth für Konto-Löschung.                                                                                                                                                                                                                                                            |
| 14.4.3                  | PWA-CSP mit `style-src 'unsafe-inline'` und `img-src http: https:`     | Nötig für das `srcdoc`-iframe der HTML-Mails (erbt die App-CSP). Skripte bleiben per Hash-Allowlist, Sandbox und eigene iframe-CSP geschützt.                                                                                                                                                                                                      |
| 9.2.x (intern)          | api/worker ↔ postgres ohne TLS                                         | Internes Docker-Bridge-Netz, Port nur `127.0.0.1`.                                                                                                                                                                                                                                                                                                 |
| 7.1.3                   | Rate-Limit-/Lockout-Zähler nur In-Memory                               | Eine API-Instanz (Prinzip 9). Ein Neustart setzt die Zähler zurück, das ist akzeptiert.                                                                                                                                                                                                                                                            |
| 1.1.2                   | Threat Model noch offen                                                | Als eigenes Ticket nachziehen (`docs/architecture/threat-model.md`).                                                                                                                                                                                                                                                                               |
| 2.2.1 (M2)              | Lockout und Rate-Limit nur pro IP, kein globaler/kontobezogener Zähler | Single-User: Ein globaler Zähler wäre ein DoS-Hebel – jeder könnte den einzigen Benutzer aussperren. Kompensation: Argon2id, Mindestlänge, Rate-Limit, Security-Event-Logs (`auth.login_failed`) für Fail2ban o. Ä.                                                                                                                                |
| 3.4.4 (N7)              | Session-Cookie ohne `__Host-`-Präfix                                   | `__Host-` verlangt `Secure`; bei `DOMAIN=:80` (LAN-Test; hinter eigenem TLS-Proxy nur mit `COOKIE_SECURE=1`) gibt es kein `Secure`, das Cookie würde vom Browser verworfen. Eine Umbenennung meldet zudem alle Geräte ab (PWA mit Offline-Cache). Schutz durch `HttpOnly`, `SameSite=Strict`, `Path=/`, kein `Domain`-Attribut auf eigener Origin. |
| 10.3.2 (N5)             | Docker-Basis-Images per Tag statt Digest                               | Rebuilds auf dem Pi sollen Sicherheitsupdates der Basis-Images automatisch bekommen; Dependabot schlägt Tag-Updates vor. Release-Images sind signiert (`cosign`).                                                                                                                                                                                  |
| 2.2.x (M1)              | Setup-Code steht einmalig im Log                                       | Nur solange kein Benutzer existiert; danach wertlos. Wer die Logs lesen kann, hat ohnehin Zugriff auf den Server (und `.env`). Alternativ `SETUP_TOKEN` vorgeben, der nie geloggt wird.                                                                                                                                                            |
