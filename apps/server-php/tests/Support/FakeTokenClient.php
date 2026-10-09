<?php

declare(strict_types=1);

namespace Fma\Tests\Support;

use Fma\OAuth\OAuthException;
use Fma\OAuth\TokenClient;

/** Records token requests and answers them from a queue (default: a fresh access token). */
final class FakeTokenClient implements TokenClient
{
    /** @var list<array{url: string, form: array<string, string>}> */
    public array $requests = [];
    /** @var list<array{status: int, body: array<string, mixed>}|'network'> */
    public array $responses = [];

    /**
     * An id_token with the given claims (unsigned, like the flow reads it).
     *
     * @param array<string, mixed> $claims
     */
    public static function idToken(array $claims): string
    {
        $part = static fn(string $json): string => rtrim(strtr(base64_encode($json), '+/', '-_'), '=');

        return $part('{"alg":"none"}') . '.' . $part(json_encode($claims, JSON_THROW_ON_ERROR)) . '.sig';
    }

    /** @param array<string, mixed> $body */
    public function respond(int $status, array $body): self
    {
        $this->responses[] = ['status' => $status, 'body' => $body];

        return $this;
    }

    public function post(string $url, #[\SensitiveParameter] array $form): array
    {
        $this->requests[] = ['url' => $url, 'form' => $form];
        $next = array_shift($this->responses) ?? ['status' => 200, 'body' => ['access_token' => 'access-' . \count($this->requests), 'expires_in' => 3600]];
        if ($next === 'network') {
            throw new OAuthException('network');
        }

        return $next;
    }
}
