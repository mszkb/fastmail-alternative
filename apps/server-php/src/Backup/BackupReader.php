<?php

declare(strict_types=1);

namespace Fma\Backup;

/**
 * Push parser for the record stream of InstanceBackup (format: see there).
 * Gets the decrypted bytes piece by piece, checks structure, checksums and
 * manifest; with a target connection it also inserts the rows and writes
 * the files below the mail-data root. Memory: one record at a time.
 *
 * @internal
 */
final class BackupReader
{
    /** Upper bound for one record (a row record holds at least one row, i.e. one LONGBLOB). */
    private const MAX_RECORD_BYTES = 1 << 30;
    private const HEADER_BYTES = 5;

    private string $buffer = '';
    private string $state = 'start';
    /** @var array{createdAt: string, migrations: list<string>, tables: array<string, int>, files: int, bytes: int} */
    private array $summary = ['createdAt' => '', 'migrations' => [], 'tables' => [], 'files' => 0, 'bytes' => 0];
    /** @var list<array<string, int|string>> entries seen, in order */
    private array $seen = [];
    private int $manifestCount = 0;

    private string $table = '';
    /** @var list<string> */
    private array $columns = [];
    /** @var array<int, true> */
    private array $binary = [];
    private ?\PDOStatement $insert = null;
    private string $path = '';
    /** @var resource|null */
    private $file = null;
    private \HashContext $hash;
    private int $count = 0;

    /**
     * @param list<string>                                                  $tables      tables a backup may contain
     * @param list<string>                                                  $migrations  migrations this version knows
     * @param array<string, list<array{name: string, binary: bool}>>        $schema      target columns (restore only)
     */
    public function __construct(
        private readonly array $tables,
        private readonly array $migrations,
        private readonly array $schema,
        private readonly ?\PDO $target,
        private readonly string $root,
    ) {
        $this->hash = hash_init('sha256');
    }

    public function push(string $data): void
    {
        $this->buffer .= $data;
        $offset = 0;
        $available = \strlen($this->buffer);
        while ($available - $offset >= self::HEADER_BYTES) {
            /** @var array{1: int} $length */
            $length = unpack('N', $this->buffer, $offset + 1);
            if ($length[1] > self::MAX_RECORD_BYTES) {
                throw new BackupException('backup is corrupt (record too large)');
            }
            if ($available - $offset - self::HEADER_BYTES < $length[1]) {
                break;
            }
            $this->record($this->buffer[$offset], substr($this->buffer, $offset + self::HEADER_BYTES, $length[1]));
            $offset += self::HEADER_BYTES + $length[1];
        }
        $this->buffer = (string) substr($this->buffer, $offset);
    }

    /** @return array{createdAt: string, migrations: list<string>, tables: array<string, int>, files: int, bytes: int} */
    public function finish(): array
    {
        if ($this->state !== 'done' || $this->buffer !== '') {
            $this->closeFile();
            throw new BackupException($this->state === 'start' ? 'backup is empty' : 'backup is truncated (missing manifest)');
        }

        return $this->summary;
    }

    private function record(string $type, string $payload): void
    {
        switch ($this->state) {
            case 'start':
                if ($type !== 'H') {
                    throw new BackupException('backup is corrupt (missing header)');
                }
                $this->header(self::json($payload));
                $this->state = 'body';

                return;
            case 'body':
                match ($type) {
                    'T' => $this->beginTable(self::json($payload)),
                    'F' => $this->beginFile(self::json($payload)),
                    'M' => $this->manifest(self::json($payload)),
                    default => throw new BackupException('backup is corrupt (unexpected record)'),
                };

                return;
            case 'table':
                match ($type) {
                    'R' => $this->rows($payload),
                    'E' => $this->endTable(self::json($payload)),
                    default => throw new BackupException('backup is corrupt (unexpected record)'),
                };

                return;
            case 'file':
                match ($type) {
                    'D' => $this->fileData($payload),
                    'E' => $this->endFile(self::json($payload)),
                    default => throw new BackupException('backup is corrupt (unexpected record)'),
                };

                return;
            case 'manifest':
                match ($type) {
                    'M' => $this->manifest(self::json($payload)),
                    'Z' => $this->trailer(self::json($payload)),
                    default => throw new BackupException('backup is truncated (missing manifest trailer)'),
                };

                return;
            default:
                throw new BackupException('backup is corrupt (data after manifest)');
        }
    }

