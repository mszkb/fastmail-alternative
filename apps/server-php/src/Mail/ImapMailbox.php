<?php

declare(strict_types=1);

namespace Fma\Mail;

/**
 * Mailbox-level IMAP commands for message_sync (#103) on top of
 * ImapClient: EXAMINE with CONDSTORE (RFC 7162), UID SEARCH, flag
 * listings (full or CHANGEDSINCE), metadata FETCH by explicit UID sets
 * and the raw BODY.PEEK[] download. Responses are parsed with
 * ImapClient::tokens(); no server text ends up in exceptions.
 */
final class ImapMailbox
{
    /** Header fields fetched with the envelope (References, envelope recipients). */
    public const HEADER_FIELDS = 'REFERENCES DELIVERED-TO X-ORIGINAL-TO';

    private bool $condstore = false;

    public function __construct(private readonly ImapClient $client) {}

    public function client(): ImapClient
    {
        return $this->client;
    }

    /** Whether CONDSTORE was enabled with the last examine(). */
    public function condstoreEnabled(): bool
    {
        return $this->condstore;
    }

    /**
     * Opens a mailbox read-only (EXAMINE); with CONDSTORE announced the
     * `(CONDSTORE)` parameter enables it for the session (RFC 7162 3.1).
     *
     * @return array{uidValidity: int, uidNext: int, exists: int, highestModseq: ?int, noModseq: bool}
     */
    public function examine(string $path): array
    {
        $this->condstore = \in_array('CONDSTORE', $this->client->capabilities(), true);
        $command = 'EXAMINE ' . ImapClient::quote(ImapClient::encodeMailbox($path)) . ($this->condstore ? ' (CONDSTORE)' : '');
        $state = ['uidValidity' => 0, 'uidNext' => 0, 'exists' => 0, 'highestModseq' => null, 'noModseq' => false];
        foreach ($this->client->command($command) as $line) {
            if (preg_match('/^\* (\d+) EXISTS/i', $line, $m) === 1) {
                $state['exists'] = (int) $m[1];
            } elseif (preg_match('/\[UIDVALIDITY (\d+)\]/i', $line, $m) === 1) {
                $state['uidValidity'] = (int) $m[1];
            } elseif (preg_match('/\[UIDNEXT (\d+)\]/i', $line, $m) === 1) {
                $state['uidNext'] = (int) $m[1];
            } elseif (preg_match('/\[HIGHESTMODSEQ (\d+)\]/i', $line, $m) === 1) {
                $state['highestModseq'] = (int) $m[1];
            } elseif (preg_match('/\[NOMODSEQ\]/i', $line) === 1) {
                $state['noModseq'] = true;
            }
        }

        return $state;
    }

    /**
     * UID SEARCH with already formatted criteria (e.g. `ALL`, `SINCE 1-Jan-2026`).
     *
     * @return list<int> ascending
     */
    public function searchUids(string $criteria): array
    {
        $uids = [];
        foreach ($this->client->command("UID SEARCH {$criteria}") as $line) {
            foreach (self::searchResult($line) ?? [] as $uid) {
                $uids[] = $uid;
            }
        }
        sort($uids);

        return array_values(array_unique($uids));
    }

    /**
     * UIDs of a `* SEARCH` line, null for other lines. Parsed without a
     * repeating regex: with tens of thousands of UIDs that hits the PCRE
     * limits, preg_match() fails and every message would look expunged.
     * Stops at the first non-number (e.g. CONDSTORE's `(MODSEQ n)`).
     *
     * @return list<int>|null
     */
    public static function searchResult(string $line): ?array
    {
        $line = rtrim($line, "\r\n");
        if (strncasecmp($line, '* SEARCH', 8) !== 0 || (\strlen($line) > 8 && $line[8] !== ' ')) {
            return null;
        }
        $uids = [];
        foreach (explode(' ', substr($line, 9)) as $token) {
            if ($token === '') {
                continue;
            }
            if (!ctype_digit($token)) {
                break;
            }
            $uids[] = (int) $token;
        }

        return $uids;
    }

    /** IMAP date of a SEARCH SINCE criterion (calendar day in UTC). */
    public static function searchDate(\DateTimeInterface $day): string
    {
        return (new \DateTimeImmutable('@' . $day->getTimestamp()))->format('j-M-Y');
    }

