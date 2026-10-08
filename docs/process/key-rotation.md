# Key-Rotation (Master-Key)

Der `MASTER_KEY` (32 Byte, base64, siehe `.env`) verschlüsselt alle Data Keys (DEKs) der Instanz. Verschlüsselt werden damit Zugangsdaten und alle lesbaren Mailinhalte (siehe [Datenmodell → Verschlüsselung](../architecture/data-model.md#verschlüsselung)).

> **Wichtig:** Der `MASTER_KEY` muss getrennt vom Datenbank-Backup aufbewahrt werden. Geht er verloren, sind alle verschlüsselten Daten unlesbar.

## Design-Grundlage

- Ein **DEK pro Mailkonto** liegt als `mail_account.wrapped_dek` (verschlüsselt mit dem Master-Key) in der DB. Das Feld `mail_account.key_id` trägt die Master-Key-Version (z. B. `v1`).
- Ebenso ein **DEK pro Benutzer** für benutzerbezogene Secrets (Push-Subscription-Keys) in `` `user`.wrapped_dek `` / `` `user`.key_id ``; er wird bei der Rotation genauso neu verpackt.
- Inhalte (Betreff, Body, Zugangsdaten, …) sind **mit dem DEK** verschlüsselt, nicht direkt mit dem Master-Key.
- Eine Rotation ändert daher **nur die Wrapper**: DEKs werden mit dem neuen Master-Key neu verpackt. Die Inhalte selbst bleiben unangetastet.

Implementierung: `apps/server-php/src/Crypto/Envelope.php` (`wrapDataKey` / `unwrapDataKey`, AES-256-GCM; die `key_id` ist im Envelope als AAD gebunden).

## Ablauf der Rotation

1. **Neue Version erzeugen** und beide Keys parallel konfigurieren:

   ```env
   MASTER_KEY_ID=v2
   MASTER_KEY=<neuer 32-Byte-Base64-Key>
   MASTER_KEY_PREVIOUS=<alter Key>
   ```

2. **Neue Daten** ab sofort mit `v2` wrappen (Anwendungen lesen `MASTER_KEY_ID` + `MASTER_KEY`).
3. **Bestehende DEKs neu wrappen** (Wartungsmodus oder laufend, Transaktion pro Zeile):

   ```sql
   -- Re-Wrap geschieht in der Anwendung: unwrap mit altem Key
   -- (key_id aus der Zeile lesen), wrap mit dem neuen Key und neuer key_id.
   UPDATE mail_account SET wrapped_dek = :new_wrapped, key_id = 'v2' WHERE id = :id;
   UPDATE `user` SET wrapped_dek = :new_wrapped, key_id = 'v2' WHERE id = :id;
   ```

   Ein Hilfsskript dafür folgt mit Epic 2.1 (erst dann gibt es Konten mit DEKs).

4. **Verifizieren**, dass keine Zeile mehr die alte `key_id` trägt:

   ```sql
   SELECT count(*) FROM mail_account WHERE key_id <> 'v2';  -- muss 0 sein
   SELECT count(*) FROM `user` WHERE key_id <> 'v2';          -- muss 0 sein
   ```

5. **Aufräumen:** `MASTER_KEY_PREVIOUS` aus der `.env` entfernen, Instanz neu starten. Den alten Master-Key sicher vernichten; das Backup der `.env` entsprechend aktualisieren (neuer Master-Key, getrennt sichern!).

## Sonderfälle

- **Verlorener Master-Key ohne Backup:** nicht rekonstruierbar. Konten löschen (Crypto-Shredding) und neu verbinden; Inhalte bleiben verloren.
- **Verdacht auf Kompromittierung:** wie Rotation, aber zusätzlich alle **DEKs neu generieren** und Inhalte mit den neuen DEKs neu verschlüsseln – das ist teuer und kommt in Phase 6 (Hardening) als Werkzeug, falls benötigt.
- **Crypto-Shredding:** Beim Löschen eines Kontos wird der DEK mitgelöscht (`ON DELETE CASCADE`); restliche Ciphertexte (z. B. in alten Backups) sind damit dauerhaft unlesbar.
