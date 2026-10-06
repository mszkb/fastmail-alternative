<?php

declare(strict_types=1);

namespace Fma\Tests\Unit\Db;

use Fma\Db\Uuid;
use PHPUnit\Framework\TestCase;

final class UuidTest extends TestCase
{
    public function testV4IsLowercaseHyphenatedAndVersioned(): void
    {
        for ($i = 0; $i < 50; ++$i) {
            $id = Uuid::v4();
            self::assertTrue(Uuid::isValid($id), $id);
            self::assertSame('4', $id[14]);
            self::assertContains($id[19], ['8', '9', 'a', 'b']);
        }
        self::assertNotSame(Uuid::v4(), Uuid::v4());
    }

    public function testRejectsOtherForms(): void
    {
        self::assertFalse(Uuid::isValid('0B6F3C1E-8A2D-4C5B-9E7F-1A2B3C4D5E6F'));
        self::assertFalse(Uuid::isValid('0b6f3c1e8a2d4c5b9e7f1a2b3c4d5e6f'));
    }
}
