<?php

declare(strict_types=1);

namespace Fma\Mail;

/**
 * IMAP commands for search (GET /api/accounts/{id}/search) and the
 * message_action write-back: SELECT/EXAMINE, UID SEARCH, UID STORE, UID
 * MOVE (or COPY + \Deleted + EXPUNGE) and permanent deletes. UID commands
 * only - another client may expunge concurrently.
 */
final class ImapActions
{
    public function __construct(private readonly ImapClient $client) {}

    /**
     * SELECT (read-write) or EXAMINE (read-only) a mailbox.
     *
     * @return array{uidValidity: ?string, exists: int}
     */
    public function select(string $path, bool $readOnly = false): array
    {
        $lines = $this->client->command(($readOnly ? 'EXAMINE ' : 'SELECT ') . ImapClient::quote(ImapClient::encodeMailbox($path)));
        $result = ['uidValidity' => null, 'exists' => 0];
        foreach ($lines as $line) {
            if (preg_match('/^\* OK \[UIDVALIDITY (\d+)\]/i', $line, $m) === 1) {
                $result['uidValidity'] = ltrim($m[1], '0') ?: '0';
            } elseif (preg_match('/^\* (\d+) EXISTS/i', $line, $m) === 1) {
                $result['exists'] = (int) $m[1];
            }
        }

        return $result;
    }

    /**
     * UID SEARCH of the selected mailbox; matching UIDs, highest first.
     *
     * @param list<string> $parts criteria as for ImapClient::execute() (odd indexes are literals)
     *
     * @return list<int>
     */
    public function search(array $parts, bool $utf8 = false): array
    {
        $parts[0] = 'UID SEARCH ' . ($utf8 ? 'CHARSET UTF-8 ' : '') . $parts[0];
        $uids = [];
        foreach ($this->client->execute($parts)['untagged'] as $line) {
            if (preg_match('/^\* SEARCH\b(.*)$/i', rtrim($line), $m) === 1) {
                foreach (explode(' ', trim($m[1])) as $word) {
                    if (ctype_digit($word) && (int) $word > 0) {
                        $uids[(int) $word] = true;
                    }
                }
            }
        }
        $uids = array_keys($uids);
        rsort($uids);

        return $uids;
    }

    /**
     * Search criteria of a validated query (see SearchRoutes::parseQuery):
     * TEXT/FROM/SUBJECT as quoted strings, or as literals with CHARSET UTF-8
     * when not 7-bit; SINCE/BEFORE as IMAP dates.
     *
     * @param array{q?: string, from?: string, subject?: string, since?: string, before?: string} $query
     *
     * @return array{parts: list<string>, utf8: bool}
     */
    public static function searchCriteria(array $query): array
    {
        $text = [];
        foreach (['q' => 'TEXT', 'from' => 'FROM', 'subject' => 'SUBJECT'] as $key => $keyword) {
            if (isset($query[$key]) && $query[$key] !== '') {
                $text[$keyword] = $query[$key];
            }
        }
        $utf8 = false;
        foreach ($text as $value) {
            if (preg_match('/[\x80-\xFF]/', $value) === 1) {
                $utf8 = true;
            }
        }
        $parts = [''];
        $append = static function (string $text) use (&$parts): void {
            $last = \count($parts) - 1;
            $parts[$last] .= ($parts[$last] === '' || str_ends_with($parts[$last], ' ') ? '' : ' ') . $text;
        };
        foreach ($text as $keyword => $value) {
            if ($utf8) {
                $append($keyword . ' ');
                $parts[] = $value;
                $parts[] = ' ';
            } else {
                $append($keyword . ' ' . ImapClient::quote($value));
            }
        }
        foreach (['since' => 'SINCE', 'before' => 'BEFORE'] as $key => $keyword) {
            if (isset($query[$key])) {
                $append($keyword . ' ' . self::imapDate($query[$key]));
            }
        }
        if ($parts === ['']) {
            $parts = ['ALL'];
        }
        // No trailing space after a final literal.
        if (\count($parts) > 1 && trim((string) end($parts)) === '') {
            array_pop($parts);
        }

        return ['parts' => $parts, 'utf8' => $utf8];
    }

    /** `YYYY-MM-DD` as IMAP date (`1-Feb-2026`). */
    public static function imapDate(string $day): string
    {
        $date = \DateTimeImmutable::createFromFormat('!Y-m-d', $day, new \DateTimeZone('UTC'));
        if ($date === false) {
            throw new \InvalidArgumentException('invalid date');
        }

        return $date->format('j-M-Y');
    }

