<?php

declare(strict_types=1);

namespace Fma\Tests\Integration;

use Fma\Backup\BackupException;
use Fma\Backup\InstanceBackup;
use Fma\Crypto\BackupDecryptException;
use Fma\Db\Database;
use Fma\Db\Uuid;

/** Backup and restore of database rows and mail files (#108). */
final class BackupTest extends DatabaseTestCase
{
    private string $dir;
    private string $dataDir;
    private string $masterKey;

    protected function setUp(): void
    {
        $this->dir = sys_get_temp_dir() . '/fma-backup-test-' . bin2hex(random_bytes(6));
        $this->dataDir = $this->dir . '/data';
        mkdir($this->dataDir . '/acc/msg', 0o700, true);
        $this->masterKey = base64_encode(random_bytes(32));
    }

    protected function tearDown(): void
    {
        exec('rm -rf ' . escapeshellarg($this->dir));
    }

    private function backup(?string $key = null): InstanceBackup
    {
        return new InstanceBackup(self::$db->pdo(), $key ?? $this->masterKey, $this->dataDir, __DIR__ . '/../../migrations');
    }

    private function wipe(): void
    {
        $pdo = self::$db->pdo();
        $pdo->exec('SET FOREIGN_KEY_CHECKS = 0');
        foreach (['user', 'device', 'session', 'mail_account', 'message', 'message_flag', 'job', 'attachment_upload', 'app_state', 'folder', 'message_location'] as $t) {
            $pdo->exec("DELETE FROM `{$t}`");
        }
        $pdo->exec('SET FOREIGN_KEY_CHECKS = 1');
        exec('rm -rf ' . escapeshellarg($this->dataDir) . ' && mkdir ' . escapeshellarg($this->dataDir));
    }

    /** @return array<string, array<mixed>> */
    private function snapshot(): array
    {
        $out = [];
        foreach (['user', 'device', 'session', 'mail_account', 'message', 'message_flag', 'job', 'attachment_upload', 'sequence_counter'] as $t) {
            $out[$t] = Database::run(self::$db->pdo(), "SELECT * FROM `{$t}` ORDER BY 1, 2")->fetchAll();
        }

        return $out;
    }

