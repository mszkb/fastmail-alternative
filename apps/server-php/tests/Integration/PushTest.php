<?php

declare(strict_types=1);

namespace Fma\Tests\Integration;

use Fma\App;
use Fma\Auth\Sessions;
use Fma\Config;
use Fma\Crypto\Envelope;
use Fma\Db\Database;
use Fma\Db\Uuid;
use Fma\Jobs\Deadline;
use Fma\Jobs\Job;
use Fma\Log\Logger;
use Fma\Push\Fcm;
use Fma\Push\PushNotifyHandler;
use Fma\Push\PushNotifyQueue;
use Fma\Push\PushSender;
use Fma\Push\StreamPushSender;
use Fma\Push\Vapid;
use Fma\Push\WebPushCrypto;
use Fma\Tests\Support\FakeHttpClient;
use Fma\Tests\Support\Http;
use Psr\Http\Message\ResponseInterface;

/** Push subscription routes and the push_notify job. */
final class PushTest extends DatabaseTestCase
{
    /** @var \Slim\App<\Psr\Container\ContainerInterface|null> */
    private \Slim\App $app;
    private Config $cfg;
    private string $userId;
    private string $token;
    private string $deviceId;
    private \OpenSSLAsymmetricKey $uaKey;
    private string $p256dh;
    private string $auth;
    /** @var resource */
    private $log;

    protected function setUp(): void
    {
        $pdo = self::$db->pdo();
        foreach (['job', 'push_subscription', 'session', 'device', 'mail_account', '`user`'] as $table) {
            $pdo->exec("DELETE FROM {$table}");
        }
        $this->cfg = $this->config();
        $this->log = Http::memoryStream();
        $this->app = App::create($this->cfg, self::$db, new Logger('api', 'info', $this->log), []);
        $this->userId = $this->createUser('me@example.org');
        $this->token = (new Sessions(self::$db))->createDeviceWithSession($this->userId, 'Test', 'desktop');
        $this->deviceId = (string) Database::run($pdo, 'SELECT id FROM device WHERE user_id = ?', [$this->userId])->fetchColumn();
        $this->uaKey = WebPushCrypto::generateKey();
        $this->p256dh = WebPushCrypto::base64UrlEncode(WebPushCrypto::publicPoint($this->uaKey));
        $this->auth = WebPushCrypto::base64UrlEncode(random_bytes(16));
    }

    /** @param array<string, string> $extra */
    private function config(array $extra = []): Config
    {
        static $masterKey = null;
        $masterKey ??= base64_encode(random_bytes(32));

        return Config::fromArray($extra + [
            'DATABASE_URL' => self::$config->get('DATABASE_URL'), 'DOMAIN' => 'mail.example.org', 'MASTER_KEY' => $masterKey,
            'VAPID_PUBLIC_KEY' => 'BPub', 'MAIL_INSECURE_TRANSPORT' => '1',
        ]);
    }

    private function createUser(string $email): string
    {
        $id = Uuid::v4();
        Database::run(self::$db->pdo(), 'INSERT INTO `user` (id, email, password_hash) VALUES (?, ?, ?)', [$id, $email, 'unused']);

        return $id;
    }

    /**
     * @param array<mixed>|null $body
     * @param \Slim\App<\Psr\Container\ContainerInterface|null>|null $app
     */
    private function call(string $method, string $path, ?array $body = null, ?string $token = null, ?\Slim\App $app = null): ResponseInterface
    {
        $request = Http::request($method, $path, ['Sec-Fetch-Site' => 'same-origin']);
        if ($body !== null) {
            $request->getBody()->write(json_encode($body, JSON_THROW_ON_ERROR));
            $request = $request->withHeader('Content-Type', 'application/json');
        }

        return ($app ?? $this->app)->handle($request->withCookieParams(['fma_session' => $token ?? $this->token]));
    }

    /** @return array<string, mixed> */
    private function subscription(string $endpoint = 'https://push.example.org/send/abc'): array
    {
        return ['endpoint' => $endpoint, 'keys' => ['p256dh' => $this->p256dh, 'auth' => $this->auth]];
    }

