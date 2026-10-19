<?php

declare(strict_types=1);

namespace Fma\Tests\Unit\Mail;

use Fma\Mail\RawStorage;
use PHPUnit\Framework\TestCase;

final class RawStorageTest extends TestCase
{
    public function testParsesMemoryLimit(): void
    {
        self::assertSame(128 * 1024 * 1024, RawStorage::memoryLimit('128M'));
        self::assertSame(2 * 1024 ** 3, RawStorage::memoryLimit('2g'));
        self::assertSame(512 * 1024, RawStorage::memoryLimit('512K'));
        self::assertSame(1_000_000, RawStorage::memoryLimit('1000000'));
        self::assertNull(RawStorage::memoryLimit('-1'));
        self::assertNull(RawStorage::memoryLimit('0'));
        self::assertNull(RawStorage::memoryLimit(''));
    }
}
