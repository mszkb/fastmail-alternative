<?php

declare(strict_types=1);

// Writes crypto-vectors-php.json, the committed snapshot that EnvelopeTest checks
// (testCommittedPhpVectorsAreCurrent). Regenerate only for an intended format change.
// Usage: php tests/fixtures/generate-php-vectors.php

require __DIR__ . '/../../vendor/autoload.php';

$json = json_encode(Fma\Tests\Support\CryptoVectors::generate(), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
file_put_contents(__DIR__ . '/crypto-vectors-php.json', $json . "\n");