    public function testVapidPublicKey(): void
    {
        self::assertSame(['publicKey' => 'BPub'], Http::json($this->call('GET', '/api/push/vapid-public-key')));
        $app = App::create($this->config(['VAPID_PUBLIC_KEY' => '']), self::$db, new Logger('api', 'error', Http::memoryStream()), []);
        self::assertSame(['publicKey' => null], Http::json($this->call('GET', '/api/push/vapid-public-key', app: $app)));
        self::assertSame(401, Http::call($this->app, 'GET', '/api/push/vapid-public-key')->getStatusCode());
    }

    public function testSubscribeListAndDelete(): void
    {
        $created = $this->call('POST', '/api/push/subscriptions', $this->subscription());
        self::assertSame(201, $created->getStatusCode());
        $id = Http::json($created)['id'];
        self::assertIsString($id);

        // Keys are encrypted with the user DEK, which was created on demand.
        $row = Database::run(self::$db->pdo(), 'SELECT ps.endpoint, ps.keys_enc, u.wrapped_dek FROM push_subscription ps JOIN device d ON d.id = ps.device_id JOIN `user` u ON u.id = d.user_id')->fetch();
        self::assertIsArray($row);
        self::assertStringNotContainsString($this->p256dh, (string) $row['keys_enc']);
        $dek = Envelope::unwrapAccountKey($this->cfg->get('MASTER_KEY'), (string) $row['wrapped_dek']);
        self::assertSame(['p256dh' => $this->p256dh, 'auth' => $this->auth], json_decode(Envelope::decryptField($dek, (string) $row['keys_enc'], Envelope::pushKeysAad((string) $row['endpoint'])), true));

        // Upsert by endpoint: same id, failure state reset.
        Database::run(self::$db->pdo(), 'UPDATE push_subscription SET failure_count = 5, disabled_at = UTC_TIMESTAMP(6)');
        $again = $this->call('POST', '/api/push/subscriptions', $this->subscription());
        self::assertSame(['id' => $id], Http::json($again));

        $list = Http::json($this->call('GET', '/api/push/subscriptions'));
        self::assertCount(1, $list['subscriptions']);
        $item = $list['subscriptions'][0];
        self::assertSame(['id', 'deviceId', 'deviceName', 'platform', 'isCurrentDevice', 'pushService', 'createdAt', 'lastSuccessAt'], array_keys($item));
        self::assertSame('push.example.org', $item['pushService']);
        self::assertTrue($item['isCurrentDevice']);
        self::assertNull($item['lastSuccessAt']);
        self::assertStringNotContainsString('send/abc', json_encode($list, JSON_THROW_ON_ERROR));

        // Another user's endpoint is refused.
        $otherToken = (new Sessions(self::$db))->createDeviceWithSession($this->createUser('other@example.org'), 'X', 'desktop');
        $conflict = $this->call('POST', '/api/push/subscriptions', $this->subscription(), $otherToken);
        self::assertSame(409, $conflict->getStatusCode());
        self::assertSame(['message' => 'Push-Subscription gehört zu einem anderen Konto.'], Http::json($conflict));
        self::assertSame(404, $this->call('DELETE', "/api/push/subscriptions/{$id}", token: $otherToken)->getStatusCode());

        self::assertSame(404, $this->call('DELETE', '/api/push/subscriptions', ['endpoint' => 'https://push.example.org/other'])->getStatusCode());
        self::assertSame(204, $this->call('DELETE', '/api/push/subscriptions', ['endpoint' => 'https://push.example.org/send/abc'])->getStatusCode());
        $this->call('POST', '/api/push/subscriptions', $this->subscription());
        $newId = Http::json($this->call('GET', '/api/push/subscriptions'))['subscriptions'][0]['id'];
        self::assertSame(404, $this->call('DELETE', '/api/push/subscriptions/not-a-uuid')->getStatusCode());
        self::assertSame(204, $this->call('DELETE', '/api/push/subscriptions/' . strtoupper($newId))->getStatusCode());
        self::assertSame(['message' => 'Push-Subscription nicht gefunden.'], Http::json($this->call('DELETE', "/api/push/subscriptions/{$newId}")));
    }

