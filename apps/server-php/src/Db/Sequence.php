<?php

declare(strict_types=1);

namespace Fma\Db;

/**
 * Replacement for PostgreSQL sequences (table `sequence_counter`): the
 * increment runs as a single atomic UPDATE, LAST_INSERT_ID(expr) hands the
 * new value to this connection only.
 */
final class Sequence
{
    public static function next(\PDO $pdo, string $name): int
    {
        $stmt = Database::run($pdo, 'UPDATE sequence_counter SET value = LAST_INSERT_ID(value + 1) WHERE name = ?', [$name]);
        if ($stmt->rowCount() !== 1) {
            throw new \RuntimeException("unknown sequence {$name}");
        }

        return (int) Database::run($pdo, 'SELECT LAST_INSERT_ID()')->fetchColumn();
    }
}
