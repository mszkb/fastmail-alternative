<?php

declare(strict_types=1);

namespace Fma\Tests\Unit\Mail;

use Fma\Mail\ImapMailbox;
use PHPUnit\Framework\TestCase;

/** Parsing of `* SEARCH` lines (also very long ones). */
final class ImapSearchResultTest extends TestCase
{
    public function testParsesSearchLines(): void
    {
        self::assertSame([1, 2, 30], ImapMailbox::searchResult("* SEARCH 1 2 30\r\n"));
        self::assertSame([], ImapMailbox::searchResult("* SEARCH\r\n"));
        self::assertSame([4, 7], ImapMailbox::searchResult("* search 4 7 (MODSEQ 917162500)\r\n"));
        self::assertNull(ImapMailbox::searchResult("* SEARCHING 1\r\n"));
        self::assertNull(ImapMailbox::searchResult("* 3 EXISTS\r\n"));
        self::assertNull(ImapMailbox::searchResult("A1 OK done\r\n"));
    }

    public function testParsesHundredsOfThousandsOfUids(): void
    {
        // A repeating regex fails on such lines (PCRE limits) and loses every UID.
        $uids = range(1, 300000);
        $result = ImapMailbox::searchResult('* SEARCH ' . implode(' ', $uids) . "\r\n");
        self::assertNotNull($result);
        self::assertCount(300000, $result);
        self::assertSame(300000, $result[299999]);
    }
}
