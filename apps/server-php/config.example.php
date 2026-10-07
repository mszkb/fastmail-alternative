<?php

declare(strict_types=1);

// Configuration for hosts without environment variables (ADR-0013).
// Copy to config.php OUTSIDE the web root (next to public/, not inside it),
// permissions 0600. Environment variables take precedence over this file.
// Variables: docs/operations/configuration.md. Never commit config.php.

return [
    // 32 random bytes, base64: php -r 'echo base64_encode(random_bytes(32)), PHP_EOL;'
    // Back it up separately - losing it makes all mails and credentials unreadable.
    'MASTER_KEY' => '',
    'MASTER_KEY_ID' => 'v1',

    // mysql://user:password@host:3306/database (URL-encode special characters)
    'DATABASE_URL' => '',

    'LOG_LEVEL' => 'info',
    'METRICS_TOKEN' => '',
];
