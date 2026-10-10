<?php

declare(strict_types=1);

namespace Fma\Tests\Integration;

use Fma\App;
use Fma\Auth\Sessions;
use Fma\Config;
use Fma\Db\Database;
use Fma\Db\Uuid;
use Fma\Log\Logger;
use Fma\Mail\Autoconfig;
use Fma\Tests\Support\FakeConnectionTester;
use Fma\Tests\Support\FakeHttpsGetter;
use Fma\Tests\Support\Http;
use Psr\Http\Message\ResponseInterface;

/** GET /api/autoconfig (#165). */
final class AutoconfigRoutesTest extends DatabaseTestCase
{
    /** @var \Slim\App<\Psr\Container\ContainerInterface|null> */
    private \Slim\App $app;
    private FakeHttpsGetter $http;
    private string $token;

    protected function setUp(): void
    {
        $pdo = self::$db->pdo();
        foreach (['rate_limit', '`user`'] as $table) {
            $pdo->exec("DELETE FROM {$table}");
        }
        $this->http = new FakeHttpsGetter([Autoconfig::ISPDB_URL . 'example.org' => <<<'XML'
            <clientConfig version="1.1"><emailProvider id="example.org">
              <incomingServer type="imap"><hostname>imap.example.org</hostname><port>993</port><socketType>SSL</socketType><username>%EMAILADDRESS%</username></incomingServer>
              <outgoingServer type="smtp"><hostname>smtp.example.org</hostname><port>465</port><socketType>SSL</socketType></outgoingServer>
            </emailProvider></clientConfig>
            XML]);
        $config = Config::fromArray(['DATABASE_URL' => self::$config->get('DATABASE_URL'), 'MASTER_KEY' => base64_encode(random_bytes(32))]);
        $autoconfig = new Autoconfig($this->http, true, static fn(string $name, int $type): array => []);
        $this->app = App::create($config, self::$db, new Logger('api', 'error', Http::memoryStream()), [], new FakeConnectionTester(), null, $autoconfig);
        $userId = Uuid::v4();
        Database::run($pdo, 'INSERT INTO `user` (id, email, password_hash) VALUES (?, ?, ?)', [$userId, 'me@example.org', 'unused']);
        $this->token = (new Sessions(self::$db))->createDeviceWithSession($userId, 'Test', 'desktop');
    }

    private function get(string $path, ?string $token = null): ResponseInterface
    {
        $request = Http::request('GET', $path, ['Sec-Fetch-Site' => 'same-origin']);

        return $this->app->handle($token === null ? $request : $request->withCookieParams(['fma_session' => $token]));
    }

    public function testDetectsSettings(): void
    {
        $response = $this->get('/api/autoconfig?domain=Example.org', $this->token);
        self::assertSame(200, $response->getStatusCode());
        self::assertSame([
            'found' => true,
            'source' => 'ispdb',
            'imap' => ['host' => 'imap.example.org', 'port' => 993],
            'smtp' => ['host' => 'smtp.example.org', 'port' => 465],
            'username' => 'address',
        ], Http::json($response));

        $response = $this->get('/api/autoconfig?domain=nothing.example', $this->token);
        self::assertSame(['found' => false], Http::json($response));
    }

    public function testNeedsSessionAndValidDomain(): void
    {
        self::assertSame(401, $this->get('/api/autoconfig?domain=example.org')->getStatusCode());
        foreach (['', '?domain=', '?domain=localhost', '?domain=a%2Fb.example.org', '?domain[]=x.org'] as $query) {
            self::assertSame(400, $this->get('/api/autoconfig' . $query, $this->token)->getStatusCode(), $query);
        }
        self::assertSame([], $this->http->requested);
    }
}
