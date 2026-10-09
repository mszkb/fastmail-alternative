<?php

declare(strict_types=1);

namespace Fma\Themes;

/**
 * Validator for installable themes (#126), the same rules as validateTheme
 * in packages/shared/src/themes.ts and docs/themes/schema.json: only
 * allowlisted fields and values (colors `#rrggbb`, sizes in rem within
 * limits, fixed layout choices), plain-text manifest fields, and WCAG AA
 * contrast (4.5:1) for the text/background pairs in light and dark.
 * Errors are German, name the field and never echo rejected values.
 */
final class ThemeValidator
{
    public const FORMAT = 1;
    public const MAX_BYTES = 32 * 1024;
    public const MAX_INSTALLED = 20;
    public const MIN_CONTRAST = 4.5;

    public const COLORS = [
        'base-100', 'base-200', 'base-300', 'base-content',
        'primary', 'primary-content', 'secondary', 'secondary-content',
        'accent', 'accent-content', 'neutral', 'neutral-content',
        'info', 'info-content', 'success', 'success-content',
        'warning', 'warning-content', 'error', 'error-content',
    ];

    /** Size tokens and their range in rem. */
    public const SIZES = [
        'space-1' => [0, 1], 'space-2' => [0, 1.5], 'space-3' => [0, 2], 'space-4' => [0, 2.5], 'space-5' => [0, 3],
        'radius' => [0, 1.5], 'radius-box' => [0, 2],
        'text-xs' => [0.625, 1], 'text-sm' => [0.7, 1.15], 'text-md' => [0.8, 1.3], 'text-lg' => [0.9, 1.6],
    ];

    /** Built-in palettes (apps/web/app/assets/css/main.css): fallback for the contrast check. */
    public const DEFAULT_COLORS = [
        'light' => [
            'base-100' => '#ffffff', 'base-200' => '#f5f7fa', 'base-300' => '#e3e8ee', 'base-content' => '#1f2933',
            'primary' => '#0f5cb5', 'primary-content' => '#ffffff', 'secondary' => '#6d3fc0', 'secondary-content' => '#ffffff',
            'accent' => '#0f766e', 'accent-content' => '#ffffff', 'neutral' => '#2f3b47', 'neutral-content' => '#f5f7fa',
            'info' => '#1d6fd6', 'info-content' => '#ffffff', 'success' => '#127146', 'success-content' => '#ffffff',
            'warning' => '#c27a06', 'warning-content' => '#1f1400', 'error' => '#b42318', 'error-content' => '#ffffff',
        ],
        'dark' => [
            'base-100' => '#161b22', 'base-200' => '#1d242d', 'base-300' => '#2a333e', 'base-content' => '#dfe5ec',
            'primary' => '#5ea2f2', 'primary-content' => '#06182c', 'secondary' => '#b18cf0', 'secondary-content' => '#1a0c33',
            'accent' => '#3cc3b4', 'accent-content' => '#04201d', 'neutral' => '#cfd7e0', 'neutral-content' => '#161b22',
            'info' => '#6aaaf5', 'info-content' => '#06182c', 'success' => '#4cc38a', 'success-content' => '#04200f',
            'warning' => '#e6a73a', 'warning-content' => '#231600', 'error' => '#f2726a', 'error-content' => '#2b0503',
        ],
    ];

    public const CONTRAST_PAIRS = [
        ['base-content', 'base-100'], ['base-content', 'base-200'], ['base-content', 'base-300'],
        ['primary-content', 'primary'], ['secondary-content', 'secondary'], ['accent-content', 'accent'],
        ['neutral-content', 'neutral'], ['info-content', 'info'], ['success-content', 'success'],
        ['warning-content', 'warning'], ['error-content', 'error'], ['primary', 'base-100'],
    ];

    private const TOP_KEYS = ['format', 'id', 'name', 'version', 'author', 'license', 'minAppVersion', 'description', 'colors', 'sizes', 'layout'];
    private const TEXT_LIMITS = ['name' => 60, 'author' => 100, 'license' => 60, 'description' => 300];
    private const LAYOUT_VALUES = [
        'readingPane' => ['right', 'bottom', 'off'],
        'density' => ['normal', 'compact'],
        'accountRail' => ['icons', 'list'],
    ];

