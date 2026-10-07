<?php

declare(strict_types=1);

namespace Fma\Http;

use Fma\Log\Logger;
use Psr\Http\Message\ResponseFactoryInterface;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Slim\Exception\HttpException;

/**
 * Central error handler like registerErrorHandler in apps/api/src/app.ts:
 * clients only get a generic text for the status, the log gets class and
 * stack frames but never the message (driver messages may contain row
 * values).
 */
final class ErrorHandler
{
    public function __construct(
        private readonly ResponseFactoryInterface $responses,
        private readonly Logger $logger,
    ) {}

    public function __invoke(ServerRequestInterface $request, \Throwable $error): ResponseInterface
    {
        $status = $error instanceof HttpException ? $error->getCode() : 500;
        if ($status < 400 || $status >= 600) {
            $status = 500;
        }
        $fields = ['errName' => $error::class, 'errCode' => $error->getCode(), 'statusCode' => $status];
        $response = $this->responses->createResponse($status);
        if ($status >= 500) {
            $this->logger->error('request failed', $fields + ['stack' => self::frames($error)]);

            return Json::write($response, ['message' => 'Internal error'], $status);
        }
        $this->logger->info('request rejected', $fields);
        $response = Json::write($response, ['message' => $response->getReasonPhrase() ?: 'Bad request'], $status);
        if ($status === 405 && $error instanceof \Slim\Exception\HttpMethodNotAllowedException) {
            $response = $response->withHeader('Allow', implode(', ', $error->getAllowedMethods()));
        }

        return $response;
    }

    /** File:line frames only, no arguments. */
    private static function frames(\Throwable $error): string
    {
        $frames = [basename($error->getFile()) . ':' . $error->getLine()];
        foreach (\array_slice($error->getTrace(), 0, 9) as $frame) {
            $frames[] = ($frame['class'] ?? '') . ($frame['type'] ?? '') . $frame['function']
                . (isset($frame['file']) ? ' (' . basename($frame['file']) . ':' . ($frame['line'] ?? 0) . ')' : '');
        }

        return implode("\n", $frames);
    }
}
