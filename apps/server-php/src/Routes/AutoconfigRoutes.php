<?php

declare(strict_types=1);

namespace Fma\Routes;

use Fma\Http\Json;
use Fma\Http\Middleware\RequireAuth;
use Fma\Mail\Autoconfig;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\App;

/**
 * GET /api/autoconfig?domain=example.org (#165): IMAP/SMTP settings for an
 * address domain without a provider preset, to pre-fill the account form.
 * Takes the domain only (never the address); nothing found is no error
 * (`found: false`). The domain is not logged.
 */
final class AutoconfigRoutes
{
    public function __construct(private readonly Autoconfig $autoconfig) {}

    /** @param App<\Psr\Container\ContainerInterface|null> $app */
    public function register(App $app, RequireAuth $requireAuth): void
    {
        $app->get('/api/autoconfig', $this->lookup(...))->add($requireAuth);
    }

    private function lookup(Request $request, Response $response): Response
    {
        $domain = $request->getQueryParams()['domain'] ?? null;
        $domain = \is_string($domain) ? strtolower(rtrim(trim($domain), '.')) : '';
        if (preg_match(Autoconfig::DOMAIN_RE, $domain) !== 1) {
            return Json::write($response, ['message' => 'Ungültige Domain.'], 400);
        }
        $result = $this->autoconfig->discover($domain);

        return Json::write($response, $result === null ? ['found' => false] : ['found' => true] + $result);
    }
}