    /**
     * @return list<string> errors; empty when valid
     */
    public static function validate(mixed $input): array
    {
        if (!\is_array($input) || ($input !== [] && array_is_list($input))) {
            return ['Die Datei ist kein Theme (JSON-Objekt erwartet).'];
        }
        $errors = [];
        foreach (array_keys($input) as $key) {
            if (!\in_array($key, self::TOP_KEYS, true)) {
                $errors[] = 'Unbekanntes Feld „' . self::safeKey((string) $key) . '“.';
            }
        }
        if (!\in_array($input['format'] ?? null, [self::FORMAT, (float) self::FORMAT], true)) {
            $errors[] = '„format“ muss ' . self::FORMAT . ' sein.';
        }
        if (!\is_string($input['id'] ?? null) || preg_match('/^[a-z0-9][a-z0-9-]{0,47}$/D', $input['id']) !== 1) {
            $errors[] = '„id“: nur Kleinbuchstaben, Ziffern und Bindestriche (max. 48).';
        }
        foreach (['version', 'minAppVersion'] as $key) {
            if (!\is_string($input[$key] ?? null) || preg_match('/^\d{1,4}\.\d{1,4}\.\d{1,4}$/D', $input[$key]) !== 1) {
                $errors[] = "„{$key}“ muss eine Version wie 1.0.0 sein.";
            }
        }
        foreach (self::TEXT_LIMITS as $key => $max) {
            if (!\array_key_exists($key, $input) && $key === 'description') {
                continue;
            }
            $value = $input[$key] ?? null;
            if (!\is_string($value) || preg_match('/^[\s\p{Z}\x{FEFF}]*$/Du', $value) === 1 || self::length($value) > $max || preg_match('/[\x00-\x1f\x7f<>{}\\\\]/', $value) === 1) {
                $errors[] = "„{$key}“: Text mit 1–{$max} Zeichen ohne Sonderzeichen wie < > { } erwartet.";
            }
        }
        if (\array_key_exists('colors', $input)) {
            if (!self::isObject($input['colors'])) {
                $errors[] = '„colors“ muss ein Objekt sein.';
            } else {
                foreach ($input['colors'] as $mode => $palette) {
                    if ($mode !== 'light' && $mode !== 'dark') {
                        $errors[] = 'Unbekanntes Farbschema „' . self::safeKey((string) $mode) . '“ (erlaubt: light, dark).';
                        continue;
                    }
                    if (!self::isObject($palette)) {
                        $errors[] = "„colors.{$mode}“ muss ein Objekt sein.";
                        continue;
                    }
                    foreach ($palette as $name => $value) {
                        if (!\in_array($name, self::COLORS, true)) {
                            $errors[] = "Unbekannte Farbe „colors.{$mode}." . self::safeKey((string) $name) . '“.';
                        } elseif (!\is_string($value) || preg_match('/^#[0-9a-f]{6}$/D', $value) !== 1) {
                            $errors[] = "„colors.{$mode}.{$name}“ muss eine Farbe wie #1a2b3c sein.";
                        }
                    }
                }
            }
        }
        if (\array_key_exists('sizes', $input)) {
            if (!self::isObject($input['sizes'])) {
                $errors[] = '„sizes“ muss ein Objekt sein.';
            } else {
                foreach ($input['sizes'] as $name => $value) {
                    $range = self::SIZES[$name] ?? null;
                    if ($range === null) {
                        $errors[] = 'Unbekannte Größe „sizes.' . self::safeKey((string) $name) . '“.';
                    } elseif (!\is_string($value) || preg_match('/^(\d{1,2}(?:\.\d{1,4})?)rem$/D', $value, $m) !== 1
                        || (float) $m[1] < $range[0] || (float) $m[1] > $range[1]) {
                        $errors[] = "„sizes.{$name}“ muss zwischen {$range[0]}rem und {$range[1]}rem liegen.";
                    }
                }
            }
        }
        if (\array_key_exists('layout', $input)) {
            if (!self::isObject($input['layout'])) {
                $errors[] = '„layout“ muss ein Objekt sein.';
            } else {
                foreach ($input['layout'] as $name => $value) {
                    $allowed = self::LAYOUT_VALUES[$name] ?? null;
                    if ($allowed === null) {
                        $errors[] = 'Unbekannte Layout-Option „layout.' . self::safeKey((string) $name) . '“.';
                    } elseif (!\is_string($value) || !\in_array($value, $allowed, true)) {
                        $errors[] = "„layout.{$name}“: erlaubt sind " . implode(', ', $allowed) . '.';
                    }
                }
            }
        }
        if ($errors !== []) {
            return $errors;
        }

        foreach (['light', 'dark'] as $mode) {
            /** @var array<string, string> $own */
            $own = \is_array($input['colors'][$mode] ?? null) ? $input['colors'][$mode] : [];
            $palette = $own + self::DEFAULT_COLORS[$mode];
            foreach (self::CONTRAST_PAIRS as [$text, $background]) {
                $ratio = self::contrast($palette[$text], $palette[$background]);
                if ($ratio < self::MIN_CONTRAST) {
                    $errors[] = 'Zu wenig Kontrast (' . ($mode === 'light' ? 'hell' : 'dunkel') . "): {$text} auf {$background} "
                        . number_format($ratio, 2, '.', '') . ':1, mindestens ' . self::MIN_CONTRAST . ':1.';
                }
            }
        }

        return $errors;
    }

    /** WCAG contrast ratio of two #rrggbb colors. */
    public static function contrast(string $a, string $b): float
    {
        $luminance = static function (string $hex): float {
            $channel = static function (int $offset) use ($hex): float {
                $c = hexdec(substr($hex, $offset, 2)) / 255;

                return $c <= 0.03928 ? $c / 12.92 : (($c + 0.055) / 1.055) ** 2.4;
            };

            return 0.2126 * $channel(1) + 0.7152 * $channel(3) + 0.0722 * $channel(5);
        };
        $la = $luminance($a);
        $lb = $luminance($b);

        return (max($la, $lb) + 0.05) / (min($la, $lb) + 0.05);
    }

    /** JSON object (decoded as array): empty or with string keys. */
    private static function isObject(mixed $value): bool
    {
        return \is_array($value) && ($value === [] || !array_is_list($value));
    }

    /** Length in UTF-16 code units, as JS counts it. */
    private static function length(string $value): int
    {
        return intdiv(\strlen((string) mb_convert_encoding($value, 'UTF-16LE', 'UTF-8')), 2);
    }

    private static function safeKey(string $key): string
    {
        return substr((string) preg_replace('/[^\w.-]/', '?', $key), 0, 40);
    }
}
