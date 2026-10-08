<?php

declare(strict_types=1);

namespace Fma\Tests\Unit\Auth;

use Fma\Auth\Password;
use PHPUnit\Framework\TestCase;

final class PasswordTest extends TestCase
{
    public function testDummyHashCostsTheSameAsARealOne(): void
    {
        $dummy = (new \ReflectionClassConstant(Password::class, 'DUMMY_HASH'))->getValue();
        self::assertIsString($dummy);
        $real = Password::hash('long-enough-1');
        // Same algorithm and parameters as a stored hash: verifying either takes as long.
        self::assertSame(password_get_info($real), password_get_info($dummy));
        self::assertFalse(Password::verify('long-enough-1', $dummy));
        self::assertTrue(Password::verify('long-enough-1', $real));
    }
}
