<?php

declare(strict_types=1);

namespace Fma\Db;

/**
 * The database carries migrations this version does not know: it was
 * migrated by a newer version. Running older code against it could
 * corrupt data, so startup stops (restore a matching backup or upgrade).
 * The message holds only migration names, never connection details.
 */
final class SchemaTooNewException extends \RuntimeException
{
    /** @param list<string> $unknown */
    public function __construct(public readonly array $unknown)
    {
        parent::__construct('database schema is newer than this version (unknown migrations: ' . implode(', ', $unknown) . ')');
    }
}
