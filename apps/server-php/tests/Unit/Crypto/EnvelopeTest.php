<?php

declare(strict_types=1);

namespace Fma\Tests\Unit\Crypto;

use Fma\Crypto\Backup;
use Fma\Crypto\BackupDecryptException;
use Fma\Crypto\CryptoException;
use Fma\Crypto\Envelope;
use Fma\Tests\Support\CryptoVectors;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

final class EnvelopeTest extends TestCase
{
    /** @return array<string, mixed> */
    private static function referenceVectors(): array
    {
        $json = file_get_contents(CryptoVectors::FIXTURE_DIR . 'crypto-vectors-reference.json');
        self::assertIsString($json);
        $vectors = json_decode($json, true, flags: JSON_THROW_ON_ERROR);
        self::assertIsArray($vectors);
        self::assertSame('node', $vectors['generator']);

        return $vectors;
    }

    /** @param array<string, mixed> $v */
    private static function verify(array $v): void
    {
        $masterKey = Envelope::loadMasterKey($v['masterKey']);
        $unwrapped = Envelope::unwrapDataKey($masterKey, $v['wrappedDek']);
        self::assertSame($v['keyId'], $unwrapped['keyId']);
        $dataKey = $unwrapped['dataKey'];
        self::assertSame($v['dataKey'], base64_encode($dataKey));

        self::assertSame(
            array_column(CryptoVectors::fieldCases(), 'aad'),
            array_column($v['fields'], 'aad'),
        );
        foreach ($v['fields'] as $field) {
            self::assertSame($field['plaintext'], Envelope::decryptField($dataKey, $field['envelope'], $field['aad']));
        }

        $raw = base64_decode($v['bytes']['plaintext'], true);
        self::assertSame($raw, Envelope::decryptBytes($dataKey, (string) base64_decode($v['bytes']['envelope'], true), $v['bytes']['aad']));
        self::assertSame(
            base64_decode($v['legacyBytes']['plaintext'], true),
            Envelope::decryptBytes($dataKey, $v['legacyBytes']['envelope'], $v['legacyBytes']['aad']),
        );

        self::assertSame(
            $v['hmac']['expected'],
            Envelope::hmacValue(Envelope::deriveHmacKey($dataKey, $v['hmac']['context']), $v['hmac']['value']),
        );

        self::assertSame(
            CryptoVectors::patternBytes($v['backup']['length']),
            self::decryptBackup($masterKey, (string) base64_decode($v['backup']['envelope'], true)),
        );
    }

    private static function decryptBackup(string $masterKey, string $data): string
    {
        $in = fopen('php://memory', 'w+b');
        $out = fopen('php://memory', 'w+b');
        self::assertNotFalse($in);
        self::assertNotFalse($out);
        fwrite($in, $data);
        rewind($in);
        Backup::decryptStream($masterKey, $in, $out);
        rewind($out);

        return (string) stream_get_contents($out);
    }

    private static function encryptBackup(string $masterKey, string $data): string
    {
        $in = fopen('php://memory', 'w+b');
        $out = fopen('php://memory', 'w+b');
        self::assertNotFalse($in);
        self::assertNotFalse($out);
        fwrite($in, $data);
        rewind($in);
        Backup::encryptStream($masterKey, $in, $out);
        rewind($out);

        return (string) stream_get_contents($out);
    }

    public function testDecryptsTheReferenceVectors(): void
    {
        self::verify(self::referenceVectors());
    }

    public function testVerifiesItsOwnVectors(): void
    {
        self::verify(CryptoVectors::generate());
    }

    public function testCommittedPhpVectorsAreCurrent(): void
    {
        $json = file_get_contents(CryptoVectors::FIXTURE_DIR . 'crypto-vectors-php.json');
        self::assertIsString($json);
        self::verify(json_decode($json, true, flags: JSON_THROW_ON_ERROR));
    }

    public function testWrongDataKeyFails(): void
    {
        $v = self::referenceVectors();
        $this->expectException(CryptoException::class);
        Envelope::decryptField(random_bytes(32), $v['fields'][0]['envelope'], $v['fields'][0]['aad']);
    }

    public function testWrongAadFails(): void
    {
        $v = self::referenceVectors();
        $dataKey = (string) base64_decode($v['dataKey'], true);
        $this->expectException(CryptoException::class);
        Envelope::decryptField($dataKey, $v['fields'][0]['envelope'], Envelope::messageFieldAad('subject', CryptoVectors::ACCOUNT_ID));
    }

