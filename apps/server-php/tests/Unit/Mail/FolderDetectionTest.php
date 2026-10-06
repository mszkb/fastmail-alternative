<?php

declare(strict_types=1);

namespace Fma\Tests\Unit\Mail;

use Fma\Mail\FolderDetection;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/** Port of the detection cases in packages/shared/test/folders.test.ts. */
final class FolderDetectionTest extends TestCase
{
    /** @return iterable<array{string, string, string}> */
    public static function names(): iterable
    {
        yield ['Sent', '/', 'sent'];
        yield ['Gesendet', '/', 'sent'];
        yield ['Gesendete Objekte', '/', 'sent'];
        yield ['Sent Items', '/', 'sent'];
        yield ['[Gmail]/Sent Mail', '/', 'sent'];
        yield ['INBOX.Sent', '.', 'sent'];
        yield ['Papierkorb', '/', 'trash'];
        yield ['Gelöschte Elemente', '/', 'trash'];
        yield ['Deleted Items', '/', 'trash'];
        yield ['[Gmail]/Trash', '/', 'trash'];
        yield ['Entwürfe', '/', 'drafts'];
        yield ['INBOX/Drafts', '/', 'drafts'];
        yield ['Archiv', '/', 'archive'];
        yield ['Spam', '/', 'junk'];
        yield ['Junk-E-Mail', '/', 'junk'];
        yield ['[Gmail]/Spam', '/', 'junk'];
    }

    #[DataProvider('names')]
    public function testRoleFromName(string $path, string $delimiter, string $role): void
    {
        self::assertSame($role, FolderDetection::roleFromName($path, $delimiter));
    }

    public function testDecomposedUmlautsAndUnknownNames(): void
    {
        self::assertSame('drafts', FolderDetection::roleFromName("Entwu\u{0308}rfe", '/'));
        self::assertNull(FolderDetection::roleFromName('Projekte', '/'));
        self::assertNull(FolderDetection::roleFromName('Sent/Projekte', '/'));
    }

    public function testPrefersSpecialUseOverNames(): void
    {
        self::assertSame(
            ['INBOX' => 'inbox', 'Gesendet' => null, 'Sent Mail' => 'sent', 'Papierkorb' => 'trash', 'Odd' => null],
            FolderDetection::detect([
                ['path' => 'INBOX', 'delimiter' => '/', 'specialUse' => null],
                ['path' => 'Gesendet', 'delimiter' => '/', 'specialUse' => null],
                ['path' => 'Sent Mail', 'delimiter' => '/', 'specialUse' => '\Sent'],
                ['path' => 'Papierkorb', 'delimiter' => '/', 'specialUse' => null],
                ['path' => 'Odd', 'delimiter' => '/', 'specialUse' => '\Flagged'],
            ]),
        );
    }
}