    public function testValidation(): void
    {
        $strict = App::create($this->config(['MAIL_INSECURE_TRANSPORT' => '']), self::$db, new Logger('api', 'error', Http::memoryStream()), []);
        $cases = [
            [['keys' => []], 'Ungültiger Push-Endpoint.'],
            [$this->subscription('https://push.example.org/' . str_repeat('a', 2048)), 'Ungültiger Push-Endpoint.'],
            [$this->subscription('not a url'), 'Ungültiger Push-Endpoint.'],
            [$this->subscription('http://push.example.org/x'), 'Der Push-Endpoint muss eine https-URL sein.'],
            [$this->subscription('https://user:pw@push.example.org/x'), 'Der Push-Endpoint muss eine https-URL sein.'],
            [$this->subscription('https://127.0.0.1/x'), 'Der Push-Endpoint ist nicht erreichbar.'],
            [$this->subscription('https://[::1]/x'), 'Der Push-Endpoint ist nicht erreichbar.'],
            [['endpoint' => 'https://93.184.216.34/x', 'keys' => ['p256dh' => 'AAAA', 'auth' => $this->auth]], 'Ungültige Schlüssel der Push-Subscription.'],
            [['endpoint' => 'https://93.184.216.34/x', 'keys' => ['p256dh' => $this->p256dh, 'auth' => 'AAAA']], 'Ungültige Schlüssel der Push-Subscription.'],
        ];
        foreach ($cases as [$body, $message]) {
            $response = $this->call('POST', '/api/push/subscriptions', $body, app: $strict);
            self::assertSame(400, $response->getStatusCode(), $message);
            self::assertSame(['message' => $message], Http::json($response));
        }
        // Test mode: local http endpoints are allowed.
        self::assertSame(201, $this->call('POST', '/api/push/subscriptions', $this->subscription('http://127.0.0.1:9/x'))->getStatusCode());
    }

    private function vapid(): Vapid
    {
        $key = WebPushCrypto::generateKey();
        $details = openssl_pkey_get_details($key);
        self::assertIsArray($details);

        return new Vapid(WebPushCrypto::base64UrlEncode(WebPushCrypto::publicPoint($key)), WebPushCrypto::base64UrlEncode(str_pad($details['ec']['d'], 32, "\x00", STR_PAD_LEFT)), 'mailto:ops@example.org');
    }

    private function subscribe(string $endpoint): string
    {
        $response = $this->call('POST', '/api/push/subscriptions', $this->subscription($endpoint));
        self::assertSame(201, $response->getStatusCode());

        return (string) Http::json($response)['id'];
    }

    /** @return array{0: PushNotifyHandler, 1: object{calls: list<array{endpoint: string, headers: array<string, string>, body: string}>, statuses: list<int>}} */
    private function handler(?Vapid $vapid = null, int ...$statuses): array
    {
        $sender = new class (array_values($statuses)) implements PushSender {
            /** @var list<array{endpoint: string, headers: array<string, string>, body: string}> */
            public array $calls = [];

            /** @param list<int> $statuses */
            public function __construct(public array $statuses) {}

            public function send(string $endpoint, array $headers, string $body): int
            {
                $this->calls[] = ['endpoint' => $endpoint, 'headers' => $headers, 'body' => $body];

                return array_shift($this->statuses) ?? 201;
            }
        };

        return [new PushNotifyHandler(self::$db, $this->cfg, new Logger('worker', 'info', $this->log), $sender, $vapid ?? $this->vapid()), $sender];
    }

