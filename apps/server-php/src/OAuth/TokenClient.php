<?php

declare(strict_types=1);

namespace Fma\OAuth;

/** POST to a provider's token endpoint; tests inject a fake. */
interface TokenClient
{
    /**
     * @param array<string, string> $form application/x-www-form-urlencoded body
     *
     * @return array{status: int, body: array<string, mixed>}
     *
     * @throws OAuthException on network errors (code `network`)
     */
    public function post(string $url, #[\SensitiveParameter] array $form): array;
}
