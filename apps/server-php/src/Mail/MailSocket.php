<?php

declare(strict_types=1);

namespace Fma\Mail;

/**
 * Line-based TCP/TLS connection to a mail server through the transport
 * policy: connects to the checked address, verifies the certificate
 * against the original hostname (SNI, peer_name) and upgrades with
 * STARTTLS on request. Server texts never end up in exceptions.
 */
final class MailSocket
{
    /** @var resource */
    private $stream;

    /** @param resource $stream */
    private function __construct($stream)
    {
        $this->stream = $stream;
    }

    /** @param 'imap'|'smtp' $protocol */
    public static function open(TransportPolicy $policy, string $protocol, string $host, int $port, bool $secure, float $timeout = 15.0): self
    {
        $target = $policy->resolveTarget($protocol, $host, $port);
        $address = str_contains($target['address'], ':') ? "[{$target['address']}]" : $target['address'];
        $ssl = $policy->insecureTransport
            ? ['verify_peer' => false, 'verify_peer_name' => false, 'allow_self_signed' => true]
            : ['verify_peer' => true, 'verify_peer_name' => true, 'allow_self_signed' => false, 'SNI_enabled' => true]
                + ($target['servername'] !== null ? ['peer_name' => $target['servername']] : []);
        $context = stream_context_create(['ssl' => $ssl + ['disable_compression' => true]]);
        $errno = 0;
        $errstr = '';
        $stream = @stream_socket_client(($secure ? 'tls' : 'tcp') . "://{$address}:{$port}", $errno, $errstr, $timeout, STREAM_CLIENT_CONNECT, $context);
        if ($stream === false) {
            throw new MailException(self::connectErrorCode($errno ?? 0, $errstr ?? '', $secure));
        }
        stream_set_timeout($stream, (int) ceil($timeout));

        return new self($stream);
    }

    private static function connectErrorCode(int $errno, string $errstr, bool $secure): string
    {
        return match (true) {
            $errno === 111 || stripos($errstr, 'refused') !== false => 'ECONNREFUSED',
            $errno === 110 || stripos($errstr, 'timed out') !== false => 'ETIMEDOUT',
            stripos($errstr, 'getaddrinfo') !== false || stripos($errstr, 'name or service') !== false => 'ENOTFOUND',
            // A TLS handshake failure (certificate, protocol) reports errno 0.
            $secure && $errno === 0 => 'ETLS',
            default => 'ECONNREFUSED',
        };
    }

    public function startTls(): void
    {
        $ok = @stream_socket_enable_crypto($this->stream, true, STREAM_CRYPTO_METHOD_TLSv1_2_CLIENT | STREAM_CRYPTO_METHOD_TLSv1_3_CLIENT);
        if ($ok !== true) {
            throw new MailException('ETLS', 'TLS handshake failed');
        }
    }

    public function readLine(): string
    {
        $line = fgets($this->stream, 65536);
        if ($line === false) {
            $meta = stream_get_meta_data($this->stream);
            throw new MailException($meta['timed_out'] ? 'ETIMEDOUT' : 'ECONNRESET', 'connection lost');
        }

        return $line;
    }

    public function read(int $length): string
    {
        $data = '';
        while (\strlen($data) < $length) {
            $part = fread($this->stream, max(1, $length - \strlen($data)));
            if ($part === false || $part === '') {
                throw new MailException('ECONNRESET', 'connection lost');
            }
            $data .= $part;
        }

        return $data;
    }

    public function write(#[\SensitiveParameter] string $data): void
    {
        $written = 0;
        while ($written < \strlen($data)) {
            $n = fwrite($this->stream, substr($data, $written));
            if ($n === false || $n === 0) {
                throw new MailException('ECONNRESET', 'connection lost');
            }
            $written += $n;
        }
    }

    public function close(): void
    {
        @fclose($this->stream);
    }

    /** @return resource the underlying stream, for stream_select (IMAP IDLE) */
    public function stream()
    {
        return $this->stream;
    }

    /**
     * Non-blocking read of everything available right now (including data
     * PHP already buffered); '' when nothing is pending. EOF throws.
     */
    public function readAvailable(): string
    {
        stream_set_blocking($this->stream, false);
        try {
            $data = '';
            while (true) {
                $chunk = @fread($this->stream, 65536);
                if ($chunk === false || $chunk === '') {
                    break;
                }
                $data .= $chunk;
            }
            if ($data === '' && feof($this->stream)) {
                throw new MailException('ECONNRESET', 'connection lost');
            }

            return $data;
        } finally {
            stream_set_blocking($this->stream, true);
        }
    }
}
