<?php

declare(strict_types=1);

namespace Fma\Backup;

/**
 * A problem the operator has to resolve (target not empty, corrupt backup,
 * newer version ...). Messages never contain keys, paths inside mail-data or
 * contents, so the CLI may print them.
 */
final class BackupException extends \RuntimeException {}
