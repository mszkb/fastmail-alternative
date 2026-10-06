<?php

declare(strict_types=1);

namespace Fma\Tests\Integration;

use Fma\Config;
use Fma\Db\Database;
use Fma\Db\Sequence;
use Fma\Db\Uuid;

/** The ported schema (migrations/0001_schema.sql) keeps PostgreSQL's constraints. */
final class SchemaTest extends DatabaseTestCase
{
    private \PDO $pdo;

    protected function setUp(): void
    {
        $this->pdo = self::$db->pdo();
        $this->pdo->exec('DELETE FROM `user`');
    }

    /** @param list<mixed> $params */
    private function sql(string $sql, array $params = []): \PDOStatement
    {
        return Database::run($this->pdo, $sql, $params);
    }

    private function user(string $email = 'Me@Example.org'): string
    {
        $id = Uuid::v4();
        $this->sql('INSERT INTO `user` (id, email, password_hash) VALUES (?, ?, ?)', [$id, $email, 'x']);

        return $id;
    }

    private function account(string $userId): string
    {
        $id = Uuid::v4();
        $this->sql(
            'INSERT INTO mail_account (id, user_id, display_name, email_address, imap_host, imap_port, smtp_host,
               smtp_port, wrapped_dek, key_id, credential_enc) VALUES (?, ?, ?, ?, ?, 993, ?, 465, ?, ?, ?)',
            [$id, $userId, 'Konto', 'a@example.org', 'imap.example.org', 'smtp.example.org', 'fma.k1.x', 'v1', 'fma.f1.x'],
        );

