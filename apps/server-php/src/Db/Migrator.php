<?php

declare(strict_types=1);

namespace Fma\Db;

/**
 * Migration runner for MySQL/MariaDB (ADR-0013): plain SQL files `migrations/NNNN_name.sql`,
 * applied in name order, recorded in `schema_migrations`, serialized with
 * GET_LOCK so parallel starts (api + cron) do not race.
 *
 * MySQL commits DDL implicitly, so a migration is not atomic: every
 * statement must be safe to re-run (IF NOT EXISTS etc.), then a failed
 * migration can simply be applied again after fixing the cause.
 */
final class Migrator
{
    private const LOCK = 'fma-migrations';

    public function __construct(private readonly \PDO $pdo, private readonly string $dir) {}

    /** @return list<string> names applied in this run */
    public function migrate(): array
    {
        $locked = Database::run($this->pdo, 'SELECT GET_LOCK(?, 60)', [self::LOCK])->fetchColumn();
        if ((int) $locked !== 1) {
            throw new \RuntimeException('could not acquire the migration lock');
        }
        try {
            $this->pdo->exec(
                'CREATE TABLE IF NOT EXISTS schema_migrations (
                   name VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
                   applied_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                 ) ENGINE=InnoDB',
            );
            $done = array_map(
                static fn(mixed $name): string => (string) $name,
                Database::run($this->pdo, 'SELECT name FROM schema_migrations')->fetchAll(\PDO::FETCH_COLUMN),
            );
            $applied = [];
            foreach ($this->pending($done) as $name => $file) {
                foreach (self::statements((string) file_get_contents($file)) as $sql) {
                    $this->pdo->exec($sql);
                }
                $this->pdo->prepare('INSERT INTO schema_migrations (name) VALUES (?)')->execute([$name]);
                $applied[] = $name;
            }

            return $applied;
        } finally {
            Database::run($this->pdo, 'SELECT RELEASE_LOCK(?)', [self::LOCK]);
        }
    }

    /**
     * @param array<string> $done
     *
     * @return array<string, string> name => file
     */
    private function pending(array $done): array
    {
        $files = glob($this->dir . '/[0-9][0-9][0-9][0-9]_*.sql') ?: [];
        sort($files, SORT_STRING);
        $pending = [];
        foreach ($files as $file) {
            $name = basename($file, '.sql');
            if (!\in_array($name, $done, true)) {
                $pending[$name] = $file;
            }
        }

        return $pending;
    }

    /**
     * Splits a migration file into statements: `;` at the end of a line ends
     * a statement; `--` comment lines are dropped.
     *
     * @return list<string>
     */
    public static function statements(string $sql): array
    {
        $statements = [];
        $current = '';
        foreach (preg_split('/\R/', $sql) ?: [] as $line) {
            if (preg_match('/^\s*--/', $line) === 1) {
                continue;
            }
            $current .= $line . "\n";
            if (preg_match('/;\s*$/', $line) === 1) {
                $statement = trim(rtrim(trim($current), ';'));
                if ($statement !== '') {
                    $statements[] = $statement;
                }
                $current = '';
            }
        }
        if (trim($current) !== '') {
            $statements[] = trim($current);
        }

        return $statements;
    }
}
