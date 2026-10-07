<?php

declare(strict_types=1);

namespace Fma\Auth;

/**
 * Argon2id password hashes (ADR-0004) with the parameters of
 * apps/api/src/auth/password.ts (OWASP: m=19 MiB, t=2, p=1). Hashes are
 * PHC strings (`$argon2id$v=19$m=19456,t=2,p=1$...`), the format hash-wasm
 * writes, so password_verify() reads hashes created by the Node backend.
 */
final class Password
{
    private const OPTIONS = ['memory_cost' => 19456, 'time_cost' => 2, 'threads' => 1];

    public static function hash(string $password): string
    {
        return password_hash($password, PASSWORD_ARGON2ID, self::OPTIONS);
    }

    public static function verify(string $password, string $hash): bool
    {
        return str_starts_with($hash, '$argon2id$') && password_verify($password, $hash);
    }

    /** Equalizes timing when the email is unknown (no user enumeration by time). */
    public static function dummyVerify(string $password): void
    {
        static $dummy = null;
        $dummy ??= self::hash(bin2hex(random_bytes(12)));
        password_verify($password, $dummy);
    }

    /** Minimum requirements for a new password (setup and password change). */
    public static function isAcceptable(string $password): bool
    {
        // UTF-16 code units, like String.length in the Node backend.
        $length = intdiv(\strlen(mb_convert_encoding($password, 'UTF-16LE', 'UTF-8')), 2);

        return $length >= 10 && $length <= 200;
    }
}
