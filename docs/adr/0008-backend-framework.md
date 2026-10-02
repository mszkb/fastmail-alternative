# ADR-0008: Backend-Framework

- **Status:** Proposed
- **Datum:** 2026-10-02
- **Roadmap:** 0.2, 1.1

## Kontext

Die Roadmap lässt **Fastify** (Node/TypeScript) oder **.NET** offen. Entscheidend sind IMAP/SMTP-Bibliotheken, Worker-Modell, Teamkompetenz und gemeinsamer Code mit dem Frontend.

## Optionen

1. **Fastify (TypeScript)** – geteilte Typen mit Nuxt-Frontend im Monorepo; IMAP via `imapflow`, SMTP via `nodemailer`, MIME via `mailparser`. Ein Sprach-Stack.
2. **.NET (ASP.NET Core)** – sehr ausgereifte Mail-Bibliothek `MailKit`/`MimeKit`, starke Performance und Typisierung; zweiter Sprach-Stack neben dem Frontend.

## Entscheidung

Offen. Bewertungskriterien: Robustheit der IMAP-Bibliothek (IDLE, CONDSTORE/QRESYNC, OAuth), Speicherverbrauch bei vielen IMAP-Verbindungen, Teamerfahrung, Code-Sharing.

## Konsequenzen

- Bestimmt Monorepo-Tooling, Migrationstool (ADR-0002) und Queue-Bibliothek (ADR-0003).
