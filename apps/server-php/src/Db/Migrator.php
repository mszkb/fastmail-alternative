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
 *
 * A database that already carries migrations this code does not know
 * (a newer version ran against it, e.g. before a rollback without
 * restore) is refused with SchemaTooNewException instead of being used.
 */
final class Migrator
{
    private const LOCK = 'fma-migrations';

    /** The migrations shipped with this version. */
    public const DEFAULT_DIR = __DIR__ . '/../../migrations';

    /**
     * Migrations renamed after they shipped on a preview branch (old => new).
     * A database that recorded the old name counts as having the new one;
     * migrate() rewrites the record.
     */
    private const RENAMED = ['0006_native_client' => '0008_native_client'];

    public function __construct(private readonly \PDO $pdo, private readonly string $dir = self::DEFAULT_DIR) {}

    /**
     * Read-only check for entry points that do not migrate (cron, worker):
     * throws SchemaTooNewException if a newer version migrated the
     * database. A database without schema_migrations passes.
     */
    public function assertNotNewer(): void
    {
        $exists = Database::run(
            $this->pdo,
            "SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'schema_migrations'",
        )->fetchColumn();
        if ($exists === false) {
            return;
        }
        $this->assertKnown(self::renamed(array_map(
            static fn(mixed $name): string => (string) $name,
            Database::run($this->pdo, 'SELECT name FROM schema_migrations')->fetchAll(\PDO::FETCH_COLUMN),
        )));
    }

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
            foreach (self::RENAMED as $old => $new) {
                Database::run($this->pdo, 'UPDATE IGNORE schema_migrations SET name = ? WHERE name = ?', [$new, $old]);
                Database::run($this->pdo, 'DELETE FROM schema_migrations WHERE name = ?', [$old]);
            }
            $done = array_map(
                static fn(mixed $name): string => (string) $name,
                Database::run($this->pdo, 'SELECT name FROM schema_migrations')->fetchAll(\PDO::FETCH_COLUMN),
            );
            $this->assertKnown($done);
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
     * @param array<string> $names
     *
     * @return list<string>
     */
    private static function renamed(array $names): array
    {
        return array_values(array_map(static fn(string $name): string => self::RENAMED[$name] ?? $name, $names));
    }

    /** @param array<string> $done */
    private function assertKnown(array $done): void
    {
        $unknown = array_values(array_diff($done, array_keys($this->files())));
        if ($unknown !== []) {
            throw new SchemaTooNewException($unknown);
        }
    }

    /**
     * @param array<string> $done
     *
     * @return array<string, string> name => file
     */
    private function pending(array $done): array
    {
        return array_diff_key($this->files(), array_flip($done));
    }

    /** @return array<string, string> name => file, in name order */
    private function files(): array
    {
        $files = glob($this->dir . '/[0-9][0-9][0-9][0-9]_*.sql') ?: [];
        sort($files, SORT_STRING);
        $byName = [];
        foreach ($files as $file) {
            $byName[basename($file, '.sql')] = $file;
        }

        return $byName;
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
