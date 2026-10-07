<?php

declare(strict_types=1);

namespace Fma\Http;

/**
 * JSON input helpers with the semantics of the Node backend, so validation
 * accepts and rejects the same values.
 */
final class Input
{
    /** Whitespace as JavaScript's String.prototype.trim() and `\s` see it. */
    public const WS = '\s\x{00A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}';

    /** String.prototype.trim(): also removes Unicode spaces. */
    public static function trim(string $value): string
    {
        return preg_replace('/^[' . self::WS . ']+|[' . self::WS . ']+\z/u', '', $value) ?? $value;
    }

    /** A JSON number that is an integer (Number.isInteger: 993.0 counts), else null. */
    public static function integer(mixed $value): ?int
    {
        if (\is_int($value)) {
            return $value;
        }
        if (\is_float($value) && is_finite($value) && floor($value) === $value && abs($value) < 2 ** 53) {
            return (int) $value;
        }

        return null;
    }
}
