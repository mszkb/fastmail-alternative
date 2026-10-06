<?php

declare(strict_types=1);

namespace Fma\Migration;

use Fma\Db\Database;
use Fma\Log\Logger;

/**
 * One-time import of an existing installation from PostgreSQL (Node
 * backend, migrations 0001-0021) into the MySQL/MariaDB schema (#108).
 *
 * - Ids and encrypted values are copied unchanged: the AAD of every
 *   ciphertext contains the row id, so they stay readable with the same
 *   MASTER_KEY. Nothing is decrypted here.
 * - Arrays move into the MySQL replacements: message_location.flags ->
 *   message_flag rows, message.references -> JSON plus message_reference
 *   rows, other text[] -> JSON. Times are read in UTC.
 * - Finished jobs are not copied; queued, running (re-queued) and failed
 *   jobs are, so pending sends and actions survive.
 * - The target must be migrated (bin/migrate.php) and empty.
 * - Mail files (volume mail-data) are not in the database; copy them as
 *   they are (same relative paths in storage_ref).
 */
final class PostgresImporter
{
    private const BATCH = 500;

    /**
     * Tables in foreign-key order with the SELECT list for PostgreSQL;
     * columns not listed are copied as they are.
     */
    private const TABLES = [
        'user' => [],
        'device' => [],
        'session' => [],
        'push_subscription' => [],
        'mail_account' => ['capabilities' => 'array_to_json(capabilities)::text'],
        'identity' => [],
        'folder' => [],
        'thread' => [],
        'message' => ['references' => 'array_to_json("references")::text'],
        'message_location' => ['flags' => 'array_to_json(flags)::text'],
        'message_body' => [],
        'outbox_message' => ['references' => 'array_to_json("references")::text'],
        'draft' => ['references' => 'array_to_json("references")::text'],
        'attachment_upload' => [],
        'job' => ['payload' => 'payload::text'],
    ];
    /** Generated columns in MySQL: never inserted. */
    private const GENERATED = ['email_lower', 'email_address_lower', 'endpoint_hash'];

    public function __construct(
        private readonly \PDO $pg,
        private readonly \PDO $mysql,
        private readonly Logger $logger,
    ) {}

