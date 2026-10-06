<?php

declare(strict_types=1);

namespace Fma\Backup;

/**
 * Userland stream that connects Fma\Crypto\Backup's resource API to PHP
 * code without temp files: a reader pulls its bytes from a callback (e.g. a
 * generator of backup records), a writer pushes every written piece into a
 * callback (e.g. the record parser). Exceptions thrown by the callbacks
 * propagate out of fread()/fwrite().
 *
 * @internal
 */
final class CallbackStream
{
    private const PROTOCOL = 'fma-callback';

    /** @var resource|null set by PHP */
    public $context;

    private ?\Closure $read = null;
    private ?\Closure $write = null;
    private string $buffer = '';
    private bool $eof = false;

    /**
     * @param \Closure(): ?string $next next piece, null at the end
     *
     * @return resource
     */
    public static function reader(\Closure $next)
    {
        return self::open('rb', ['read' => $next]);
    }

    /**
     * @param \Closure(string): void $consume
     *
     * @return resource
     */
    public static function writer(\Closure $consume)
    {
        return self::open('wb', ['write' => $consume]);
    }

    /**
     * @param array<string, \Closure> $options
     *
     * @return resource
     */
    private static function open(string $mode, array $options)
    {
        if (!\in_array(self::PROTOCOL, stream_get_wrappers(), true)) {
            stream_wrapper_register(self::PROTOCOL, self::class);
        }
        $stream = fopen(self::PROTOCOL . '://stream', $mode, false, stream_context_create([self::PROTOCOL => $options]));
        if ($stream === false) {
            throw new \RuntimeException('cannot open callback stream');
        }

        return $stream;
    }

    public function stream_open(string $path, string $mode, int $options, ?string &$openedPath): bool
    {
        if ($this->context === null) {
            return false;
        }
        $config = stream_context_get_options($this->context)[self::PROTOCOL] ?? [];
        $this->read = ($config['read'] ?? null) instanceof \Closure ? $config['read'] : null;
        $this->write = ($config['write'] ?? null) instanceof \Closure ? $config['write'] : null;

        return $this->read !== null || $this->write !== null;
    }

    public function stream_read(int $count): string|false
    {
        if ($this->read === null) {
            return false;
        }
        while (\strlen($this->buffer) < $count && !$this->eof) {
            $piece = ($this->read)();
            if (!\is_string($piece)) {
                $this->eof = true;
            } else {
                $this->buffer .= $piece;
            }
        }
        $out = substr($this->buffer, 0, $count);
        $this->buffer = (string) substr($this->buffer, $count);

        return $out;
    }

    public function stream_eof(): bool
    {
        return $this->eof && $this->buffer === '';
    }

    public function stream_write(string $data): int
    {
        if ($this->write === null) {
            return 0;
        }
        ($this->write)($data);

        return \strlen($data);
    }

    /** @return array<int|string, int> */
    public function stream_stat(): array
    {
        return [];
    }
}