    /**
     * UID and flags of all messages (by sequence range 1:*, only on a
     * non-empty mailbox: Dovecot rejects 1:* otherwise).
     *
     * @return array<int, list<string>> uid -> flags, ascending by uid
     */
    public function allFlags(): array
    {
        return $this->flagsOf($this->client->command('FETCH 1:* (UID FLAGS)'));
    }

    /**
     * Flags of the messages changed since a modseq (CONDSTORE).
     *
     * @return array<int, list<string>>
     */
    public function flagsChangedSince(int $modseq): array
    {
        return $this->flagsOf($this->client->command("FETCH 1:* (UID FLAGS) (CHANGEDSINCE {$modseq})"));
    }

    /**
     * @param list<string> $lines
     *
     * @return array<int, list<string>>
     */
    private function flagsOf(array $lines): array
    {
        $result = [];
        foreach ($lines as $line) {
            $attrs = self::parseFetch($line);
            if ($attrs === null || !isset($attrs['UID'])) {
                continue;
            }
            $result[(int) $attrs['UID']] = self::flagList($attrs['FLAGS'] ?? []);
        }
        ksort($result);

        return $result;
    }

    /**
     * Metadata of the given UIDs (explicit UID set, never `n:*`).
     *
     * @param list<int> $uids
     *
     * @return array<int, array{uid: int, flags: list<string>, modseq: ?int, size: int, envelope: array{date: ?string, subject: string, from: list<array{name: string, address: string}>, replyTo: list<array{name: string, address: string}>, to: list<array{name: string, address: string}>, cc: list<array{name: string, address: string}>, inReplyTo: ?string, messageId: ?string}, hasAttachments: bool, headers: string}>
     */
    public function fetchMetadata(array $uids): array
    {
        if ($uids === []) {
            return [];
        }
        $wanted = array_flip($uids);
        $items = 'UID FLAGS RFC822.SIZE ENVELOPE BODYSTRUCTURE' . ($this->condstore ? ' MODSEQ' : '') . ' BODY.PEEK[HEADER.FIELDS (' . self::HEADER_FIELDS . ')]';
        $result = [];
        foreach ($this->client->command('UID FETCH ' . self::uidSet($uids) . " ({$items})") as $line) {
            $attrs = self::parseFetch($line);
            if ($attrs === null || !isset($attrs['UID'])) {
                continue;
            }
            $uid = (int) $attrs['UID'];
            if (!isset($wanted[$uid])) {
                continue;
            }
            $structure = $attrs['BODYSTRUCTURE'] ?? null;
            $modseq = $attrs['MODSEQ'] ?? null;
            $result[$uid] = [
                'uid' => $uid,
                'flags' => self::flagList($attrs['FLAGS'] ?? []),
                'modseq' => \is_array($modseq) && isset($modseq[0]) && is_numeric($modseq[0]) ? (int) $modseq[0] : null,
                'size' => is_numeric($attrs['RFC822.SIZE'] ?? null) ? (int) $attrs['RFC822.SIZE'] : 0,
                'envelope' => self::envelope($attrs['ENVELOPE'] ?? null),
                // Multipart at the top level (imapflow: bodyStructure.childNodes.length).
                'hasAttachments' => \is_array($structure) && isset($structure[0]) && \is_array($structure[0]),
                'headers' => \is_string($attrs['BODY[HEADER]'] ?? null) ? $attrs['BODY[HEADER]'] : '',
            ];
        }
        ksort($result);

        return $result;
    }

    /**
     * Raw RFC-822 source of one UID; null when the UID is gone. The whole
     * literal is read (ImapClient buffers it), callers check the size first.
     */
    public function fetchRaw(int $uid): ?string
    {
        foreach ($this->client->command("UID FETCH {$uid} (UID BODY.PEEK[])") as $line) {
            $attrs = self::parseFetch($line);
            if ($attrs !== null && (int) ($attrs['UID'] ?? 0) === $uid && \is_string($attrs['BODY[]'] ?? null)) {
                return $attrs['BODY[]'];
            }
        }

        return null;
    }

    /**
     * Compact UID set: 1,2,3,7 -> "1:3,7".
     *
     * @param list<int> $uids
     */
    public static function uidSet(array $uids): string
    {
        $uids = array_values(array_unique(array_map('intval', $uids)));
        sort($uids);
        $parts = [];
        $count = \count($uids);
        for ($i = 0; $i < $count; ++$i) {
            $start = $uids[$i];
            while ($i + 1 < $count && $uids[$i + 1] === $uids[$i] + 1) {
                ++$i;
            }
            $parts[] = $start === $uids[$i] ? (string) $start : "{$start}:{$uids[$i]}";
        }

        return implode(',', $parts);
    }