    public function testWrongMasterKeyFails(): void
    {
        $v = self::referenceVectors();
        $this->expectException(CryptoException::class);
        Envelope::unwrapDataKey(random_bytes(32), $v['wrappedDek']);
    }

    /** @return iterable<string, array{string}> */
    public static function tamperedFields(): iterable
    {
        $v = self::referenceVectors();
        $raw = (string) base64_decode(substr($v['fields'][0]['envelope'], 7), true);
        $flip = static fn(string $s, int $pos): string => substr_replace($s, \chr(\ord($s[$pos]) ^ 1), $pos, 1);
        yield 'tag modified' => ['fma.f1.' . base64_encode($flip($raw, \strlen($raw) - 1))];
        yield 'ciphertext modified' => ['fma.f1.' . base64_encode($flip($raw, 12))];
        yield 'nonce modified' => ['fma.f1.' . base64_encode($flip($raw, 0))];
        yield 'tag shortened' => ['fma.f1.' . base64_encode(substr($raw, 0, -4))];
        yield 'too short' => ['fma.f1.' . base64_encode(substr($raw, 0, 20))];
        yield 'wrong prefix' => ['fma.f2.' . base64_encode($raw)];
    }

    #[DataProvider('tamperedFields')]
    public function testTamperedFieldFails(string $envelope): void
    {
        $v = self::referenceVectors();
        $dataKey = (string) base64_decode($v['dataKey'], true);
        $this->expectException(CryptoException::class);
        Envelope::decryptField($dataKey, $envelope, $v['fields'][0]['aad']);
    }

    public function testTamperedBytesFail(): void
    {
        $v = self::referenceVectors();
        $dataKey = (string) base64_decode($v['dataKey'], true);
        $env = (string) base64_decode($v['bytes']['envelope'], true);
        $env[\strlen($env) - 1] = \chr(\ord($env[\strlen($env) - 1]) ^ 0x80);
        $this->expectException(CryptoException::class);
        Envelope::decryptBytes($dataKey, $env, $v['bytes']['aad']);
    }

    public function testRejectsInvalidMasterKey(): void
    {
        $this->expectException(CryptoException::class);
        Envelope::loadMasterKey(base64_encode(random_bytes(16)));
    }

    public function testErrorMessagesContainNoSecrets(): void
    {
        $dataKey = random_bytes(32);
        $aad = Envelope::pushKeysAad('https://push.example.org/secret-endpoint');
        $envelope = Envelope::encryptField($dataKey, 'top secret', $aad);
        try {
            Envelope::decryptField(random_bytes(32), $envelope, $aad);
            self::fail('expected exception');
        } catch (CryptoException $e) {
            self::assertStringNotContainsString('secret', $e->getMessage());
        }
    }

    public function testBackupRoundTripsAtChunkBoundaries(): void
    {
        $key = random_bytes(32);
        foreach ([0, 1, Backup::CHUNK_BYTES - 1, Backup::CHUNK_BYTES, Backup::CHUNK_BYTES + 1, 2 * Backup::CHUNK_BYTES] as $len) {
            $data = $len > 0 ? random_bytes($len) : '';
            $enc = self::encryptBackup($key, $data);
            $chunks = intdiv(max($len - 1, 0), Backup::CHUNK_BYTES) + 1;
            self::assertSame(7 + 16 + $len + 16 * $chunks, \strlen($enc), "length {$len}");
            self::assertSame($data, self::decryptBackup($key, $enc), "length {$len}");
        }
    }

    public function testBackupRejectsWrongKeyTruncationAndAppending(): void
    {
        $key = random_bytes(32);
        $enc = self::encryptBackup($key, random_bytes(Backup::CHUNK_BYTES + 10));
        $cases = [
            'wrong key' => [random_bytes(32), $enc],
            'truncated after first chunk' => [$key, substr($enc, 0, 23 + Backup::CHUNK_BYTES + 16)],
            'truncated in last chunk' => [$key, substr($enc, 0, -5)],
            'appended data' => [$key, $enc . 'x'],
            'not a backup' => [$key, 'hello world, this is plain text'],
        ];
        foreach ($cases as $name => [$k, $data]) {
            try {
                self::decryptBackup($k, $data);
                self::fail("expected failure: {$name}");
            } catch (BackupDecryptException) {
                $this->addToAssertionCount(1);
            }
        }
    }
}