    private function fill(): void
    {
        $pdo = self::$db->pdo();
        $user = Uuid::v4();
        Database::run($pdo, 'INSERT INTO `user` (id, email, password_hash, totp_secret_enc) VALUES (?, ?, ?, ?)', [$user, 'Me@Example.org', '$argon2id$x', "\x00\xff\x80bin\n"]);
        $device = Uuid::v4();
        Database::run($pdo, "INSERT INTO device (id, user_id, name, platform, installation_id) VALUES (?, ?, 'Gerät ü', 'ios_pwa', ?)", [$device, $user, Uuid::v4()]);
        $s = $pdo->prepare("INSERT INTO session (id, device_id, token_hash, expires_at) VALUES (?, ?, ?, '2026-12-01 10:00:00.123456')");
        $s->bindValue(1, Uuid::v4());
        $s->bindValue(2, $device);
        $s->bindValue(3, random_bytes(32), \PDO::PARAM_LOB);
        $s->execute();
        $account = Uuid::v4();
        $a = $pdo->prepare("INSERT INTO mail_account (id, user_id, display_name, email_address, imap_host, imap_port, smtp_host, smtp_port, wrapped_dek, key_id, credential_enc, capabilities)
            VALUES (?, ?, 'K', 'a@example.org', 'imap.example.org', 993, 'smtp.example.org', 465, ?, 'v1', ?, '[\"IDLE\"]')");
        $a->bindValue(1, $account);
        $a->bindValue(2, $user);
        $a->bindValue(3, random_bytes(60), \PDO::PARAM_LOB);
        $a->bindValue(4, random_bytes(100), \PDO::PARAM_LOB);
        $a->execute();
        for ($i = 0; $i < 450; ++$i) {
            $m = $pdo->prepare("INSERT INTO message (id, account_id, message_id_header, subject_enc, from_enc, recipients_enc, snippet_enc, received_at) VALUES (?, ?, ?, ?, 'f', 'r', ?, '2026-10-01 12:34:56.789000')");
            $m->bindValue(1, Uuid::v4());
            $m->bindValue(2, $account);
            $m->bindValue(3, "<m{$i}@example.org>\xfe", \PDO::PARAM_LOB);
            $m->bindValue(4, random_bytes(40), \PDO::PARAM_LOB);
            $m->bindValue(5, random_bytes(20), \PDO::PARAM_LOB);
            $m->execute();
        }
        $u = $pdo->prepare("INSERT INTO attachment_upload (id, account_id, filename_enc, content_type, size_bytes, content_enc) VALUES (?, ?, 'n', 'application/octet-stream', 1, ?)");
        $u->bindValue(1, Uuid::v4());
        $u->bindValue(2, $account);
        $u->bindValue(3, random_bytes(3 * 1024 * 1024), \PDO::PARAM_LOB);
        $u->execute();
        Database::run($pdo, "INSERT INTO job (type, account_id, payload) VALUES ('folder_sync', ?, '{\"a\": 1}')", [$account]);
        // A location as a backup from before migration 0005 has it: no sort key.
        $folder = Uuid::v4();
        Database::run($pdo, "INSERT INTO folder (id, account_id, path) VALUES (?, ?, 'INBOX')", [$folder, $account]);
        Database::run($pdo, 'INSERT INTO message_location (id, message_id, folder_id, uidvalidity, uid) SELECT ?, id, ?, 1, 1 FROM message WHERE account_id = ? LIMIT 1', [Uuid::v4(), $folder, $account]);
        Database::run($pdo, "UPDATE sequence_counter SET value = 42 WHERE name = 'message_location_placeholder'");
        @mkdir($this->dataDir . '/acc/msg', 0o700, true);
        file_put_contents($this->dataDir . '/acc/msg/raw.eml.enc', random_bytes(200000));
        file_put_contents($this->dataDir . '/small', 'x');
        file_put_contents($this->dataDir . '/empty', '');
    }

    private function create(?InstanceBackup $backup = null): string
    {
        $file = $this->dir . '/fma-backup-test.fmabk';
        $out = fopen($file, 'wb');
        self::assertNotFalse($out);
        ($backup ?? $this->backup())->create($out);
        fclose($out);

        return $file;
    }

    public function testBackupWipeRestoreRoundtrip(): void
    {
        $this->wipe();
        $this->fill();
        $before = $this->snapshot();
        $raw = (string) file_get_contents($this->dataDir . '/acc/msg/raw.eml.enc');
        $file = $this->create();
        self::assertSame(1, $this->backup()->verify($file)['tables']['user']);

        // Not empty: refused without --force, data untouched.
        try {
            $this->backup()->restore($file);
            self::fail('expected refusal');
        } catch (BackupException $e) {
            self::assertStringContainsString('not empty', $e->getMessage());
        }

        $this->wipe();
        $summary = $this->backup()->restore($file);
        self::assertSame(450, $summary['tables']['message']);
        self::assertSame(3, $summary['files']);
        self::assertEquals($before, $this->snapshot());
        self::assertSame($raw, file_get_contents($this->dataDir . '/acc/msg/raw.eml.enc'));
        self::assertSame('', file_get_contents($this->dataDir . '/empty'));
        // Missing list sort keys are filled in.
        self::assertSame(0, (int) Database::run(self::$db->pdo(), 'SELECT COUNT(*) FROM message_location WHERE sort_at IS NULL')->fetchColumn());
        self::assertSame(1, (int) Database::run(self::$db->pdo(), 'SELECT COUNT(*) FROM message_location')->fetchColumn());

        // --force replaces a non-empty target.
        Database::run(self::$db->pdo(), "UPDATE mail_account SET display_name = 'changed'");
        file_put_contents($this->dataDir . '/extra', 'y');
        $this->backup()->restore($file, true);
        self::assertEquals($before, $this->snapshot());
        self::assertFileDoesNotExist($this->dataDir . '/extra');
    }

    public function testForceRestoreRebuildsASchemaFromANewerVersion(): void
    {
        $this->wipe();
        $this->fill();
        $before = $this->snapshot();
        $file = $this->create();
        // A newer version migrated the database (and changed a table) after the backup.
        $pdo = self::$db->pdo();
        Database::run($pdo, "INSERT INTO schema_migrations (name) VALUES ('9999_newer')");
        $pdo->exec('ALTER TABLE mail_account ADD COLUMN newer_column INT NULL');
        try {
            $this->backup()->restore($file);
            self::fail('expected refusal');
        } catch (BackupException $e) {
            self::assertStringContainsString('newer app version', $e->getMessage());
        }

        $this->backup()->restore($file, true);
        self::assertEquals($before, $this->snapshot());
        self::assertFalse(Database::run($pdo, "SELECT 1 FROM schema_migrations WHERE name = '9999_newer'")->fetchColumn());
        self::assertSame(0, (int) Database::run($pdo, "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'mail_account' AND column_name = 'newer_column'")->fetchColumn());
    }

    public function testRestoreAsRootHandsTheFilesToTheDirectoryOwner(): void
    {
        if (!\function_exists('posix_geteuid') || posix_geteuid() !== 0) {
            self::markTestSkipped('needs root');
        }
        $this->wipe();
        $this->fill();
        $file = $this->create();
        $this->wipe();
        chown($this->dataDir, 65534);
        chgrp($this->dataDir, 65534);
        $this->backup()->restore($file);
        foreach (['/acc', '/acc/msg', '/acc/msg/raw.eml.enc', '/small'] as $path) {
            self::assertSame(65534, fileowner($this->dataDir . $path), $path);
            self::assertSame(65534, filegroup($this->dataDir . $path), $path);
        }
    }

    public function testWrongKeyAndDamagedFilesFailWithoutTouchingTheDatabase(): void
    {
        $this->wipe();
        $this->fill();
        $file = $this->create();
        $this->wipe();
        $this->fill();
        $before = $this->snapshot();
        $data = (string) file_get_contents($file);
        $truncated = $this->dir . '/truncated.fmabk';
        file_put_contents($truncated, substr($data, 0, \strlen($data) - 100));
        $corrupt = $this->dir . '/corrupt.fmabk';
        $data[70000] = \chr(\ord($data[70000]) ^ 1);
        file_put_contents($corrupt, $data);

        foreach ([[$file, base64_encode(random_bytes(32))], [$truncated, null], [$corrupt, null]] as [$path, $key]) {
            try {
                $this->backup($key)->restore($path, true);
                self::fail('expected failure');
            } catch (BackupDecryptException $e) {
                self::assertStringContainsString('cannot be decrypted', $e->getMessage());
            }
            self::assertEquals($before, $this->snapshot());
            self::assertFileExists($this->dataDir . '/small');
        }
        $this->expectException(BackupDecryptException::class);
        $this->backup()->verify($truncated);
    }

    public function testPruneDeletesOldBackupsOnly(): void
    {
        foreach (['old' => 20, 'new' => 1] as $name => $days) {
            touch($this->dir . "/fma-backup-{$name}.fmabk", time() - $days * 86400);
        }
        touch($this->dir . '/other.txt', time() - 40 * 86400);
        self::assertSame(1, InstanceBackup::prune($this->dir, 14));
        self::assertFileExists($this->dir . '/fma-backup-new.fmabk');
        self::assertFileExists($this->dir . '/other.txt');
    }
}
