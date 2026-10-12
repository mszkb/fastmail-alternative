<?php

declare(strict_types=1);

namespace Fma\Tests\Unit\Mail;

use Fma\Mail\HostConfig;
use Fma\Mail\ImapActions;
use Fma\Mail\ImapClient;
use Fma\Mail\ProviderSearch;
use Fma\Mail\TransportPolicy;
use Fma\Routes\SearchRoutes;
use PHPUnit\Framework\TestCase;

/**
 * Search criteria and deadline of the provider search: free text without
 * the body by default, and a slow folder ends the search with the folders
 * searched so far instead of losing the whole account.
 */
final class ProviderSearchTest extends TestCase
{
    /** @var resource|null */
    private $server;
    private int $port = 0;

    protected function tearDown(): void
    {
        if (\is_resource($this->server)) {
            proc_terminate($this->server);
            proc_close($this->server);
        }
    }

    public function testFreeTextSearchesHeadersUnlessFulltext(): void
    {
        self::assertSame(
            ['parts' => ['OR SUBJECT "rechnung" OR FROM "rechnung" TO "rechnung" SINCE 1-Feb-2026'], 'utf8' => false],
            ImapActions::searchCriteria(['q' => 'rechnung', 'since' => '2026-02-01']),
        );
        self::assertSame(
            ['parts' => ['TEXT "rechnung"'], 'utf8' => false],
            ImapActions::searchCriteria(['q' => 'rechnung', 'fulltext' => true]),
        );
        // 8-bit: every occurrence of the term as its own literal.
        self::assertSame(
            ['parts' => ['OR SUBJECT ', 'ä', ' OR FROM ', 'ä', ' TO ', 'ä', ' FROM ', 'x'], 'utf8' => true],
            ImapActions::searchCriteria(['q' => 'ä', 'from' => 'x']),
        );
        // `fulltext` without free text changes nothing.
        self::assertSame(['parts' => ['SUBJECT "a"'], 'utf8' => false], ImapActions::searchCriteria(['subject' => 'a', 'fulltext' => true]));
    }

    public function testFulltextIsAFlagButNoCriterion(): void
    {
        self::assertSame(['q' => 'a', 'fulltext' => true], SearchRoutes::parseQuery(['q' => 'a', 'fulltext' => '1']));
        self::assertSame(['q' => 'a'], SearchRoutes::parseQuery(['q' => 'a', 'fulltext' => 'false']));
        self::assertSame('Bitte einen Suchbegriff oder Zeitraum angeben.', SearchRoutes::parseQuery(['fulltext' => '1']));
        self::assertSame('Ungültiger Filter.', SearchRoutes::parseQuery(['q' => 'a', 'fulltext' => 'ja']));
    }

    public function testDeadlineKeepsTheFoldersSearchedSoFar(): void
    {
        $client = $this->connect(delay: 10);
        $started = microtime(true);
        $found = ProviderSearch::search($client, $this->folders('INBOX', 'Slow', 'Archiv'), ImapActions::searchCriteria(['q' => 'x']), $started + 2.0);
        $client->disconnect();

        self::assertTrue($found['timedOut']);
        self::assertSame([['folderId' => 'f-INBOX', 'uidvalidity' => '7', 'uids' => [3, 1]]], $found['folders']);
        // Ends at the deadline although progress lines keep the socket busy.
        self::assertLessThan(4.0, microtime(true) - $started);
    }

    public function testWithoutTimeoutAllFoldersAreSearched(): void
    {
        $client = $this->connect(delay: 6);
        $found = ProviderSearch::search($client, $this->folders('INBOX', 'Archiv'), ImapActions::searchCriteria(['q' => 'x']), microtime(true) + 10.0);
        $client->logout();

        self::assertFalse($found['timedOut']);
        self::assertSame(['f-INBOX', 'f-Archiv'], array_column($found['folders'], 'folderId'));
    }

    public function testPassedDeadlineSearchesNothing(): void
    {
        $client = $this->connect(delay: 6);
        $found = ProviderSearch::search($client, $this->folders('INBOX'), ImapActions::searchCriteria(['q' => 'x']), microtime(true) - 1.0);
        $client->logout();

        self::assertTrue($found['timedOut']);
        self::assertSame([], $found['folders']);
    }

    /** @return list<array{id: string, path: string, special_use: ?string}> */
    private function folders(string ...$paths): array
    {
        return array_map(static fn(string $path): array => ['id' => "f-{$path}", 'path' => $path, 'special_use' => null], array_values($paths));
    }

    private function connect(int $delay): ImapClient
    {
        $script = \dirname(__DIR__, 2) . '/fixtures/slow-search-imap-server.php';
        $server = proc_open([\PHP_BINARY, $script, (string) $delay], [1 => ['pipe', 'w']], $pipes);
        self::assertIsResource($server);
        $this->server = $server;
        $ready = (string) fgets($pipes[1]);
        self::assertMatchesRegularExpression('/^PORT \d+/', $ready);
        $this->port = (int) substr(trim($ready), 5);

        return ImapClient::connect(
            new TransportPolicy(allowPrivateHosts: true, insecureTransport: true, extraPorts: [$this->port]),
            new HostConfig('127.0.0.1', $this->port, false, 'user', 'secret'),
            8.0,
        );
    }
}
