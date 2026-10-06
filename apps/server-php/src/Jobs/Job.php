<?php

declare(strict_types=1);

namespace Fma\Jobs;

final class Job
{
    /** @param array<string, mixed> $payload */
    public function __construct(
        public readonly string $id,
        public readonly string $type,
        public readonly ?string $accountId,
        public readonly array $payload,
        public readonly int $attempts,
    ) {}
}