    /** @param array<mixed> $header */
    private function header(array $header): void
    {
        if (($header['format'] ?? null) !== InstanceBackup::FORMAT || ($header['version'] ?? null) !== InstanceBackup::VERSION
            || !\is_array($header['migrations'] ?? null) || !\is_string($header['createdAt'] ?? null)) {
            throw new BackupException('unsupported backup format/version');
        }
        $migrations = array_map(static fn(mixed $m): string => \is_string($m) ? $m : '', $header['migrations']);
        if (array_diff($migrations, $this->migrations) !== []) {
            throw new BackupException('backup comes from a newer app version (unknown migrations); update the app first');
        }
        $this->summary['createdAt'] = $header['createdAt'];
        $this->summary['migrations'] = array_values($migrations);
    }

    /** @param array<mixed> $begin */
    private function beginTable(array $begin): void
    {
        $table = $begin['table'] ?? null;
        $columns = $begin['columns'] ?? null;
        $binary = $begin['binary'] ?? null;
        if (!\is_string($table) || !\is_array($columns) || !\is_array($binary) || $columns === []
            || array_filter($columns, 'is_string') !== $columns || array_filter($binary, 'is_string') !== $binary) {
            throw new BackupException('backup is corrupt (table header)');
        }
        if (!\in_array($table, $this->tables, true) || \array_key_exists($table, $this->summary['tables'])) {
            throw new BackupException('backup is corrupt (unknown or repeated table)');
        }
        /** @var list<string> $columns */
        $columns = array_values($columns);
        $this->table = $table;
        $this->columns = $columns;
        $this->binary = [];
        foreach ($columns as $i => $column) {
            if (\in_array($column, $binary, true)) {
                $this->binary[$i] = true;
            }
        }
        $this->insert = null;
        if ($this->target !== null) {
            $targetColumns = array_column($this->schema[$table] ?? [], 'name');
            if (array_diff($columns, $targetColumns) !== []) {
                throw new BackupException("backup does not match the database schema (table {$table})");
            }
            $this->insert = $this->target->prepare(\sprintf(
                'INSERT INTO `%s` (%s) VALUES (%s)',
                $table,
                implode(', ', array_map(static fn(string $c): string => "`{$c}`", $columns)),
                implode(', ', array_fill(0, \count($columns), '?')),
            ));
        }
        $this->hash = hash_init('sha256');
        $this->count = 0;
        $this->state = 'table';
    }

    private function rows(string $payload): void
    {
        hash_update($this->hash, $payload);
        $rows = self::json($payload);
        $width = \count($this->columns);
        $this->target?->beginTransaction();
        try {
            foreach ($rows as $row) {
                if (!\is_array($row) || \count($row) !== $width || !array_is_list($row)) {
                    throw new BackupException('backup is corrupt (row)');
                }
                foreach ($row as $i => $value) {
                    if ($value !== null && !\is_scalar($value)) {
                        throw new BackupException('backup is corrupt (row)');
                    }
                    if (isset($this->binary[$i]) && $value !== null) {
                        $decoded = \is_string($value) ? base64_decode($value, true) : false;
                        if ($decoded === false) {
                            throw new BackupException('backup is corrupt (binary value)');
                        }
                        $row[$i] = $decoded;
                    }
                }
                if ($this->insert !== null) {
                    foreach ($row as $i => $value) {
                        $type = match (true) {
                            $value === null => \PDO::PARAM_NULL,
                            isset($this->binary[$i]) => \PDO::PARAM_LOB,
                            \is_int($value), \is_bool($value) => \PDO::PARAM_INT,
                            default => \PDO::PARAM_STR,
                        };
                        $this->insert->bindValue($i + 1, \is_float($value) ? (string) $value : $value, $type);
                    }
                    $this->insert->execute();
                }
                ++$this->count;
            }
            $this->target?->commit();
        } catch (\Throwable $e) {
            if ($this->target?->inTransaction() === true) {
                $this->target->rollBack();
            }
            throw $e;
        }
    }

