<?php

declare(strict_types=1);

namespace Fma\Tests\Support;

use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Slim\App;
use Slim\Psr7\Factory\ServerRequestFactory;

final class Http
{
    /**
     * @param array<string, string> $headers
     * @param array<string, string> $server
     */
    public static function request(string $method, string $path, array $headers = [], array $server = []): ServerRequestInterface
    {
        $request = (new ServerRequestFactory())->createServerRequest($method, 'http://mail.example.org' . $path, $server + ['REMOTE_ADDR' => '203.0.113.7']);
        $request = $request->withHeader('Host', 'mail.example.org');
        foreach ($headers as $name => $value) {
            $request = $request->withHeader($name, $value);
        }

        return $request;
    }

    /**
     * @param App<\Psr\Container\ContainerInterface|null> $app
     * @param array<string, string> $headers
     * @param array<string, string> $server
     */
    public static function call(App $app, string $method, string $path, array $headers = [], array $server = []): ResponseInterface
    {
        return $app->handle(self::request($method, $path, $headers, $server));
    }

    /** @return array<mixed> */
    public static function json(ResponseInterface $response): array
    {
        $data = json_decode((string) $response->getBody(), true, flags: JSON_THROW_ON_ERROR);
        \assert(\is_array($data));

        return $data;
    }

    /** @return resource */
    public static function memoryStream()
    {
        $stream = fopen('php://memory', 'w+b');
        \assert($stream !== false);

        return $stream;
    }

    public static function contents(mixed $stream): string
    {
        \assert(\is_resource($stream));
        rewind($stream);

        return (string) stream_get_contents($stream);
    }
}
