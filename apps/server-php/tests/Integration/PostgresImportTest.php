<?php

declare(strict_types=1);

namespace Fma\Tests\Integration;

use Fma\Crypto\Envelope;
use Fma\Db\Database;
use Fma\Db\Uuid;
use Fma\Log\Logger;
use Fma\Migration\PostgresImporter;
use Fma\Migration\ReadabilityCheck;
use Fma\Tests\Support\Http;

/**
 * Import from PostgreSQL (#108). Needs POSTGRES_URL to a throwaway
 * database: its schema is the final schema of the former Node backend
 * (tests/fixtures/node-postgres-schema.sql), filled with encrypted test
 * data, then imported into MySQL.
 */
final class PostgresImportTest extends DatabaseTestCase
{
    private \PDO $pg;
    private string $masterKey;

    protected function setUp(): void
    {
        $url = getenv('POSTGRES_URL');
        if (!\is_string($url) || $url === '') {
            self::markTestSkipped('POSTGRES_URL not set');
        }
        $this->pg = PostgresImporter::connectPostgres($url);
        $this->pg->exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
        $this->pg->exec((string) file_get_contents(__DIR__ . '/../fixtures/node-postgres-schema.sql'));
        $this->masterKey = base64_encode(random_bytes(32));
    }

    /** @param list<mixed> $params */
    private function column(string $sql, array $params = []): mixed
    {
        return Database::run(self::$db->pdo(), $sql, $params)->fetchColumn();
    }

    public function testImportsAnInstallationAndEverythingStaysReadable(): void
    {
        $master = Envelope::loadMasterKey($this->masterKey);
        $pg = $this->pg;
        $user = Uuid::v4();
        $pg->prepare('INSERT INTO "user" (id, email, password_hash) VALUES (?, ?, ?)')->execute([$user, 'Me@Example.org', '$argon2id$x']);
        $device = Uuid::v4();
        $pg->prepare('INSERT INTO device (id, user_id, name, platform, installation_id) VALUES (?, ?, ?, ?, gen_random_uuid())')->execute([$device, $user, 'iPhone', 'ios_pwa']);
        $session = $pg->prepare('INSERT INTO session (device_id, token_hash, expires_at) VALUES (?, ?, now() + interval \'1 day\')');
        $session->bindValue(1, $device);
        $session->bindValue(2, hash('sha256', 't', true), \PDO::PARAM_LOB);
        $session->execute();

        $account = Uuid::v4();
        $dek = Envelope::generateDataKey();
        $stmt = $pg->prepare(
            "INSERT INTO mail_account (id, user_id, display_name, email_address, imap_host, imap_port, smtp_host, smtp_port,
               wrapped_dek, key_id, credential_enc, capabilities) VALUES (?, ?, 'K', 'a@example.org', 'imap.example.org', 993,
               'smtp.example.org', 465, convert_to(?, 'UTF8'), 'v1', convert_to(?, 'UTF8'), ARRAY['IMAP4REV1','IDLE'])",
        );
        $stmt->execute([$account, $user, Envelope::wrapDataKey($master, $dek, 'v1'), Envelope::encryptField($dek, '{"imapPassword":"p"}', Envelope::credentialAad($account))]);
        $folder = Uuid::v4();
        $pg->prepare("INSERT INTO folder (id, account_id, path) VALUES (?, ?, 'INBOX/Über')")->execute([$folder, $account]);
        $ids = [];
        for ($i = 0; $i < 3; ++$i) {
            $message = $ids[] = Uuid::v4();
            $pg->prepare(
                "INSERT INTO message (id, account_id, message_id_header, \"references\", subject_enc, from_enc, recipients_enc, snippet_enc, received_at)
                 VALUES (?, ?, ?, ARRAY['<r1@x>', ?], convert_to(?, 'UTF8'), 'f', 'r', 's', '2026-10-01 12:34:56.789+02')",
            )->execute([$message, $account, "<m{$i}@example.org>", "<r2-{$i}@x>", Envelope::encryptField($dek, "Betreff {$i} – ä", Envelope::messageFieldAad('subject', $message))]);
            $pg->prepare("INSERT INTO message_location (message_id, folder_id, uidvalidity, uid, flags) VALUES (?, ?, 1, ?, ARRAY['\\Seen', '\$Label1'])")
                ->execute([$message, $folder, $i + 1]);
        }
        $pg->exec("SELECT nextval('message_location_placeholder_seq'), nextval('message_location_placeholder_seq')");
        $pg->prepare("INSERT INTO job (type, account_id, payload, state) VALUES ('send_message', ?, '{\"outboxId\":\"o1\"}', 'running'), ('folder_sync', ?, '{}', 'done')")
            ->execute([$account, $account]);

        $counts = (new PostgresImporter($pg, self::$db->pdo(), new Logger('import', 'error', Http::memoryStream())))->import();

        self::assertSame(1, $counts['user']);
        self::assertSame(3, $counts['message']);
        self::assertSame(1, $counts['job'], 'done jobs are not copied');
        $my = self::$db->pdo();
        $q = $this->column(...);
        self::assertSame('Me@Example.org', $q('SELECT email FROM `user` WHERE email_lower = ?', ['me@example.org']));
        self::assertSame(hash('sha256', 't', true), $q('SELECT token_hash FROM session'));
        self::assertSame(['IMAP4REV1', 'IDLE'], json_decode((string) $q('SELECT capabilities FROM mail_account'), true));
        self::assertSame('INBOX/Über', $q('SELECT path FROM folder'));
        self::assertSame('2026-10-01 10:34:56.789000', $q('SELECT received_at FROM message WHERE id = ?', [$ids[0]]));
        self::assertSame(['<r1@x>', '<r2-0@x>'], json_decode((string) $q('SELECT `references` FROM message WHERE id = ?', [$ids[0]]), true));
        self::assertSame(6, (int) $q('SELECT COUNT(*) FROM message_reference'));
        self::assertSame(6, (int) $q('SELECT COUNT(*) FROM message_flag'));
        self::assertSame(3, (int) $q("SELECT COUNT(*) FROM message_flag WHERE flag = '\\\\Seen'"));
        self::assertSame(['queued', null], array_values((array) Database::run($my, 'SELECT state, locked_at FROM job')->fetch()));
        self::assertSame(2, (int) $q("SELECT value FROM sequence_counter WHERE name = 'message_location_placeholder'"));

        self::assertSame(['accounts' => 1, 'messages' => 3, 'unreadable' => 0], ReadabilityCheck::run($my, $this->masterKey));
        self::assertSame(['accounts' => 0, 'messages' => 0, 'unreadable' => 1], ReadabilityCheck::run($my, base64_encode(random_bytes(32))));

        $this->expectExceptionMessage('not empty');
        (new PostgresImporter($pg, $my, new Logger('import', 'error', Http::memoryStream())))->import();
    }
}