    /** @param array<mixed> $end */
    private function endTable(array $end): void
    {
        $sha256 = hash_final($this->hash);
        if (($end['rows'] ?? null) !== $this->count || ($end['sha256'] ?? null) !== $sha256) {
            throw new BackupException('backup checksum mismatch');
        }
        $this->summary['tables'][$this->table] = $this->count;
        $this->seen[] = ['kind' => 'table', 'table' => $this->table, 'rows' => $this->count, 'sha256' => $sha256];
        $this->insert = null;
        $this->state = 'body';
    }

    /** @param array<mixed> $begin */
    private function beginFile(array $begin): void
    {
        $rel = $begin['path'] ?? null;
        if (!\is_string($rel) || !self::safePath($rel)) {
            throw new BackupException('backup is corrupt (invalid file path)');
        }
        foreach ($this->seen as $entry) {
            if (($entry['path'] ?? null) === $rel) {
                throw new BackupException('backup is corrupt (repeated file)');
            }
        }
        $this->path = $rel;
        if ($this->target !== null) {
            $path = $this->root . '/' . $rel;
            $dir = \dirname($path);
            if (!is_dir($dir) && !@mkdir($dir, 0o700, true) && !is_dir($dir)) {
                throw new BackupException('writing a restored file failed (directory)');
            }
            $file = @fopen($path, 'xb');
            if ($file === false) {
                throw new BackupException('writing a restored file failed');
            }
            @chmod($path, 0o600);
            $this->file = $file;
        }
        $this->hash = hash_init('sha256');
        $this->count = 0;
        $this->state = 'file';
    }

    private function fileData(string $payload): void
    {
        hash_update($this->hash, $payload);
        $this->count += \strlen($payload);
        if ($this->file !== null && fwrite($this->file, $payload) !== \strlen($payload)) {
            $this->closeFile();
            throw new BackupException('writing a restored file failed (disk full?)');
        }
    }

    /** @param array<mixed> $end */
    private function endFile(array $end): void
    {
        $this->closeFile();
        $sha256 = hash_final($this->hash);
        if (($end['size'] ?? null) !== $this->count || ($end['sha256'] ?? null) !== $sha256) {
            throw new BackupException('backup checksum mismatch');
        }
        ++$this->summary['files'];
        $this->summary['bytes'] += $this->count;
        $this->seen[] = ['kind' => 'file', 'path' => $this->path, 'size' => $this->count, 'sha256' => $sha256];
        $this->state = 'body';
    }

    /** @param array<mixed> $part */
    private function manifest(array $part): void
    {
        $entries = $part['entries'] ?? null;
        if (!\is_array($entries)) {
            throw new BackupException('backup is corrupt (manifest)');
        }
        foreach ($entries as $entry) {
            $expected = $this->seen[$this->manifestCount] ?? null;
            if (!\is_array($entry) || $expected === null || $entry !== $expected) {
                throw new BackupException('backup manifest does not match its contents');
            }
            ++$this->manifestCount;
        }
        $this->state = 'manifest';
    }

    /** @param array<mixed> $trailer */
    private function trailer(array $trailer): void
    {
        if (($trailer['entries'] ?? null) !== $this->manifestCount || $this->manifestCount !== \count($this->seen)) {
            throw new BackupException('backup manifest does not match its contents');
        }
        $this->state = 'done';
    }

    private function closeFile(): void
    {
        if ($this->file !== null) {
            fclose($this->file);
            $this->file = null;
        }
    }

    /** Relative POSIX path without `..`, absolute parts, backslashes or NUL. */
    private static function safePath(string $rel): bool
    {
        if ($rel === '' || str_starts_with($rel, '/') || str_contains($rel, '\\') || str_contains($rel, "\0")) {
            return false;
        }
        foreach (explode('/', $rel) as $part) {
            if ($part === '' || $part === '.' || $part === '..') {
                return false;
            }
        }

        return true;
    }

    /** @return array<mixed> */
    private static function json(string $payload): array
    {
        try {
            $value = json_decode($payload, true, 512, JSON_THROW_ON_ERROR | JSON_BIGINT_AS_STRING);
        } catch (\JsonException) {
            throw new BackupException('backup is corrupt (invalid record)');
        }
        if (!\is_array($value)) {
            throw new BackupException('backup is corrupt (invalid record)');
        }

        return $value;
    }
}
