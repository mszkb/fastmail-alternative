<?php

declare(strict_types=1);

namespace Fma\Tests\Integration;

use Fma\App;
use Fma\Auth\Sessions;
use Fma\Config;
use Fma\Db\Database;
use Fma\Db\Uuid;
use Fma\Log\Logger;
use Fma\Tests\Support\FakeConnectionTester;
use Fma\Tests\Support\Http;
use Fma\Themes\ThemeValidator;
use Psr\Http\Message\ResponseInterface;

/** GET/POST/DELETE /api/themes (#126). */
final class ThemeRoutesTest extends DatabaseTestCase
{
    /** @var \Slim\App<\Psr\Container\ContainerInterface|null> */
    private \Slim\App $app;
    private string $token;
    private string $otherToken;

    protected function setUp(): void
    {
        $pdo = self::$db->pdo();
        foreach (['user_theme', 'rate_limit', '`user`'] as $table) {
            $pdo->exec("DELETE FROM {$table}");
        }
        $config = Config::fromArray(['DATABASE_URL' => self::$config->get('DATABASE_URL'), 'MASTER_KEY' => base64_encode(random_bytes(32))]);
        $this->app = App::create($config, self::$db, new Logger('api', 'error', Http::memoryStream()), [], new FakeConnectionTester());
        $tokens = [];
        foreach (['me@example.org', 'other@example.org'] as $email) {
            $userId = Uuid::v4();
            Database::run($pdo, 'INSERT INTO `user` (id, email, password_hash) VALUES (?, ?, ?)', [$userId, $email, 'unused']);
            $tokens[] = (new Sessions(self::$db))->createDeviceWithSession($userId, 'Test', 'desktop');
        }
        [$this->token, $this->otherToken] = $tokens;
    }

    private function call(string $method, string $path, ?string $body = null, ?string $token = null): ResponseInterface
    {
        $request = Http::request($method, $path, ['Sec-Fetch-Site' => 'same-origin', 'Content-Type' => 'application/json'])
            ->withCookieParams(['fma_session' => $token ?? $this->token]);
        if ($body !== null) {
            $request->getBody()->write($body);
        }

        return $this->app->handle($request);
    }

    private function preset(): string
    {
        return (string) file_get_contents(__DIR__ . '/../../../../themes/kompakt-wie-gmail.fmatheme.json');
    }

    public function testInstallListReplaceDelete(): void
    {
        self::assertSame(['themes' => []], Http::json($this->call('GET', '/api/themes')));
        $created = $this->call('POST', '/api/themes', $this->preset());
        self::assertSame(201, $created->getStatusCode(), (string) $created->getBody());
        $item = Http::json($created);
        self::assertSame('kompakt-wie-gmail', $item['id']);
        self::assertSame('Kompakt (wie Gmail)', $item['name']);
        self::assertSame(json_decode($this->preset(), true), $item['theme']);
        self::assertSame([], $item['warnings']);

        // Same id again: an update.
        $theme = json_decode($this->preset(), true);
        \assert(\is_array($theme));
        $theme['version'] = '1.1.0';
        $theme['colors'] = new \stdClass();
        $updated = $this->call('POST', '/api/themes', (string) json_encode($theme));
        self::assertSame(200, $updated->getStatusCode());
        $list = Http::json($this->call('GET', '/api/themes'));
        self::assertCount(1, $list['themes']);
        self::assertSame('1.1.0', $list['themes'][0]['version']);
        self::assertStringContainsString('"colors":{}', (string) $this->call('GET', '/api/themes')->getBody());

        // Other users see nothing and cannot delete it.
        self::assertSame(['themes' => []], Http::json($this->call('GET', '/api/themes', null, $this->otherToken)));
        self::assertSame(404, $this->call('DELETE', '/api/themes/kompakt-wie-gmail', null, $this->otherToken)->getStatusCode());
        self::assertSame(204, $this->call('DELETE', '/api/themes/kompakt-wie-gmail')->getStatusCode());
        self::assertSame(404, $this->call('DELETE', '/api/themes/kompakt-wie-gmail')->getStatusCode());
    }

    public function testInstallsLowContrastWithWarnings(): void
    {
        $theme = json_decode($this->preset(), true);
        \assert(\is_array($theme));
        $theme['colors'] = ['dark' => ['base-content' => '#333333']];
        $created = $this->call('POST', '/api/themes', (string) json_encode($theme));
        self::assertSame(201, $created->getStatusCode());
        $warnings = Http::json($created)['warnings'];
        self::assertIsArray($warnings);
        self::assertStringStartsWith('Zu wenig Kontrast (dunkel): base-content auf base-100', (string) $warnings[0]);
        self::assertNotEmpty(Http::json($this->call('GET', '/api/themes'))['themes'][0]['warnings']);
    }

    public function testRejectsInvalidFiles(): void
    {
        $bad = $this->call('POST', '/api/themes', '{"format":1,"id":"x","css":"body{}"}');
        self::assertSame(400, $bad->getStatusCode());
        $body = Http::json($bad);
        self::assertSame('Das Theme ist ungültig.', $body['message']);
        self::assertContains('Unbekanntes Feld „css“.', $body['errors']);
        self::assertSame(400, $this->call('POST', '/api/themes', '{')->getStatusCode());
        self::assertSame(413, $this->call('POST', '/api/themes', str_repeat(' ', ThemeValidator::MAX_BYTES + 1))->getStatusCode());
        self::assertSame(401, $this->call('GET', '/api/themes', null, 'nope')->getStatusCode());
    }

    public function testLimitsTheNumberOfThemes(): void
    {
        $theme = json_decode($this->preset(), true);
        \assert(\is_array($theme));
        for ($i = 0; $i < ThemeValidator::MAX_INSTALLED; ++$i) {
            $theme['id'] = "t{$i}";
            self::assertSame(201, $this->call('POST', '/api/themes', (string) json_encode($theme))->getStatusCode());
        }
        $theme['id'] = 'one-more';
        self::assertSame(409, $this->call('POST', '/api/themes', (string) json_encode($theme))->getStatusCode());
        $theme['id'] = 't0';
        self::assertSame(200, $this->call('POST', '/api/themes', (string) json_encode($theme))->getStatusCode());
    }
}