    private function decrypt(string $body): string
    {
        $salt = substr($body, 0, 16);
        $asPublic = substr($body, 21, 65);
        $uaPublic = WebPushCrypto::publicPoint($this->uaKey);
        $secret = (string) openssl_pkey_derive(WebPushCrypto::publicKeyFromPoint($asPublic), $this->uaKey, 32);
        $ikm = hash_hkdf('sha256', $secret, 32, "WebPush: info\x00" . $uaPublic . $asPublic, (string) WebPushCrypto::base64UrlDecode($this->auth));
        $sealed = substr($body, 86);
        $plain = openssl_decrypt(substr($sealed, 0, -16), 'aes-128-gcm', hash_hkdf('sha256', $ikm, 16, "Content-Encoding: aes128gcm\x00", $salt), OPENSSL_RAW_DATA, hash_hkdf('sha256', $ikm, 12, "Content-Encoding: nonce\x00", $salt), substr($sealed, -16));
        self::assertIsString($plain);

        return substr($plain, 0, -1);
    }

    private function job(?string $userId = null): Job
    {
        return new Job('1', 'push_notify', null, ['userId' => $userId ?? $this->userId], 1);
    }

    public function testHandlerSendsContentFreePayload(): void
    {
        $id = $this->subscribe('https://push.example.org/send/abc');
        [$handler, $sender] = $this->handler();
        self::assertFalse($handler->run($this->job(), new Deadline(60)));

        self::assertCount(1, $sender->calls);
        $call = $sender->calls[0];
        self::assertSame('https://push.example.org/send/abc', $call['endpoint']);
        self::assertSame('900', $call['headers']['TTL']);
        self::assertSame('normal', $call['headers']['Urgency']);
        self::assertSame('aes128gcm', $call['headers']['Content-Encoding']);
        self::assertStringStartsWith('vapid t=', $call['headers']['Authorization']);
        $installationId = Database::run(self::$db->pdo(), 'SELECT installation_id FROM device WHERE id = ?', [$this->deviceId])->fetchColumn();
        self::assertSame(['type' => 'new_mail', 'installationId' => $installationId, 'badge' => 0], json_decode($this->decrypt($call['body']), true));

        $row = Database::run(self::$db->pdo(), 'SELECT failure_count, last_success_at FROM push_subscription WHERE id = ?', [$id])->fetch();
        self::assertIsArray($row);
        self::assertSame(0, (int) $row['failure_count']);
        self::assertNotNull($row['last_success_at']);
        $log = Http::contents($this->log);
        self::assertStringNotContainsString('send/abc', $log);
    }

    public function testHandlerRemovesGoneAndDisablesFailing(): void
    {
        $gone = $this->subscribe('https://push.example.org/gone');
        $failing = $this->subscribe('https://push.example.org/failing');
        Database::run(self::$db->pdo(), 'UPDATE push_subscription SET failure_count = 3 WHERE id = ?', [$failing]);
        // Order of the select is not defined: map the status per endpoint.
        $statuses = ['https://push.example.org/gone' => 410, 'https://push.example.org/failing' => 500];
        $byEndpoint = new class ($statuses) implements PushSender {
            /** @param array<string, int> $statuses */
            public function __construct(private array $statuses) {}

            public function send(string $endpoint, array $headers, string $body): int
            {
                return $this->statuses[$endpoint];
            }
        };
        $handler = new PushNotifyHandler(self::$db, $this->cfg, new Logger('worker', 'info', $this->log), $byEndpoint, $this->vapid());
        self::assertSame(['sent' => 0, 'removed' => 1, 'failed' => 1], $handler->notify(['userId' => $this->userId]));
        self::assertFalse(Database::run(self::$db->pdo(), 'SELECT 1 FROM push_subscription WHERE id = ?', [$gone])->fetchColumn());
        $row = Database::run(self::$db->pdo(), 'SELECT failure_count, disabled_at FROM push_subscription WHERE id = ?', [$failing])->fetch();
        self::assertIsArray($row);
        self::assertSame(4, (int) $row['failure_count']);
        self::assertNull($row['disabled_at']);

        self::assertSame(['sent' => 0, 'removed' => 0, 'failed' => 1], $handler->notify(['userId' => $this->userId]));
        $row = Database::run(self::$db->pdo(), 'SELECT failure_count, disabled_at FROM push_subscription WHERE id = ?', [$failing])->fetch();
        self::assertIsArray($row);
        self::assertSame(5, (int) $row['failure_count']);
        self::assertNotNull($row['disabled_at']);
        // Disabled: no further sends.
        self::assertSame(['sent' => 0, 'removed' => 0, 'failed' => 0], $handler->notify(['userId' => $this->userId]));
        self::assertStringContainsString('push subscription disabled after failures', Http::contents($this->log));
    }

