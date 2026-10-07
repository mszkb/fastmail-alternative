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

    /**
     * All mailboxes (LIST, with RETURN (SPECIAL-USE) when supported).
     * Paths are decoded from modified UTF-7 to UTF-8, like imapflow does.
     *
     * @return list<array{path: string, delimiter: ?string, flags: list<string>, specialUse: ?string}>
     */
    public function list(): array
    {
        $command = \in_array('SPECIAL-USE', $this->capabilities, true) ? 'LIST "" "*" RETURN (SPECIAL-USE)' : 'LIST "" "*"';
        $mailboxes = [];
        foreach ($this->command($command) as $line) {
            if (preg_match('/^\* LIST /i', $line) !== 1) {
                continue;
            }
            $tokens = self::tokens(substr(rtrim($line, "\r\n"), 7));
            if (\count($tokens) < 3 || !\is_array($tokens[0])) {
                continue;
            }
            $flags = array_values(array_map('strval', $tokens[0]));
            $specialUse = null;
            foreach ($flags as $flag) {
                if (\in_array(strtolower($flag), ['\\sent', '\\drafts', '\\trash', '\\junk', '\\archive', '\\all', '\\flagged'], true)) {
                    $specialUse = $flag;
                }
            }
            $mailboxes[] = [
                'path' => self::decodeMailbox((string) $tokens[2]),
                'delimiter' => $tokens[1] === null ? null : (string) $tokens[1],
                'flags' => $flags,
                'specialUse' => $specialUse,
            ];
        }

        return $mailboxes;
    }

    /** @return array{uidNext: ?int, unseen: ?int} */
    public function status(string $path): array
    {
        $status = ['uidNext' => null, 'unseen' => null];
        foreach ($this->command('STATUS ' . self::quote(self::encodeMailbox($path)) . ' (UIDNEXT UNSEEN)') as $line) {
            if (preg_match('/UIDNEXT (\d+)/i', $line, $m) === 1) {
                $status['uidNext'] = (int) $m[1];
            }
            if (preg_match('/UNSEEN (\d+)/i', $line, $m) === 1) {
                $status['unseen'] = (int) $m[1];
            }
        }

        return $status;
    }

    public static function decodeMailbox(string $name): string
    {
        return str_contains($name, '&') ? mb_convert_encoding($name, 'UTF-8', 'UTF7-IMAP') : $name;
    }

    public static function encodeMailbox(string $path): string
    {
        return preg_match('/[&\x80-\xFF]/', $path) === 1 ? mb_convert_encoding($path, 'UTF7-IMAP', 'UTF-8') : $path;
    }

    /**
     * Tokens of an IMAP response: atoms, quoted strings, literals ({n} with
     * the data inline, as finish() joins them), NIL and parenthesized lists.
     *
     * @return list<mixed>
     */
    public static function tokens(string $text): array
    {
        $pos = 0;

        return self::parseList($text, $pos, false);
    }

    /** @return list<mixed> */
    private static function parseList(string $text, int &$pos, bool $nested): array
    {
        $items = [];
        $length = \strlen($text);
        while ($pos < $length) {
            $char = $text[$pos];
            if ($char === ' ') {
                ++$pos;
            } elseif ($char === '(') {
                ++$pos;
                $items[] = self::parseList($text, $pos, true);
            } elseif ($char === ')') {
                ++$pos;
                if ($nested) {
                    return $items;
                }
            } elseif ($char === '"') {
                $value = '';
                for (++$pos; $pos < $length && $text[$pos] !== '"'; ++$pos) {
                    if ($text[$pos] === '\\' && $pos + 1 < $length) {
                        ++$pos;
                    }
                    $value .= $text[$pos];
                }
                ++$pos;
                $items[] = $value;
            } elseif ($char === '{' && preg_match('/\G\{(\d+)\+?\}\r\n/', $text, $m, 0, $pos) === 1) {
                $pos += \strlen($m[0]);
                $items[] = substr($text, $pos, (int) $m[1]);
                $pos += (int) $m[1];
            } else {
                preg_match('/\G[^ ()]+/', $text, $m, 0, $pos);
                $atom = $m[0] ?? $char;
                $pos += max(1, \strlen($atom));
                $items[] = strtoupper($atom) === 'NIL' ? null : $atom;
            }
        }

        return $items;
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

    /**
     * Sends a command made of text parts and literals (odd indexes are
     * literal data: non-synchronizing with LITERAL+, otherwise after the
     * server's continuation) and returns the untagged lines plus the tagged
     * OK line (response codes such as COPYUID). NO/BAD throws PROTOCOL.
     *
     * @param list<string> $parts text, literal, text, literal, ...
     *
     * @return array{untagged: list<string>, tagged: string}
     */
    public function execute(#[\SensitiveParameter] array $parts): array
    {
        $tag = 'A' . (++$this->tag);
        $literalPlus = \in_array('LITERAL+', $this->capabilities, true);
        $buffer = "{$tag} ";
        foreach ($parts as $index => $part) {
            if ($index % 2 === 0) {
                $buffer .= $part;
                continue;
            }
            $length = \strlen($part);
            if ($literalPlus) {
                $buffer .= "{{$length}+}\r\n{$part}";
                continue;
            }
            $this->socket->write("{$buffer}{{$length}}\r\n");
            $buffer = '';
            $line = $this->socket->readLine();
            if (!str_starts_with($line, '+')) {
                // Tagged NO/BAD instead of a continuation.
                throw new MailException('PROTOCOL', 'literal rejected');
            }
            $buffer = $part;
        }
        $this->socket->write("{$buffer}\r\n");
        $untagged = [];
        while (true) {
            $line = $this->socket->readLine();
            if (str_starts_with($line, "{$tag} ")) {
                if (strtoupper(substr($line, \strlen($tag) + 1, 2)) !== 'OK') {
                    throw new MailException('PROTOCOL', 'command rejected');
                }

                return ['untagged' => $untagged, 'tagged' => rtrim($line, "\r\n")];
            }
            while (preg_match('/\{(\d+)\}\r\n$/', $line, $m) === 1) {
                $line .= $this->socket->read((int) $m[1]) . $this->socket->readLine();
            }
            $untagged[] = $line;
        }
    }

    // --- IMAP IDLE (RFC 2177) for the long-running worker (Jobs\IdleManager) ---

    /** @return resource the connection's stream, for stream_select */
    public function stream()
    {
        return $this->socket->stream();
    }

    /** Sends IDLE without waiting for the continuation; returns its tag. */
    public function sendIdle(): string
    {
        $tag = 'A' . (++$this->tag);
        $this->socket->write("{$tag} IDLE\r\n");

        return $tag;
    }

    /** Ends IDLE; the tagged completion arrives via readAvailable(). */
    public function sendDone(): void
    {
        $this->socket->write("DONE\r\n");
    }

    /** Non-blocking: raw data available now ('' if none); EOF throws ECONNRESET. */
    public function readAvailable(): string
    {
        return $this->socket->readAvailable();
    }

    /** Closes the connection without LOGOUT. */
    public function disconnect(): void
    {
        $this->socket->close();
    }
}
