<?php

declare(strict_types=1);

namespace Fma\Routes;

use Fma\Auth\Session;
use Fma\Config;
use Fma\Db\Uuid;
use Fma\Http\Body;
use Fma\Http\Json;
use Fma\Http\Middleware\RequireAuth;
use Fma\Push\InvalidSubscriptionException;
use Fma\Push\Subscriptions;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\App;

/**
 * /api/push/* (roadmap 4.3, ADR-0005):
 * - GET /api/push/vapid-public-key: the instance's VAPID public key or null;
 * - POST /api/push/subscriptions: this browser's PushSubscription for the
 *   current device (upsert by endpoint; 409 for another user's endpoint);
 * - DELETE /api/push/subscriptions (body: endpoint) for this browser,
 *   DELETE /api/push/subscriptions/{id} for the device management view;
 * - GET /api/push/subscriptions: without endpoints or keys.
 * Endpoints are capability URLs and are never logged.
 */
final class PushRoutes
{
    private const NOT_FOUND = 'Push-Subscription nicht gefunden.';

    public function __construct(
        private readonly Config $config,
        private readonly Subscriptions $subscriptions,
    ) {}

    /** @param App<\Psr\Container\ContainerInterface|null> $app */
    public function register(App $app, RequireAuth $requireAuth): void
    {
        $app->get('/api/push/vapid-public-key', $this->vapidPublicKey(...))->add($requireAuth);
        $app->get('/api/push/subscriptions', $this->list(...))->add($requireAuth);
        $app->post('/api/push/subscriptions', $this->create(...))->add($requireAuth);
        $app->delete('/api/push/subscriptions', $this->deleteByEndpoint(...))->add($requireAuth);
        $app->delete('/api/push/subscriptions/{id}', $this->deleteById(...))->add($requireAuth);
    }

    private function vapidPublicKey(Request $request, Response $response): Response
    {
        $key = $this->config->get('VAPID_PUBLIC_KEY');

        return Json::write($response, ['publicKey' => $key === '' ? null : $key]);
    }

    private function list(Request $request, Response $response): Response
    {
        $session = self::session($request);

        return Json::write($response, ['subscriptions' => $this->subscriptions->list($session->userId, $session->deviceId)]);
    }

    private function create(Request $request, Response $response): Response
    {
        try {
            $subscription = $this->subscriptions->validate(Body::json($request));
        } catch (InvalidSubscriptionException $e) {
            return Json::write($response, ['message' => $e->getMessage()], 400);
        }
        $session = self::session($request);
        $id = $this->subscriptions->save($session->userId, $session->deviceId, $subscription);
        if ($id === null) {
            return Json::write($response, ['message' => 'Push-Subscription gehört zu einem anderen Konto.'], 409);
        }

        return Json::write($response, ['id' => $id], 201);
    }

    private function deleteByEndpoint(Request $request, Response $response): Response
    {
        $endpoint = Body::string(Body::json($request), 'endpoint');
        if (!$this->subscriptions->deleteByEndpoint(self::session($request)->userId, $endpoint)) {
            return Json::write($response, ['message' => self::NOT_FOUND], 404);
        }

        return $response->withStatus(204);
    }

    /** @param array<string, string> $args */
    private function deleteById(Request $request, Response $response, array $args): Response
    {
        $id = strtolower($args['id'] ?? '');
        if (!Uuid::isValid($id) || !$this->subscriptions->deleteById(self::session($request)->userId, $id)) {
            return Json::write($response, ['message' => self::NOT_FOUND], 404);
        }

        return $response->withStatus(204);
    }

    private static function session(Request $request): Session
    {
        $session = $request->getAttribute('auth');
        if (!$session instanceof Session) {
            throw new \LogicException('route without RequireAuth');
        }

        return $session;
    }
}
