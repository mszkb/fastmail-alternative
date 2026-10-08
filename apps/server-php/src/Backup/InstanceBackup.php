<?php

declare(strict_types=1);

namespace Fma\Backup;

use Fma\Crypto\Backup;
use Fma\Crypto\CryptoException;
use Fma\Crypto\Envelope;
use Fma\Db\Database;
use Fma\Db\Migrator;
use Fma\Jobs\Runner;

/**
 * Encrypted backup and restore of a PHP instance (#108), without mysqldump
 * (not available on shared hosting): a logical export of the database from
 * PHP plus the raw mail files, in the `fma.bk1` stream of
 * Fma\Crypto\Backup (key from MASTER_KEY + per-backup salt).
 *
 * Inside the encrypted stream: a sequence of records, each
 * `type[1 ASCII] | length[uint32 BE] | payload[length]`:
 *
 *   H header   JSON {format: "fma-backup-mysql", version: 1, createdAt,
 *              migrations: [schema_migrations names]}
 *   T table    JSON {table, columns: [...], binary: [...]}  begins a table
 *   R rows     JSON [[value, ...], ...] in column order, at most 200 rows /
 *              ~1 MiB per record; binary columns (BINARY, VARBINARY, *BLOB)
 *              as base64, so they roundtrip byte-exactly; NULL as null
 *   E end      table: JSON {rows, sha256}  sha256 over all R payloads
 *              file:  JSON {size, sha256}  sha256 over the file content
 *   F file     JSON {path}  relative POSIX path below MAIL_DATA_DIR
 *   D data     raw file bytes (<= 64 KiB per record)
 *   M manifest JSON {entries: [{kind: "table", table, rows, sha256} |
 *              {kind: "file", path, size, sha256}]}, after all tables and
 *              files, in blocks of 1000 entries
 *   Z trailer  JSON {entries}  total manifest entries (always last)
 *
 * Order: H, (T R* E) per table, (F D* E) per file, M+, Z. Exported are all
 * tables created in migrations/*.sql except runtime state (rate_limit,
 * login_lockout, metric_counter) and schema_migrations (whose names are in
 * the header); generated columns are left out.
 *
 * - Memory stays bounded: the tables are read unbuffered (one row at a
 *   time) inside one consistent-snapshot transaction, files in 64 KiB
 *   pieces, and the records go straight into the encryption stream.
 * - The runner lock (Runner::LOCK) is held during backup and restore, so no
 *   job changes database or files meanwhile.
 * - Restore runs the migrations, then checks the target is empty (or
 *   `force`), then verifies the whole backup (key, version, checksums,
 *   manifest) before it deletes or writes anything; then it writes rows
 *   and files, checking every checksum and the row counts again.
 * - Backups of a newer schema (unknown migration names) are refused;
 *   older ones are restored into the current schema.
 *
 * The MASTER_KEY is never part of a backup. Nothing here logs file names,
 * paths or contents.
 */
final class InstanceBackup
{
    public const FORMAT = 'fma-backup-mysql';
    public const VERSION = 1;
    /** Not backed up: runtime state, and the migration bookkeeping (header). */
    public const EXCLUDED_TABLES = ['rate_limit', 'login_lockout', 'metric_counter', 'schema_migrations'];
    /** Tables with rows even in a fresh instance: ignored by the emptiness check. */
    private const SEED_TABLES = ['sequence_counter', 'app_state'];
    public const FILE_PATTERN = 'fma-backup-*.fmabk';

    private const FILE_RECORD_BYTES = 65536;
    private const ROWS_PER_RECORD = 200;
    private const ROW_RECORD_BYTES = 1048576;
    private const MANIFEST_ENTRIES_PER_RECORD = 1000;
    private const LOCK_TIMEOUT_SECONDS = 120;
    private const JSON_FLAGS = JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION;
    private const BINARY_TYPES = ['binary', 'varbinary', 'tinyblob', 'blob', 'mediumblob', 'longblob'];

    private readonly string $masterKey;
    private readonly string $mailDataDir;
    private ?\PDOStatement $open = null;