    public function testHandlerSkipsWithoutVapidOrSession(): void
    {
        $this->subscribe('https://push.example.org/a');
        $handler = new PushNotifyHandler(self::$db, $this->cfg, new Logger('worker', 'error', Http::memoryStream()), new StreamPushSender(true), null);
        self::assertSame('not_configured', $handler->notify(['userId' => $this->userId]));

        [$handler, $sender] = $this->handler();
        Database::run(self::$db->pdo(), 'UPDATE session SET expires_at = UTC_TIMESTAMP(6) - INTERVAL 1 SECOND');
        self::assertSame(['sent' => 0, 'removed' => 0, 'failed' => 0], $handler->notify(['userId' => $this->userId]));
        self::assertSame([], $sender->calls);

        $this->expectException(\InvalidArgumentException::class);
        $handler->notify([]);
    }

    public function testInvalidVapidKeysCountAsFailure(): void
    {
        $id = $this->subscribe('https://push.example.org/a');
        [$handler, $sender] = $this->handler(new Vapid('AAAA', 'BBBB'));
        self::assertSame(['sent' => 0, 'removed' => 0, 'failed' => 1], $handler->notify(['userId' => $this->userId]));
        self::assertSame([], $sender->calls);
        self::assertSame(1, (int) Database::run(self::$db->pdo(), 'SELECT failure_count FROM push_subscription WHERE id = ?', [$id])->fetchColumn());
    }

    public function testFcmRegistrationNeedsConfiguredFcm(): void
    {
        $body = ['transport' => 'fcm', 'token' => 'fcm-registration-token:APA91b-xyz_123'];
        self::assertSame(422, $this->call('POST', '/api/push/subscriptions', $body)->getStatusCode());

        $app = App::create($this->config(['FCM_PROJECT_ID' => 'test-project']), self::$db, new Logger('api', 'error', Http::memoryStream()), []);
        self::assertSame(400, $this->call('POST', '/api/push/subscriptions', ['transport' => 'fcm', 'token' => 'x y'], app: $app)->getStatusCode());
        self::assertSame(400, $this->call('POST', '/api/push/subscriptions', ['transport' => 'apns', 'token' => 'abc'], app: $app)->getStatusCode());
        $created = $this->call('POST', '/api/push/subscriptions', $body, app: $app);
        self::assertSame(201, $created->getStatusCode());
        // Re-registering the same token keeps the subscription.
        self::assertSame(Http::json($created)['id'], Http::json($this->call('POST', '/api/push/subscriptions', $body, app: $app))['id']);
        $list = (array) Http::json($this->call('GET', '/api/push/subscriptions', app: $app))['subscriptions'];
        self::assertCount(1, $list);
        self::assertSame('fcm.googleapis.com', $list[0]['pushService']);
        self::assertSame('fcm', Database::run(self::$db->pdo(), 'SELECT transport FROM push_subscription')->fetchColumn());

        self::assertSame(204, $this->call('DELETE', '/api/push/subscriptions', ['endpoint' => $body['token']], app: $app)->getStatusCode());
        self::assertSame(0, (int) Database::run(self::$db->pdo(), 'SELECT COUNT(*) FROM push_subscription')->fetchColumn());
    }