        return $id;
    }

    private function assertDuplicate(callable $insert): void
    {
        try {
            $insert();
            self::fail('expected a duplicate key error');
        } catch (\PDOException $e) {
            self::assertSame('23000', $e->getCode());
        }
    }

    public function testUserEmailIsUniqueCaseInsensitively(): void
    {
        $this->user('Me@Example.org');
        self::assertSame('Me@Example.org', $this->sql('SELECT email FROM `user` WHERE email_lower = LOWER(?)', ['me@EXAMPLE.org'])->fetchColumn());
        $this->assertDuplicate(fn() => $this->user('me@example.ORG'));
        // Unlike *_ci collations, accents still count (citext semantics).
        $this->user('mé@example.org');
        self::assertSame(2, (int) $this->sql('SELECT COUNT(*) FROM `user`')->fetchColumn());
    }

    public function testIdentityAddressUniquePerAccountIgnoringCase(): void
    {
        $account = $this->account($this->user());
        $insert = fn(string $address) => $this->sql(
            'INSERT INTO identity (id, account_id, name, email_address) VALUES (?, ?, ?, ?)',
            [Uuid::v4(), $account, '', $address],
        );
        $insert('Alias@Example.org');
        $this->assertDuplicate(fn() => $insert('alias@example.org'));
        $insert('other@example.org');
        // Another account may use the same address.
        $other = $this->account((string) $this->sql('SELECT id FROM `user`')->fetchColumn());
        $this->sql('INSERT INTO identity (id, account_id, name, email_address) VALUES (?, ?, ?, ?)', [Uuid::v4(), $other, '', 'alias@example.org']);
        self::assertSame(3, (int) $this->sql('SELECT COUNT(*) FROM identity')->fetchColumn());
    }

    public function testDeletingAnAccountCascadesToMailData(): void
    {
        $account = $this->account($this->user());
        $folder = Uuid::v4();
        $message = Uuid::v4();
        $location = Uuid::v4();
        $thread = Uuid::v4();
        $this->sql('INSERT INTO folder (id, account_id, path) VALUES (?, ?, ?)', [$folder, $account, 'INBOX/Ordner ä']);
        $this->sql('INSERT INTO thread (id, account_id) VALUES (?, ?)', [$thread, $account]);
        $this->sql(
            'INSERT INTO message (id, account_id, message_id_header, `references`, subject_enc, from_enc, recipients_enc, snippet_enc, thread_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [$message, $account, '<a@example.org>', '["<r1@x>","<r2@x>"]', 's', 'f', 'r', 'n', $thread],
        );
        $this->sql('INSERT INTO message_reference (message_id, position, account_id, ref) VALUES (?, 0, ?, ?), (?, 1, ?, ?)', [$message, $account, '<r1@x>', $message, $account, '<r2@x>']);
        $this->sql('INSERT INTO message_location (id, message_id, folder_id, uidvalidity, uid) VALUES (?, ?, ?, 1, 42)', [$location, $message, $folder]);
        $this->sql('INSERT INTO message_flag (location_id, flag) VALUES (?, ?)', [$location, '\\Seen']);
        $this->sql('INSERT INTO message_body (message_id, storage_ref) VALUES (?, ?)', [$message, 'ab/cd']);
        $this->sql('INSERT INTO job (type, account_id, payload) VALUES (?, ?, ?)', ['message_sync', $account, '{"folderId":"x"}']);

        // Thread overlap lookup as in apps/worker/src/threading.ts ("references" && $refs).
        $found = $this->sql(
            'SELECT DISTINCT m.id FROM message m JOIN message_reference r ON r.message_id = m.id
             WHERE r.account_id = ? AND r.ref IN (?, ?)',
            [$account, '<r2@x>', '<zz@x>'],
        )->fetchAll(\PDO::FETCH_COLUMN);
        self::assertSame([$message], $found);
        self::assertSame(['<r1@x>', '<r2@x>'], json_decode((string) $this->sql('SELECT `references` FROM message')->fetchColumn(), true));

        $this->sql('DELETE FROM mail_account WHERE id = ?', [$account]);
        foreach (['folder', 'thread', 'message', 'message_reference', 'message_location', 'message_flag', 'message_body', 'job'] as $table) {
            self::assertSame(0, (int) $this->sql("SELECT COUNT(*) FROM {$table}")->fetchColumn(), $table);
        }
    }

    public function testMessageIdHeaderIsComparedByteWise(): void
    {
        $account = $this->account($this->user());
        $insert = fn(string $header) => $this->sql(
            'INSERT INTO message (id, account_id, message_id_header, subject_enc, from_enc, recipients_enc, snippet_enc) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [Uuid::v4(), $account, $header, 's', 'f', 'r', 'n'],
        );
        $insert('<Case@Example.org>');
        $insert('<case@example.org>');
        $this->assertDuplicate(fn() => $insert('<Case@Example.org>'));
    }

    public function testLongPushEndpointsAreUnique(): void
    {
        $user = $this->user();
        $device = Uuid::v4();
        $this->sql('INSERT INTO device (id, user_id, name, platform, installation_id) VALUES (?, ?, ?, ?, ?)', [$device, $user, 'iPhone', 'ios', Uuid::v4()]);
        $endpoint = 'https://web.push.apple.com/' . str_repeat('a', 2000);
        $insert = fn() => $this->sql(
            'INSERT INTO push_subscription (id, device_id, transport, endpoint, keys_enc) VALUES (?, ?, ?, ?, ?)',
            [Uuid::v4(), $device, 'webpush', $endpoint, 'k'],
        );
        $insert();
        $this->assertDuplicate($insert);
    }

    public function testOutboxClientIdUniqueOnlyWhenSet(): void
    {
        $account = $this->account($this->user());
        $insert = fn(?string $clientId) => $this->sql(
            'INSERT INTO outbox_message (id, account_id, message_id_header, client_id) VALUES (?, ?, ?, ?)',
            [Uuid::v4(), $account, '<m@x>', $clientId],
        );
        $insert(null);
        $insert(null);
        $client = Uuid::v4();
        $insert($client);
        $this->assertDuplicate(fn() => $insert($client));
    }

    public function testPlaceholderSequenceIsMonotonic(): void
    {
        $a = Sequence::next($this->pdo, 'message_location_placeholder');
        $b = Sequence::next($this->pdo, 'message_location_placeholder');
        self::assertSame($a + 1, $b);
        $this->expectException(\RuntimeException::class);
        Sequence::next($this->pdo, 'nope');
    }

    public function testJobsCanBeClaimedWithSkipLocked(): void
    {
        $this->sql('DELETE FROM job');
        $this->sql("INSERT INTO job (type, run_at) VALUES ('a', UTC_TIMESTAMP(6) - INTERVAL 1 SECOND), ('b', UTC_TIMESTAMP(6) - INTERVAL 1 SECOND)");
        $other = Database::connect(Config::fromArray(['DATABASE_URL' => self::$config->get('DATABASE_URL')]));
        $claim = 'SELECT id, type FROM job WHERE state = \'queued\' AND run_at <= UTC_TIMESTAMP(6)
                  ORDER BY run_at, id LIMIT 1 FOR UPDATE SKIP LOCKED';
        $this->pdo->beginTransaction();
        $other->beginTransaction();
        try {
            $first = Database::run($this->pdo, $claim)->fetch();
            $second = Database::run($other, $claim)->fetch();
            self::assertIsArray($first);
            self::assertIsArray($second);
            self::assertNotSame($first['id'], $second['id']);
        } finally {
            $this->pdo->rollBack();
            $other->rollBack();
        }
    }

    public function testTimestampsAreUtc(): void
    {
        $this->user();
        $diff = (int) $this->sql('SELECT TIMESTAMPDIFF(SECOND, created_at, UTC_TIMESTAMP(6)) FROM `user`')->fetchColumn();
        self::assertLessThan(5, abs($diff));
    }
}
