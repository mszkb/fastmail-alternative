<?php

declare(strict_types=1);

namespace Fma\Mail;

/**
 * IMAP commands of send_message and draft_sync (#105): APPEND of a raw
 * message (literal) to Sent/Drafts, SELECT with UIDVALIDITY, UID SEARCH
 * HEADER Message-ID and deleting copies by UID. No server text or mail
 * content ends up in exceptions or logs.
 */
final class ImapAppend
{
    public function __construct(private readonly ImapClient $client) {}

    /** @param list<string> $flags e.g. ['\Seen'] */
    public function append(string $path, string $raw, array $flags, \DateTimeInterface $date): void
    {
        $utc = \DateTimeImmutable::createFromInterface($date)->setTimezone(new \DateTimeZone('UTC'));
        $flagList = implode(' ', array_filter($flags, static fn(string $f): bool => preg_match('/^\\\\?[A-Za-z]+$/', $f) === 1));
        $this->client->execute([
            'APPEND ' . self::mailbox($path) . " ({$flagList}) \"" . $utc->format('d-M-Y H:i:s') . ' +0000" ',
            (string) preg_replace('/\r\n|\r|\n/', "\r\n", $raw),
            '',
        ]);
    }

    /** SELECT; returns the UIDVALIDITY (null when the server sent none). */
    public function select(string $path): ?string
    {
        foreach ($this->client->command('SELECT ' . self::mailbox($path)) as $line) {
            if (preg_match('/\[UIDVALIDITY (\d+)\]/i', $line, $m) === 1) {
                return $m[1];
            }
        }

        return null;
    }

    /**
     * UIDs of the messages in the selected folder whose Message-ID contains `$value`.
     *
     * @return list<int>
     */
    public function searchMessageId(string $value): array
    {
        $uids = [];
        foreach ($this->client->command('UID SEARCH HEADER Message-ID ' . ImapClient::quote($value)) as $line) {
            if (preg_match('/^\* SEARCH\b(.*)$/i', rtrim($line), $m) === 1) {
                foreach (preg_split('/\s+/', trim($m[1])) ?: [] as $uid) {
                    if (ctype_digit($uid)) {
                        $uids[] = (int) $uid;
                    }
                }
            }
        }

        return $uids;
    }

    /**
     * Deletes messages of the selected folder by UID (\Deleted + UID EXPUNGE,
     * plain EXPUNGE without UIDPLUS).
     *
     * @param list<int> $uids
     */
    public function deleteUids(array $uids): void
    {
        $uids = array_values(array_unique(array_filter($uids, static fn(int $uid): bool => $uid > 0)));
        if ($uids === []) {
            return;
        }
        $set = implode(',', $uids);
        $this->client->command("UID STORE {$set} +FLAGS.SILENT (\\Deleted)");
        if (\in_array('UIDPLUS', $this->client->capabilities(), true)) {
            $this->client->command("UID EXPUNGE {$set}");
        } else {
            $this->client->command('EXPUNGE');
        }
    }

    private static function mailbox(string $path): string
    {
        return ImapClient::quote(ImapClient::encodeMailbox($path));
    }
}
