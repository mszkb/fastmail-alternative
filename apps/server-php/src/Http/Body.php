<?php

declare(strict_types=1);

namespace Fma\Http;

use Psr\Http\Message\ServerRequestInterface;
use Slim\Exception\HttpBadRequestException;

final class Body
{
    /**
     * The JSON request body as an array; an empty body is an empty array.
     * Invalid JSON answers 400 like Fastify's body parser.
     *
     * @return array<mixed>
     */
    public static function json(ServerRequestInterface $request): array
    {
        $raw = (string) $request->getBody();
        if (trim($raw) === '') {
            return [];
        }
        try {
            $data = json_decode($raw, true, 64, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            throw new HttpBadRequestException($request);
        }

        return \is_array($data) ? $data : [];
    }

    /** @param array<mixed> $body */
    public static function string(array $body, string $key): string
    {
        return isset($body[$key]) && \is_string($body[$key]) ? $body[$key] : '';
    }
}
