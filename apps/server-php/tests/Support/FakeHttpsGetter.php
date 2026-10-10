<?php

declare(strict_types=1);

namespace Fma\Tests\Support;

use Fma\Mail\HttpsGetter;

/** Canned HTTPS bodies by URL; records every request. */
final class FakeHttpsGetter implements HttpsGetter
{
    /** @var list<string> */
    public array $requested = [];

    /** @param array<string, string> $bodies */
    public function __construct(private readonly array $bodies) {}

    public function get(string $url, float $timeoutSeconds): ?string
    {
        $this->requested[] = $url;

        return $this->bodies[$url] ?? null;
    }
}
