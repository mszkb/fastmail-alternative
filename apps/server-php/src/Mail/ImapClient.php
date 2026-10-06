<?php

declare(strict_types=1);

namespace Fma\Mail;

/**
 * Small IMAP4rev1 client (ADR-0013: own client, no ext-imap). This part
 * covers connect, CAPABILITY, mandatory STARTTLS on plain ports, LOGIN and
 * LOGOUT; the commands for sync (SELECT/FETCH/STORE/...) follow with #103.
 */
final class ImapClient
{
    private int $tag = 0;
    /** @var list<string> */
    private array $capabilities = [];

    private function __construct(private readonly MailSocket $socket) {}

    public static function connect(TransportPolicy $policy, HostConfig $config, float $timeout = 15.0): self
    {
        $client = new self(MailSocket::open($policy, 'imap', $config->host, $config->port, $config->secure, $timeout));
        try {
            $greeting = $client->socket->readLine();
            if (!str_starts_with($greeting, '* OK') && !str_starts_with($greeting, '* PREAUTH')) {
                throw new MailException('PROTOCOL', 'unexpected greeting');
            }
            $client->capabilities = self::parseCapabilities($greeting) ?? $client->fetchCapabilities();
            if (!$config->secure && !$policy->insecureTransport) {
                // Never send the password in plain text: STARTTLS or nothing.
                if (!\in_array('STARTTLS', $client->capabilities, true)) {
                    throw new MailException('TLS_REQUIRED', 'server does not support STARTTLS');
                }
                $client->command('STARTTLS');
                $client->socket->startTls();
                $client->capabilities = $client->fetchCapabilities();
            }
            if (\in_array('LOGINDISABLED', $client->capabilities, true)) {
                throw new MailException('AUTH_FAILED', 'login disabled');
            }
            try {
                $client->login($config->user, $config->password);
            } catch (MailException $e) {
                throw $e->errorCode === 'PROTOCOL' ? new MailException('AUTH_FAILED', 'login rejected') : $e;
            }
            $client->capabilities = $client->fetchCapabilities();
        } catch (\Throwable $e) {
            $client->socket->close();
            throw $e;
        }

        return $client;
    }

    /**
     * LOGIN with quoted strings for 7-bit credentials; 8-bit ones (quoted
     * strings must be 7-bit) go via AUTHENTICATE PLAIN (base64 of UTF-8).
     */
    private function login(string $user, #[\SensitiveParameter] string $password): void
    {
        if (preg_match('/[\x80-\xFF]/', $user . $password) !== 1) {
            $this->command('LOGIN ' . self::quote($user) . ' ' . self::quote($password));

            return;
        }
        if (!\in_array('AUTH=PLAIN', $this->capabilities, true)) {
            throw new MailException('AUTH_FAILED', 'no login method for 8-bit credentials');
        }
        $tag = 'A' . (++$this->tag);
        $this->socket->write("{$tag} AUTHENTICATE PLAIN\r\n");
        if (!str_starts_with($this->socket->readLine(), '+')) {
            throw new MailException('PROTOCOL', 'no continuation');
        }
        $this->socket->write(base64_encode("\0{$user}\0{$password}") . "\r\n");
        $this->finish($tag);
    }

    /** @return list<string> */
    public function capabilities(): array
    {
        return $this->capabilities;
    }

    public function logout(): void
    {
        try {
            $this->command('LOGOUT');
        } catch (MailException) {
            // The server may close first; nothing to do.
        } finally {
            $this->socket->close();
        }
    }

    /**
     * Sends a command and returns the untagged lines; a NO/BAD completion
     * throws PROTOCOL (server text not included).
     *
     * @return list<string>
     */
    public function command(#[\SensitiveParameter] string $command): array
    {
        $tag = 'A' . (++$this->tag);
        $this->socket->write("{$tag} {$command}\r\n");

        return $this->finish($tag);
    }

    /**
     * Reads until the tagged completion of `$tag`.
     *
     * @return list<string>
     */
    private function finish(string $tag): array
    {
        $untagged = [];
        while (true) {
            $line = $this->socket->readLine();
            if (str_starts_with($line, "{$tag} ")) {
                $status = strtoupper(substr($line, \strlen($tag) + 1, 2));
                if ($status !== 'OK') {
                    throw new MailException('PROTOCOL', 'command rejected');
                }

                return $untagged;
            }
            // Literal {n}: read n bytes and the rest of the line.
            while (preg_match('/\{(\d+)\}\r\n$/', $line, $m) === 1) {
                $line .= $this->socket->read((int) $m[1]) . $this->socket->readLine();
            }
            $untagged[] = $line;
        }
    }

    /** @return list<string> */
    private function fetchCapabilities(): array
    {
        foreach ($this->command('CAPABILITY') as $line) {
            if (preg_match('/^\* CAPABILITY (.*)$/i', rtrim($line), $m) === 1) {
                return self::words($m[1]);
            }
        }

        return [];
    }

    /** @return list<string>|null capabilities from a `[CAPABILITY ...]` response code */
    private static function parseCapabilities(string $line): ?array
    {
        return preg_match('/\[CAPABILITY ([^\]]*)\]/i', $line, $m) === 1 ? self::words($m[1]) : null;
    }

    /** @return list<string> */
    private static function words(string $text): array
    {
        return array_values(array_map('strtoupper', array_filter(explode(' ', trim($text)), static fn(string $w): bool => $w !== '')));
    }

    /** IMAP quoted string (7-bit, no CR/LF/NUL). */
    public static function quote(#[\SensitiveParameter] string $value): string
    {
        if (preg_match('/[\r\n\x00]/', $value) === 1) {
            throw new MailException('PROTOCOL', 'invalid characters');
        }

        return '"' . str_replace(['\\', '"'], ['\\\\', '\\"'], $value) . '"';
    }
}
