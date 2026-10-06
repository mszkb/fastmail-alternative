# ADR-0008: Backend-Framework

- **Status:** Superseded by [ADR-0013](0013-php-backend.md)
- **Datum:** 2026-10-02
- **Roadmap:** 0.2, 1.1

## Kontext

Offen waren **Fastify** (Node/TypeScript) und **.NET**. Entscheidend sind die IMAP/SMTP-Bibliotheken, das Worker-Modell und gemeinsamer Code mit dem Frontend.

## Optionen

1. **Fastify (TypeScript)**: geteilte Typen mit dem Nuxt-Frontend im Monorepo; IMAP über `imapflow` (IDLE, CONDSTORE/QRESYNC, XOAUTH2), SMTP über `nodemailer`, MIME über `mailparser`.
2. **.NET (ASP.NET Core)**: sehr ausgereifte Bibliotheken `MailKit`/`MimeKit`, aber ein zweiter Sprach-Stack.

## Entscheidung

**Fastify mit TypeScript** für API und Worker. Das Frontend ist **Nuxt/Vue** (PWA). Beides liegt in einem Monorepo mit gemeinsamen Paketen für Typen, API-Vertrag und Domänenlogik.

## Konsequenzen

- Ein Sprach-Stack, und die Typen werden zwischen API und PWA geteilt.
- Der API-Vertrag wird als OpenAPI beschrieben, damit spätere native Clients (ADR-0010) daraus Clients generieren können.
- Migrationstool und weiteres Tooling werden in Phase 1 aus dem TypeScript-Ökosystem gewählt.