    public function testFcmSendsOnlyEventInstallationAndBadge(): void
    {
        $pdo = self::$db->pdo();
        Database::run($pdo, "INSERT INTO push_subscription (id, device_id, transport, endpoint, keys_enc) VALUES (?, ?, 'fcm', 'fcm-token-ok', ''), (?, ?, 'fcm', 'fcm-token-gone', '')", [Uuid::v4(), $this->deviceId, Uuid::v4(), $this->deviceId]);
        $http = new FakeHttpClient();
        // Answer UNREGISTERED for the gone token, whichever comes first.
        $unregistered = new class ($http) implements \Fma\Push\HttpClient {
            public function __construct(private readonly FakeHttpClient $inner) {}

            public function post(string $url, array $headers, string $body): array
            {
                $response = $this->inner->post($url, $headers, $body);

                return str_contains($body, 'fcm-token-gone') ? ['status' => 404, 'body' => '{"error":{"details":[{"errorCode":"UNREGISTERED"}]}}'] : $response;
            }
        };
        $fcm = Fcm::fromConfig($this->config(['FCM_PROJECT_ID' => 'test-project', 'FCM_SERVICE_ACCOUNT_JSON' => FakeHttpClient::serviceAccount()]), $unregistered);
        // Web Push not configured: FCM still goes out.
        $handler = new PushNotifyHandler(self::$db, $this->cfg, new Logger('worker', 'info', $this->log), new StreamPushSender(true), null, $fcm);
        self::assertSame(['sent' => 1, 'removed' => 1, 'failed' => 0], $handler->notify(['userId' => $this->userId]));

        $sends = $http->sends();
        self::assertCount(2, $sends);
        $installationId = Database::run($pdo, 'SELECT installation_id FROM device WHERE id = ?', [$this->deviceId])->fetchColumn();
        foreach ($sends as $send) {
            $message = json_decode($send['body'], true);
            self::assertIsArray($message);
            self::assertSame(['event' => 'new_mail', 'installationId' => $installationId, 'badge' => '0'], $message['message']['data']);
            self::assertSame(['token', 'data', 'android'], array_keys($message['message']), 'data-only, no notification block');
            foreach (['me@example.org', 'subject', 'from'] as $content) {
                self::assertStringNotContainsString($content, $send['body']);
            }
        }
        self::assertSame(['fcm-token-ok'], Database::run($pdo, 'SELECT endpoint FROM push_subscription')->fetchAll(\PDO::FETCH_COLUMN));
        $log = Http::contents($this->log);
        self::assertStringNotContainsString('fcm-token-ok', $log);
        self::assertStringNotContainsString('BEGIN PRIVATE KEY', $log);
        self::assertStringNotContainsString('ya29.test', $log);
    }

    public function testTestNotificationIsQueuedOnlyWithASubscriptionAndCoalesced(): void
    {
        self::assertSame(['queued' => false], Http::json($this->call('POST', '/api/push/test')), 'no subscription');
        $this->subscribe('https://push.example.org/a');
        $first = $this->call('POST', '/api/push/test');
        self::assertSame(202, $first->getStatusCode());
        self::assertSame(['queued' => true], Http::json($first));
        self::assertSame(['queued' => false], Http::json($this->call('POST', '/api/push/test')), 'one queued job per user');
        $payload = Database::run(self::$db->pdo(), "SELECT payload FROM job WHERE type = 'push_notify'")->fetchColumn();
        self::assertSame(['userId' => $this->userId], json_decode((string) $payload, true));
    }