    public function __construct(
        private readonly \PDO $pdo,
        #[\SensitiveParameter]
        string $masterKeyBase64,
        string $mailDataDir,
        private readonly string $migrationsDir,
    ) {
        if (trim($masterKeyBase64) === '') {
            throw new BackupException('MASTER_KEY is not set');
        }
        try {
            $this->masterKey = Envelope::loadMasterKey($masterKeyBase64);
        } catch (CryptoException) {
            throw new BackupException('MASTER_KEY is invalid: expected 32 bytes, base64-encoded');
        }
        $this->mailDataDir = rtrim($mailDataDir, '/\\') ?: '/';
    }

    /**
     * Writes an encrypted backup of database and mail files to `$out`.
     *
     * @param resource $out
     *
     * @return array{createdAt: string, migrations: list<string>, tables: array<string, int>, files: int, bytes: int}
     */
    public function create($out): array
    {
        $this->lock();
        $bufferedAttribute = self::bufferedQueryAttribute();
        $buffered = $this->pdo->getAttribute($bufferedAttribute);
        try {
            $summary = [
                'createdAt' => gmdate('Y-m-d\TH:i:s\Z'),
                'migrations' => $this->appliedMigrations(),
                'tables' => [],
                'files' => 0,
                'bytes' => 0,
            ];
            $tables = [];
            foreach ($this->existingTables() as $table) {
                $tables[$table] = $this->columns($table);
            }
            $this->pdo->exec('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
            $this->pdo->exec('START TRANSACTION WITH CONSISTENT SNAPSHOT');
            try {
                $this->pdo->setAttribute($bufferedAttribute, false);
                $records = $this->records($summary, $tables);
                $in = CallbackStream::reader(static function () use ($records): ?string {
                    if (!$records->valid()) {
                        return null;
                    }
                    $record = $records->current();
                    $records->next();

                    return $record;
                });
                try {
                    Backup::encryptStream($this->masterKey, $in, $out);
                } finally {
                    fclose($in);
                }
            } finally {
                $this->open?->closeCursor();
                $this->open = null;
                $this->pdo->setAttribute($bufferedAttribute, $buffered);
                $this->pdo->exec('COMMIT');
            }

            return $summary;
        } finally {
            $this->unlock();
        }
    }

    /**
     * Decrypts and checks a backup completely; touches neither database nor
     * files.
     *
     * @return array{createdAt: string, migrations: list<string>, tables: array<string, int>, files: int, bytes: int}
     */
    public function verify(string $file): array
    {
        return $this->read($file, null);
    }

    /**
     * Restores a backup into an empty instance (or replaces it with
     * `$force`); see the class comment for the order of the checks.
     *
     * @return array{createdAt: string, migrations: list<string>, tables: array<string, int>, files: int, bytes: int}
     */
    public function restore(string $file, bool $force = false): array
    {
        if (!is_file($file) || !is_readable($file)) {
            throw new BackupException('backup file not found or not readable');
        }
        $this->lock();
        try {
            (new Migrator($this->pdo, $this->migrationsDir))->migrate();
            $dbEmpty = $this->databaseIsEmpty();
            $dirEmpty = $this->directoryIsEmpty();
            if ((!$dbEmpty || !$dirEmpty) && !$force) {
                $what = implode(' and ', array_filter([$dbEmpty ? '' : 'database', $dirEmpty ? '' : 'mail-data']));
                throw new BackupException("restore target is not empty ({$what}); use --force to replace it");
            }
            // Full check before anything is deleted or written: a wrong key,
            // a newer version or a damaged file must not cost existing data
            // nor leave a half-restored instance.
            $this->read($file, null);

            $this->pdo->exec('SET FOREIGN_KEY_CHECKS = 0');
            try {
                foreach ($this->existingTables() as $table) {
                    $this->pdo->exec("DELETE FROM `{$table}`");
                }
                $this->clearDirectory();
                $summary = $this->read($file, $this->pdo);
            } finally {
                $this->pdo->exec('SET FOREIGN_KEY_CHECKS = 1');
            }
            foreach ($summary['tables'] as $table => $rows) {
                $count = (int) Database::run($this->pdo, "SELECT COUNT(*) FROM `{$table}`")->fetchColumn();
                if ($count !== $rows) {
                    throw new BackupException("restored row count does not match the manifest ({$table})");
                }
            }

            return $summary;
        } finally {
            $this->unlock();
        }
    }

    /**
     * Unsent outbox messages: after a restore they may already have been
     * sent after the backup was taken (docs/operations/upgrade.md).
     */
    public function pendingOutboxCount(): int
    {
        return (int) Database::run(
            $this->pdo,
            "SELECT COUNT(*) FROM outbox_message WHERE sent_at IS NULL AND status IN ('queued', 'sending')",
        )->fetchColumn();
    }

    /**
     * Deletes `fma-backup-*.fmabk` in `$dir` older than `$keepDays` days,
     * never `$keep` (the backup just written). `$keepDays` <= 0 keeps all.
     *
     * @return int number of deleted files
     */
    public static function prune(string $dir, int $keepDays, ?string $keep = null, ?int $now = null): int
    {
        if ($keepDays <= 0) {
            return 0;
        }
        $limit = ($now ?? time()) - $keepDays * 86400;
        $keepReal = $keep !== null ? realpath($keep) : false;
        $deleted = 0;
        foreach (glob(rtrim($dir, '/') . '/' . self::FILE_PATTERN) ?: [] as $file) {
            if (!is_file($file) || ($keepReal !== false && realpath($file) === $keepReal)) {
                continue;
            }
            $mtime = filemtime($file);
            if ($mtime !== false && $mtime < $limit && unlink($file)) {
                ++$deleted;
            }
        }

        return $deleted;
    }

    /**
     * Record stream of a backup; fills `$summary` on the way.
     *
     * @param array{createdAt: string, migrations: list<string>, tables: array<string, int>, files: int, bytes: int} $summary
     * @param array<string, list<array{name: string, binary: bool}>>                                                    $tables
     *
     * @return \Generator<int, string>
     */
    private function records(array &$summary, array $tables): \Generator
    {
        yield self::jsonRecord('H', [
            'format' => self::FORMAT,
            'version' => self::VERSION,
            'createdAt' => $summary['createdAt'],
            'migrations' => $summary['migrations'],
        ]);
        $manifest = [];
        foreach ($tables as $table => $columns) {
            $names = array_column($columns, 'name');
            $binary = array_keys(array_filter(array_column($columns, 'binary')));
            yield self::jsonRecord('T', [
                'table' => $table,
                'columns' => $names,
                'binary' => array_map(static fn(int $i): string => $names[$i], $binary),
            ]);
            $hash = hash_init('sha256');
            $rows = 0;
            $batch = [];
            $size = 0;
            $this->open = $this->pdo->query(\sprintf(
                'SELECT %s FROM `%s`',
                implode(', ', array_map(static fn(string $c): string => "`{$c}`", $names)),
                $table,
            )) ?: null;
            if ($this->open === null) {
                throw new BackupException("cannot read table {$table}");
            }
            while (($row = $this->open->fetch(\PDO::FETCH_NUM)) !== false) {
                foreach ($binary as $i) {
                    if (\is_string($row[$i])) {
                        $row[$i] = base64_encode($row[$i]);
                    }
                }
                $encoded = json_encode($row, self::JSON_FLAGS);
                $batch[] = $encoded;
                $size += \strlen($encoded);
                ++$rows;
                if (\count($batch) >= self::ROWS_PER_RECORD || $size >= self::ROW_RECORD_BYTES) {
                    $payload = '[' . implode(',', $batch) . ']';
                    hash_update($hash, $payload);
                    yield self::record('R', $payload);
                    $batch = [];
                    $size = 0;
                }
            }
            $this->open->closeCursor();
            $this->open = null;
            if ($batch !== []) {
                $payload = '[' . implode(',', $batch) . ']';
                hash_update($hash, $payload);
                yield self::record('R', $payload);
            }
            $sha256 = hash_final($hash);
            $summary['tables'][$table] = $rows;
            $manifest[] = ['kind' => 'table', 'table' => $table, 'rows' => $rows, 'sha256' => $sha256];
            yield self::jsonRecord('E', ['rows' => $rows, 'sha256' => $sha256]);
        }

        foreach ($this->listFiles('') as $rel) {
            yield self::jsonRecord('F', ['path' => $rel]);
            $handle = fopen($this->mailDataDir . '/' . $rel, 'rb');
            if ($handle === false) {
                throw new BackupException('cannot read a file in mail-data');
            }
            $hash = hash_init('sha256');
            $size = 0;
            try {
                while (!feof($handle)) {
                    $data = fread($handle, self::FILE_RECORD_BYTES);
                    if ($data === false) {
                        throw new BackupException('cannot read a file in mail-data');
                    }
                    if ($data === '') {
                        continue;
                    }
                    hash_update($hash, $data);
                    $size += \strlen($data);
                    yield self::record('D', $data);
                }
            } finally {
                fclose($handle);
            }
            $sha256 = hash_final($hash);
            ++$summary['files'];
            $summary['bytes'] += $size;
            $manifest[] = ['kind' => 'file', 'path' => $rel, 'size' => $size, 'sha256' => $sha256];
            yield self::jsonRecord('E', ['size' => $size, 'sha256' => $sha256]);
        }

        foreach (array_chunk($manifest, self::MANIFEST_ENTRIES_PER_RECORD) as $entries) {
            yield self::jsonRecord('M', ['entries' => $entries]);
        }
        yield self::jsonRecord('Z', ['entries' => \count($manifest)]);
    }

    /**
     * Decrypts and parses a backup; with `$target` it also writes rows and
     * files.
     *
     * @return array{createdAt: string, migrations: list<string>, tables: array<string, int>, files: int, bytes: int}
     */
    private function read(string $file, ?\PDO $target): array
    {
        $in = @fopen($file, 'rb');
        if ($in === false) {
            throw new BackupException('backup file not found or not readable');
        }
        $known = $this->knownTables();
        $columns = [];
        foreach ($known as $table) {
            $columns[$table] = $target !== null ? $this->columns($table) : [];
        }
        $reader = new BackupReader($known, $this->knownMigrations(), $columns, $target, $this->mailDataDir);
        $out = CallbackStream::writer($reader->push(...));
        try {
            Backup::decryptStream($this->masterKey, $in, $out);
        } finally {
            fclose($out);
            fclose($in);
        }

        return $reader->finish();
    }

    /** @return list<string> tables to back up, from migrations/*.sql */
    private function knownTables(): array
    {
        $tables = [];
        foreach ($this->migrationFiles() as $file) {
            preg_match_all('/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?/i', (string) file_get_contents($file), $m);
            foreach ($m[1] as $table) {
                if (!\in_array($table, $tables, true) && !\in_array($table, self::EXCLUDED_TABLES, true)) {
                    $tables[] = $table;
                }
            }
        }

        return $tables;
    }

    /** @return list<string> */
    private function knownMigrations(): array
    {
        return array_map(static fn(string $f): string => basename($f, '.sql'), $this->migrationFiles());
    }

    /** @return list<string> */
    private function migrationFiles(): array
    {
        $files = glob($this->migrationsDir . '/[0-9][0-9][0-9][0-9]_*.sql') ?: [];
        sort($files, SORT_STRING);

        return $files;
    }

    /** @return list<string> known tables that exist in the database */
    private function existingTables(): array
    {
        $existing = array_map(
            'strval',
            Database::run($this->pdo, "SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'")->fetchAll(\PDO::FETCH_COLUMN),
        );

        return array_values(array_filter($this->knownTables(), static fn(string $t): bool => \in_array($t, $existing, true)));
    }

    /** @return list<array{name: string, binary: bool}> non-generated columns */
    private function columns(string $table): array
    {
        $rows = Database::run(
            $this->pdo,
            // EXTRA holds "STORED GENERATED"/"VIRTUAL GENERATED" on MySQL and MariaDB alike
            // (MySQL also has "DEFAULT_GENERATED" for expression defaults, which are real
            // columns); IS_GENERATED exists on MariaDB only.
            'SELECT column_name, data_type, extra FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position',
            [$table],
        )->fetchAll(\PDO::FETCH_NUM);
        $columns = [];
        foreach ($rows as $row) {
            /** @var array{0: string, 1: string, 2: string} $row */
            if (preg_match('/\b(STORED|VIRTUAL|PERSISTENT) GENERATED\b/i', (string) $row[2]) === 1) {
                continue;
            }
            $columns[] = ['name' => (string) $row[0], 'binary' => \in_array(strtolower((string) $row[1]), self::BINARY_TYPES, true)];
        }

        return $columns;
    }

    /** @return list<string> */
    private function appliedMigrations(): array
    {
        try {
            return array_values(array_map('strval', Database::run($this->pdo, 'SELECT name FROM schema_migrations ORDER BY name')->fetchAll(\PDO::FETCH_COLUMN)));
        } catch (\PDOException) {
            return [];
        }
    }

    private function databaseIsEmpty(): bool
    {
        foreach ($this->existingTables() as $table) {
            if (\in_array($table, self::SEED_TABLES, true)) {
                continue;
            }
            if (Database::run($this->pdo, "SELECT 1 FROM `{$table}` LIMIT 1")->fetchColumn() !== false) {
                return false;
            }
        }

        return true;
    }

    private function directoryIsEmpty(): bool
    {
        if (!is_dir($this->mailDataDir)) {
            return true;
        }

        return array_diff(scandir($this->mailDataDir) ?: [], ['.', '..']) === [];
    }

    private function clearDirectory(): void
    {
        if (!is_dir($this->mailDataDir)) {
            if (!@mkdir($this->mailDataDir, 0o700, true) && !is_dir($this->mailDataDir)) {
                throw new BackupException('cannot create MAIL_DATA_DIR');
            }

            return;
        }
        $items = new \RecursiveIteratorIterator(
            new \RecursiveDirectoryIterator($this->mailDataDir, \FilesystemIterator::SKIP_DOTS),
            \RecursiveIteratorIterator::CHILD_FIRST,
        );
        foreach ($items as $item) {
            /** @var \SplFileInfo $item */
            $ok = $item->isDir() && !$item->isLink() ? @rmdir($item->getPathname()) : @unlink($item->getPathname());
            if (!$ok) {
                throw new BackupException('cannot clear MAIL_DATA_DIR');
            }
        }
    }

    /**
     * Regular files below the mail-data root as sorted relative POSIX
     * paths; symlinks and special files are skipped (the app never writes
     * them).
     *
     * @return \Generator<int, string>
     */
    private function listFiles(string $relative): \Generator
    {
        $dir = $relative === '' ? $this->mailDataDir : $this->mailDataDir . '/' . $relative;
        if (!is_dir($dir)) {
            if ($relative === '') {
                return;
            }
            throw new BackupException('cannot read a directory in mail-data');
        }
        $entries = scandir($dir, SCANDIR_SORT_ASCENDING);
        if ($entries === false) {
            throw new BackupException('cannot read a directory in mail-data');
        }
        foreach ($entries as $name) {
            if ($name === '.' || $name === '..') {
                continue;
            }
            $rel = $relative === '' ? $name : $relative . '/' . $name;
            $path = $this->mailDataDir . '/' . $rel;
            if (is_link($path)) {
                continue;
            }
            if (is_dir($path)) {
                yield from $this->listFiles($rel);
            } elseif (is_file($path)) {
                yield $rel;
            }
        }
    }

    private function lock(): void
    {
        $locked = Database::run($this->pdo, 'SELECT GET_LOCK(?, ?)', [Runner::LOCK, self::LOCK_TIMEOUT_SECONDS])->fetchColumn();
        if ((int) $locked !== 1) {
            throw new BackupException('background jobs are still running (runner lock); try again later');
        }
    }

    private function unlock(): void
    {
        Database::run($this->pdo, 'SELECT RELEASE_LOCK(?)', [Runner::LOCK]);
    }

    private static function bufferedQueryAttribute(): int
    {
        // PHP 8.4 moved the driver constants to Pdo\Mysql (same value).
        return \defined('Pdo\Mysql::ATTR_USE_BUFFERED_QUERY')
            ? (int) \constant('Pdo\Mysql::ATTR_USE_BUFFERED_QUERY')
            : \PDO::MYSQL_ATTR_USE_BUFFERED_QUERY;
    }

    public static function record(string $type, string $payload): string
    {
        return $type . pack('N', \strlen($payload)) . $payload;
    }

    /** @param array<string, mixed> $value */
    private static function jsonRecord(string $type, array $value): string
    {
        return self::record($type, json_encode($value, self::JSON_FLAGS));
    }
}