    /**
     * Attributes of a `* n FETCH (...)` line, keyed by upper-case name;
     * body sections become `BODY[]` (whole message) or `BODY[HEADER]`
     * (any other section). Null for other responses.
     *
     * @return array<string, mixed>|null
     */
    public static function parseFetch(string $line): ?array
    {
        if (preg_match('/^\* \d+ FETCH /i', $line, $m) !== 1) {
            return null;
        }
        $tokens = ImapClient::tokens(rtrim(substr($line, \strlen($m[0])), "\r\n"));
        $list = $tokens[0] ?? null;
        if (!\is_array($list)) {
            return null;
        }
        $attrs = [];
        $count = \count($list);
        for ($i = 0; $i < $count; ++$i) {
            $name = $list[$i];
            if (!\is_string($name)) {
                continue;
            }
            $name = strtoupper($name);
            if (str_starts_with($name, 'BODY[') || str_starts_with($name, 'BINARY[')) {
                // "BODY[HEADER.FIELDS" (list) "]" or "BODY[]" / "BODY[]<0>".
                while (!str_contains($name, ']') && $i + 1 < $count) {
                    $next = $list[++$i];
                    if (\is_string($next) && str_contains($next, ']')) {
                        $name .= ']';
                    }
                }
                $name = str_starts_with($name, 'BODY[]') ? 'BODY[]' : 'BODY[HEADER]';
            }
            $attrs[$name] = $list[$i + 1] ?? null;
            ++$i;
        }

        return $attrs;
    }

    /** @return list<string> */
    private static function flagList(mixed $value): array
    {
        return \is_array($value) ? array_values(array_map('strval', array_filter($value, 'is_string'))) : [];
    }

    /**
     * Envelope (RFC 3501 7.4.2) with decoded subject and address names.
     *
     * @return array{date: ?string, subject: string, from: list<array{name: string, address: string}>, replyTo: list<array{name: string, address: string}>, to: list<array{name: string, address: string}>, cc: list<array{name: string, address: string}>, inReplyTo: ?string, messageId: ?string}
     */
    public static function envelope(mixed $value): array
    {
        $env = \is_array($value) ? array_values($value) : [];
        $text = static fn(int $i): ?string => isset($env[$i]) && \is_string($env[$i]) ? $env[$i] : null;

        return [
            'date' => $text(0),
            'subject' => self::decodeHeader($text(1) ?? ''),
            'from' => self::addresses($env[2] ?? null),
            'replyTo' => self::addresses($env[4] ?? null),
            'to' => self::addresses($env[5] ?? null),
            'cc' => self::addresses($env[6] ?? null),
            'inReplyTo' => ($text(8) ?? '') !== '' ? trim((string) $text(8)) : null,
            'messageId' => ($text(9) ?? '') !== '' ? trim((string) $text(9)) : null,
        ];
    }

    /** @return list<array{name: string, address: string}> */
    private static function addresses(mixed $value): array
    {
        if (!\is_array($value)) {
            return [];
        }
        $list = [];
        foreach ($value as $entry) {
            // (name adl mailbox host); host NIL marks group start/end.
            if (!\is_array($entry) || !\is_string($entry[2] ?? null) || !\is_string($entry[3] ?? null)) {
                continue;
            }
            $list[] = [
                'name' => self::decodeHeader(\is_string($entry[0] ?? null) ? $entry[0] : ''),
                'address' => self::utf8($entry[2] . '@' . $entry[3]),
            ];
        }

        return $list;
    }

    /** RFC 2047 encoded words to UTF-8; invalid bytes are read as Latin-1. */
    public static function decodeHeader(string $value): string
    {
        if (str_contains($value, '=?')) {
            $decoded = @iconv_mime_decode($value, \ICONV_MIME_DECODE_CONTINUE_ON_ERROR, 'UTF-8');
            if (\is_string($decoded)) {
                $value = $decoded;
            }
        }

        return self::utf8($value);
    }

    private static function utf8(string $value): string
    {
        return mb_check_encoding($value, 'UTF-8') ? $value : mb_convert_encoding($value, 'UTF-8', 'ISO-8859-1');
    }
}
