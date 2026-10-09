<?php

declare(strict_types=1);

namespace Fma\Tests\Unit\Themes;

use Fma\Themes\ThemeValidator;
use PHPUnit\Framework\TestCase;

/** Same cases as packages/shared/test/themes.test.ts (#126). */
final class ThemeValidatorTest extends TestCase
{
    /** @return array<string, mixed> */
    private static function valid(): array
    {
        return [
            'format' => 1,
            'id' => 'test-theme',
            'name' => 'Test',
            'version' => '1.0.0',
            'author' => 'Jemand',
            'license' => 'ISC',
            'minAppVersion' => '0.1.0',
            'colors' => ['light' => ['primary' => '#0b4f9c'], 'dark' => ['base-100' => '#101418']],
            'sizes' => ['radius' => '0.25rem', 'text-md' => '0.9rem'],
            'layout' => ['readingPane' => 'bottom', 'density' => 'compact', 'accountRail' => 'list'],
        ];
    }

    public function testAcceptsAValidTheme(): void
    {
        self::assertSame([], ThemeValidator::validate(self::valid()));
        $minimal = self::valid();
        unset($minimal['colors'], $minimal['sizes'], $minimal['layout']);
        self::assertSame([], ThemeValidator::validate($minimal));
    }

    public function testRejectsScriptsCssUrlsAndUnknownFields(): void
    {
        $v = self::valid();
        self::assertSame(['Unbekanntes Feld „css“.'], ThemeValidator::validate($v + ['css' => 'body{}']));
        self::assertSame(
            ['„colors.light.primary“ muss eine Farbe wie #1a2b3c sein.'],
            ThemeValidator::validate(['colors' => ['light' => ['primary' => 'url(https://x.test/a)']]] + $v),
        );
        self::assertSame(['Unbekannte Farbe „colors.light.font-family“.'], ThemeValidator::validate(['colors' => ['light' => ['font-family' => '#000000']]] + $v));
        self::assertCount(1, ThemeValidator::validate(['sizes' => ['radius' => 'calc(1rem + 1px)']] + $v));
        self::assertSame(['„sizes.radius“ muss zwischen 0rem und 1.5rem liegen.'], ThemeValidator::validate(['sizes' => ['radius' => '9rem']] + $v));
        self::assertCount(1, ThemeValidator::validate(['name' => '<script>alert(1)</script>'] + $v));
        self::assertSame(['„layout.readingPane“: erlaubt sind right, bottom, off.'], ThemeValidator::validate(['layout' => ['readingPane' => 'left']] + $v));
        self::assertCount(1, ThemeValidator::validate(['layout' => ['toolbar' => 'x']] + $v));
        self::assertCount(1, ThemeValidator::validate(['id' => '../etc'] + $v));
        self::assertCount(1, ThemeValidator::validate(['format' => 2] + $v));
        self::assertCount(1, ThemeValidator::validate(['colors' => ['#000000']] + $v));
        self::assertSame(['Die Datei ist kein Theme (JSON-Objekt erwartet).'], ThemeValidator::validate([1, 2]));
        self::assertStringNotContainsString('<', ThemeValidator::validate($v + ['<img src=x>' => 1])[0]);
        // A trailing newline is no way around the patterns ($ without D would allow it).
        self::assertCount(1, ThemeValidator::validate(['colors' => ['light' => ['primary' => "#0b4f9c\n"]]] + $v));
        self::assertCount(1, ThemeValidator::validate(['sizes' => ['radius' => "1rem\n"]] + $v));
        self::assertCount(1, ThemeValidator::validate(['id' => "x\n"] + $v));
        self::assertCount(1, ThemeValidator::validate(['name' => "\u{00a0}"] + $v));
        self::assertSame([], ThemeValidator::validate(['format' => 1.0] + $v));
    }

    public function testRejectsTooLittleContrast(): void
    {
        $errors = ThemeValidator::validate(['colors' => ['dark' => ['base-content' => '#333333']]] + self::valid());
        self::assertMatchesRegularExpression('/^Zu wenig Kontrast \(dunkel\): base-content auf base-100 /', $errors[0]);
    }

    public function testAcceptsTheSwitcherPresets(): void
    {
        $files = glob(__DIR__ . '/../../../../../themes/*.fmatheme.json');
        self::assertIsArray($files);
        self::assertCount(3, $files);
        foreach ($files as $file) {
            self::assertSame([], ThemeValidator::validate(json_decode((string) file_get_contents($file), true)), $file);
        }
    }
}
