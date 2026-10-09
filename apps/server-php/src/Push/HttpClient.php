<?php

declare(strict_types=1);

namespace Fma\Push;

/** Minimal HTTPS POST for the fixed Google endpoints of FCM; tests inject a fake. */
interface HttpClient
{
    /**
     * @param array<string, string> $headers
     *
     * @return array{status: int, body: string}
     */
    public function post(string $url, array $headers, string $body): array;
}