    /** PDO connection to PostgreSQL from a postgres:// URL (needs ext-pdo_pgsql). */
    public static function connectPostgres(#[\SensitiveParameter] string $url): \PDO
    {
        $parts = parse_url($url);
        if ($parts === false || !\in_array($parts['scheme'] ?? '', ['postgres', 'postgresql'], true)) {
            throw new \InvalidArgumentException('expected a postgres:// URL');
        }
        $dsn = \sprintf('pgsql:host=%s;port=%d;dbname=%s', $parts['host'] ?? 'localhost', $parts['port'] ?? 5432, ltrim($parts['path'] ?? '', '/'));
        $pdo = new \PDO($dsn, rawurldecode($parts['user'] ?? ''), rawurldecode($parts['pass'] ?? ''), [
            \PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION,
            \PDO::ATTR_DEFAULT_FETCH_MODE => \PDO::FETCH_ASSOC,
        ]);
        $pdo->exec("SET TIME ZONE 'UTC'");

        return $pdo;
    }

    /** @return array<string, int> copied rows per table */
    public function import(): array
    {
        if ((int) Database::run($this->mysql, 'SELECT COUNT(*) FROM `user`')->fetchColumn() > 0) {
            throw new \RuntimeException('target database is not empty');
        }
        $counts = [];
        $this->mysql->exec('SET FOREIGN_KEY_CHECKS = 0');
        try {
            foreach (array_keys(self::TABLES) as $table) {
                $counts[$table] = $this->copyTable($table);
                $this->logger->info('table imported', ['table' => $table, 'rows' => $counts[$table]]);
            }
            $sequence = Database::run($this->pg, 'SELECT last_value, is_called FROM message_location_placeholder_seq')->fetch();
            if (\is_array($sequence)) {
                $value = $sequence['is_called'] ? (int) $sequence['last_value'] : (int) $sequence['last_value'] - 1;
                Database::run($this->mysql, "UPDATE sequence_counter SET value = ? WHERE name = 'message_location_placeholder'", [$value]);
            }
        } finally {
            $this->mysql->exec('SET FOREIGN_KEY_CHECKS = 1');
        }

        return $counts;
    }

    private function copyTable(string $table): int
    {
        $targetColumns = array_values(array_diff($this->mysqlColumns($table), self::GENERATED));
        $expressions = self::TABLES[$table];
        $pgColumns = $this->pgColumns($table);
        // Same-named columns plus the converted arrays (flags has no MySQL column).
        $columns = array_values(array_unique([
            ...array_intersect($targetColumns, $pgColumns),
            ...array_intersect(array_keys($expressions), $pgColumns),
        ]));
        $select = implode(', ', array_map(
            static fn(string $c): string => ($expressions[$c] ?? '"' . $c . '"') . ' AS "' . $c . '"',
            $columns,
        ));
        $where = $table === 'job' ? " WHERE state <> 'done'" : '';
        $rows = Database::run($this->pg, "SELECT {$select} FROM \"{$table}\"{$where}");
        $batch = [];
        $count = 0;
        while (($row = $rows->fetch()) !== false) {
            /** @var array<string, mixed> $row */
            $batch[] = $this->convert($table, $row);
            if (\count($batch) >= self::BATCH) {
                $this->insertBatch($table, $batch);
                $count += \count($batch);
                $batch = [];
            }
        }
        if ($batch !== []) {
            $this->insertBatch($table, $batch);
            $count += \count($batch);
        }

        return $count;
    }

    /**
     * @param array<string, mixed> $row
     *
     * @return array<string, mixed>
     */
    private function convert(string $table, array $row): array
    {
        foreach ($row as $column => $value) {
            if (\is_resource($value)) {
                $row[$column] = stream_get_contents($value); // bytea
            } elseif (\is_bool($value)) {
                $row[$column] = $value ? 1 : 0;
            } elseif (\is_string($value) && preg_match('/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d+)?\+00$/', $value) === 1) {
                $row[$column] = substr($value, 0, -3); // timestamptz in UTC
            }
        }
        if ($table === 'job' && $row['state'] === 'running') {
            $row['state'] = 'queued';
            $row['locked_at'] = null;
        }

        return $row;
    }

    /** @param list<array<string, mixed>> $rows */
    private function insertBatch(string $table, array $rows): void
    {
        $this->mysql->beginTransaction();
        try {
            foreach ($rows as $row) {
                $flags = $references = null;
                if ($table === 'message_location') {
                    $flags = self::jsonList($row['flags'] ?? null);
                    unset($row['flags']);
                }
                if ($table === 'message') {
                    $references = self::jsonList($row['references'] ?? null);
                }
                foreach (['references', 'capabilities'] as $column) {
                    if (\array_key_exists($column, $row)) {
                        $row[$column] = json_encode(self::jsonList($row[$column]), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
                    }
                }
                $columns = array_keys($row);
                Database::run(
                    $this->mysql,
                    \sprintf('INSERT INTO `%s` (%s) VALUES (%s)', $table, implode(', ', array_map(static fn(string $c): string => "`{$c}`", $columns)), implode(', ', array_fill(0, \count($columns), '?'))),
                    array_values($row),
                );
                foreach ($flags ?? [] as $flag) {
                    Database::run($this->mysql, 'INSERT IGNORE INTO message_flag (location_id, flag) VALUES (?, ?)', [$row['id'], $flag]);
                }
                foreach ($references ?? [] as $position => $ref) {
                    Database::run($this->mysql, 'INSERT INTO message_reference (message_id, position, account_id, ref) VALUES (?, ?, ?, ?)', [$row['id'], $position, $row['account_id'], $ref]);
                }
            }
            $this->mysql->commit();
        } catch (\Throwable $e) {
            $this->mysql->rollBack();
            throw $e;
        }
    }

    /** @return list<string> */
    private static function jsonList(mixed $json): array
    {
        $list = \is_string($json) ? json_decode($json, true) : null;

        return \is_array($list) ? array_values(array_map('strval', array_filter($list, 'is_scalar'))) : [];
    }

    /** @return list<string> */
    private function mysqlColumns(string $table): array
    {
        return array_values(array_map('strval', Database::run($this->mysql, 'SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position', [$table])->fetchAll(\PDO::FETCH_COLUMN)));
    }

    /** @return list<string> */
    private function pgColumns(string $table): array
    {
        $stmt = Database::run($this->pg, "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ?", [$table]);

        return array_values(array_map('strval', $stmt->fetchAll(\PDO::FETCH_COLUMN)));
    }
}
