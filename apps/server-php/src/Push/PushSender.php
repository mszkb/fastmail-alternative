<?php

declare(strict_types=1);

namespace Fma\Push;

/** Delivers one HTTP request to a push service; tests inject a fake. */
interface PushSender
{
    /**
     * POSTs `body` to `endpoint` and returns the HTTP status. Throws when
     * the request cannot be made (refused host, connection error, timeout).
     *
     * @param array<string, string> $headers
     */
    public function send(string $endpoint, array $headers, string $body): int;
}