    public function testEnqueueCoalescesPerUser(): void
    {
        $pdo = self::$db->pdo();
        $account = Uuid::v4();
        Database::run($pdo, "INSERT INTO mail_account (id, user_id, display_name, email_address, imap_host, imap_port, smtp_host, smtp_port, wrapped_dek, key_id, credential_enc, status) VALUES (?, ?, 'K', 'a@example.org', 'imap.example.org', 993, 'smtp.example.org', 465, 'w', 'v1', 'c', 'ok')", [$account, $this->userId]);
        $queue = new PushNotifyQueue(self::$db);
        self::assertFalse($queue->enqueueForAccount($account), 'no subscription');
        $this->subscribe('https://push.example.org/a');
        self::assertTrue($queue->enqueueForAccount($account));
        self::assertFalse($queue->enqueueForAccount($account), 'one queued job per user');
        /** @var array{payload: string, account_id: ?string, delay: int|string} $job */
        $job = Database::run($pdo, "SELECT payload, account_id, TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(6), run_at) AS delay FROM job WHERE type = 'push_notify'")->fetch();
        self::assertSame(['userId' => $this->userId], json_decode($job['payload'], true));
        self::assertNull($job['account_id']);
        self::assertGreaterThanOrEqual(28, (int) $job['delay']);
        Database::run($pdo, "UPDATE job SET state = 'done'");
        self::assertTrue($queue->enqueueForAccount($account));
        $delay = Database::run($pdo, "SELECT MAX(TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(6), run_at)) FROM job WHERE type = 'push_notify' AND state = 'queued'")->fetchColumn();
        self::assertGreaterThanOrEqual(58, (int) $delay, 'at least 30 s after the previous job');
    }

    /** Real HTTP against a local fake push service (php -S), MAIL_INSECURE_TRANSPORT mode. */
    public function testStreamSenderAgainstLocalPushService(): void
    {
        $dir = sys_get_temp_dir() . '/fma-push-' . bin2hex(random_bytes(4));
        mkdir($dir);
        $port = random_int(20000, 40000);
        $process = proc_open(
            [PHP_BINARY, '-S', "127.0.0.1:{$port}", __DIR__ . '/../fixtures/fake-push-service.php'],
            [1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']],
            $pipes,
            null,
            ['FAKE_PUSH_DIR' => $dir],
        );
        self::assertIsResource($process);
        try {
            for ($i = 0; $i < 50 && @fsockopen('127.0.0.1', $port) === false; ++$i) {
                usleep(100_000);
            }
            $sender = new StreamPushSender(true, 5);
            self::assertSame(201, $sender->send("http://127.0.0.1:{$port}/push/abc?x=1", ['TTL' => '900'], 'payload'));
            $request = json_decode((string) file_get_contents("{$dir}/request.json"), true);
            self::assertIsArray($request);
            self::assertSame('POST', $request['method']);
            self::assertSame('/push/abc?x=1', $request['uri']);
            self::assertSame('900', $request['headers']['ttl']);
            self::assertSame('payload', base64_decode($request['body']));
            self::assertSame(410, $sender->send("http://127.0.0.1:{$port}/status/410", [], ''));
            // No redirects: the 302 is returned as is.
            self::assertSame(302, $sender->send("http://127.0.0.1:{$port}/status/302", [], ''));

            // The whole job over HTTP: 404 removes the subscription.
            $id = $this->subscribe("http://127.0.0.1:{$port}/status/404");
            $handler = new PushNotifyHandler(self::$db, $this->cfg, new Logger('worker', 'error', Http::memoryStream()), $sender, $this->vapid());
            self::assertSame(['sent' => 0, 'removed' => 1, 'failed' => 0], $handler->notify(['userId' => $this->userId]));
            self::assertFalse(Database::run(self::$db->pdo(), 'SELECT 1 FROM push_subscription WHERE id = ?', [$id])->fetchColumn());
        } finally {
            proc_terminate($process);
            proc_close($process);
            array_map('unlink', glob("{$dir}/*") ?: []);
            rmdir($dir);
        }
    }

    public function testStrictSenderRefusesPrivateAndHttp(): void
    {
        $sender = new StreamPushSender(false, 2, static fn(string $host): array => ['10.0.0.1']);
        foreach (['http://push.example.org/x', 'https://push.example.org/x', 'https://127.0.0.1/x', 'https://[::1]/x'] as $endpoint) {
            try {
                $sender->send($endpoint, [], '');
                self::fail("sent to {$endpoint}");
            } catch (\Throwable $e) {
                self::assertNotInstanceOf(\PHPUnit\Framework\AssertionFailedError::class, $e);
            }
        }
    }
}