    /**
     * Which of the given UIDs still exist in the selected mailbox.
     *
     * @param list<int> $uids
     *
     * @return list<int>
     */
    public function existingUids(array $uids): array
    {
        if ($uids === []) {
            return [];
        }
        $found = array_flip($this->search(['UID ' . self::uidSet($uids)]));

        return array_values(array_filter($uids, static fn(int $uid): bool => isset($found[$uid])));
    }

    /** @param list<int> $uids */
    public function storeFlag(array $uids, string $flag, bool $add): void
    {
        if ($uids === []) {
            return;
        }
        $this->client->command('UID STORE ' . self::uidSet($uids) . ($add ? ' +' : ' -') . 'FLAGS.SILENT (' . self::flag($flag) . ')');
    }

    /**
     * Moves messages: UID MOVE (RFC 6851) when available, otherwise UID COPY,
     * \Deleted and expunge. Returns the COPYUID mapping (UIDPLUS) when the
     * server sent one.
     *
     * @param list<int> $uids
     *
     * @return array{uidValidity: string, map: array<int, int>}|null
     */
    public function move(array $uids, string $targetPath): ?array
    {
        if ($uids === []) {
            return null;
        }
        $target = ImapClient::quote(ImapClient::encodeMailbox($targetPath));
        $set = self::uidSet($uids);
        if (\in_array('MOVE', $this->client->capabilities(), true)) {
            $response = $this->client->execute(["UID MOVE {$set} {$target}"]);
        } else {
            $response = $this->client->execute(["UID COPY {$set} {$target}"]);
            $this->delete($uids);
        }

        return self::copyUid([...$response['untagged'], $response['tagged']]);
    }

    /**
     * Permanently deletes messages: \Deleted, then UID EXPUNGE (UIDPLUS) or
     * EXPUNGE (also removes other messages already marked \Deleted, like
     * imapflow does).
     *
     * @param list<int> $uids
     */
    public function delete(array $uids): void
    {
        if ($uids === []) {
            return;
        }
        $this->storeFlag($uids, '\Deleted', true);
        $this->client->command(\in_array('UIDPLUS', $this->client->capabilities(), true) ? 'UID EXPUNGE ' . self::uidSet($uids) : 'EXPUNGE');
    }

    /**
     * COPYUID response code: source UID => new UID in the target.
     *
     * @param list<string> $lines
     *
     * @return array{uidValidity: string, map: array<int, int>}|null
     */
    public static function copyUid(array $lines): ?array
    {
        foreach ($lines as $line) {
            if (preg_match('/\[COPYUID (\d+) ([\d:,]+) ([\d:,]+)\]/i', $line, $m) !== 1) {
                continue;
            }
            $source = self::expandUidSet($m[2]);
            $target = self::expandUidSet($m[3]);
            if ($source === null || $target === null || \count($source) !== \count($target)) {
                return null;
            }

            return ['uidValidity' => ltrim($m[1], '0') ?: '0', 'map' => array_combine($source, $target)];
        }

        return null;
    }

    /**
     * Compact UID set (`1:3,7`), sorted ascending.
     *
     * @param list<int> $uids
     */
    public static function uidSet(array $uids): string
    {
        $uids = array_values(array_unique($uids));
        sort($uids);
        $ranges = [];
        $start = $prev = null;
        foreach ($uids as $uid) {
            if ($uid <= 0) {
                throw new \InvalidArgumentException('invalid uid');
            }
            if ($prev !== null && $uid === $prev + 1) {
                $prev = $uid;
                continue;
            }
            if ($start !== null) {
                $ranges[] = $start === $prev ? (string) $start : "{$start}:{$prev}";
            }
            $start = $prev = $uid;
        }
        if ($start !== null) {
            $ranges[] = $start === $prev ? (string) $start : "{$start}:{$prev}";
        }

        return implode(',', $ranges);
    }

    /**
     * UIDs of a set in the server's order (`3:1` counts down); null when too
     * large to expand.
     *
     * @return list<int>|null
     */
    public static function expandUidSet(string $set): ?array
    {
        $uids = [];
        foreach (explode(',', $set) as $range) {
            $bounds = explode(':', $range);
            $from = (int) $bounds[0];
            $to = (int) ($bounds[1] ?? $bounds[0]);
            if (abs($to - $from) > 100_000) {
                return null;
            }
            foreach (range($from, $to) as $uid) {
                $uids[] = $uid;
            }
        }

        return $uids;
    }

    /** System flag as atom (only `\Word` flags are written). */
    private static function flag(string $flag): string
    {
        if (preg_match('/^\\\\[A-Za-z]+$/', $flag) !== 1) {
            throw new \InvalidArgumentException('invalid flag');
        }

        return $flag;
    }
}
