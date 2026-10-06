<?php

declare(strict_types=1);

namespace Fma\Http;

use Psr\Http\Message\ResponseInterface;

final class Json
{
    public static function write(ResponseInterface $response, mixed $data, int $status = 200): ResponseInterface
    {
        $response->getBody()->write(json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR));

        return $response->withStatus($status)->withHeader('Content-Type', 'application/json; charset=utf-8');
    }
}
