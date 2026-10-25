<?php

declare(strict_types=1);

namespace Fma\Security;

final class RateLimitRule
{
    /**
     * @param string            $name   bucket name; rules with the same name share a counter
     * @param int               $max    requests per window and IP
     * @param string|null       $method HTTP method, null = every method
     * @param list<string>|null $routes Slim route patterns, null = every request
     */
    public function __construct(
        public readonly string $name,
        public readonly int $max,
        public readonly ?string $method = null,
        public readonly ?array $routes = null,
    ) {}

    /** Default rate limits per route group. */
    /** @return list<self> */
    public static function defaults(): array
    {
        return [
            // Generous ceiling for everything: the PWA syncs folders/lists in bursts.
            new self('global', 600),
            // Password guessing (on top of the lockout), password change, one-time setup.
            new self('auth', 10, 'POST', ['/api/auth/login', '/api/auth/setup', '/api/auth/password']),
            // Creating/updating an account tests the credentials at the provider.
            new self('account-test', 10, 'POST', ['/api/accounts']),
            new self('account-test', 10, 'PATCH', ['/api/accounts/{id}']),
            // Settings detection fetches documents from the address domain and the ISPDB (#165).
            new self('autoconfig', 30, 'GET', ['/api/autoconfig']),
            // Sending mail (an offline queue may replay several at once) and uploads.
            new self('send', 60, 'POST', ['/api/outbox', '/api/outbox/{id}/retry']),
            new self('upload', 60, 'POST', ['/api/accounts/{id}/uploads']),
            new self('import', 5, 'POST', ['/api/import/config']),
        ];
    }

    public function matches(string $method, string $route): bool
    {
        return ($this->method === null || $this->method === $method)
            && ($this->routes === null || \in_array($route, $this->routes, true));
    }
}
