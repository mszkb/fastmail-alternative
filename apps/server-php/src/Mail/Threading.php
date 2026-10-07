<?php

declare(strict_types=1);

namespace Fma\Mail;

use Fma\Crypto\Envelope;
use Fma\Db\Database;
use Fma\Db\Uuid;

/**
 * Thread assignment (roadmap 2.5), port of apps/worker/src/threading.ts
 * and the pure rules of packages/shared/src/threading.ts (simplified JWZ:
 * References/In-Reply-To, subject fallback for reply-prefixed messages
 * without references within SUBJECT_THREAD_WINDOW_SECONDS).
 *
 * Subjects are compared as `message.subject_hash`, an HMAC of the
 * normalized subject (key derived from the DEK with context
 * `thread-subject`). Instead of the PostgreSQL advisory lock the run holds
 * the mail_account row lock (FOR UPDATE) in one transaction; the
 * `references && ...` overlap uses message_reference.
 */
final class Threading
{
    public const SUBJECT_THREAD_WINDOW_SECONDS = 30 * 24 * 60 * 60;
    private const THREAD_ASSIGN_LIMIT = 500;
    private const MAX_CANDIDATES = 200;
    private const SORT_AT = 'COALESCE(sent_at, received_at, created_at)';
    private const REPLY_PREFIX_RE = '/^\s*(?:re|aw|antw|sv)\s*(?:\[\d+\]|\(\d+\))?\s*:\s*/iu';
    private const FORWARD_PREFIX_RE = '/^\s*(?:fwd?|wg)\s*(?:\[\d+\]|\(\d+\))?\s*:\s*/iu';

    public static function hasReplyPrefix(string $subject): bool
    {
        return preg_match(self::REPLY_PREFIX_RE, $subject) === 1;
    }

    /** Subject without (interleaved) reply/forward prefixes, whitespace collapsed. */
    public static function baseSubject(string $subject): string
    {
        $rest = trim((string) preg_replace('/\s+/u', ' ', $subject));
        for (;;) {
            $next = self::stripPrefixes(self::stripPrefixes($rest, self::REPLY_PREFIX_RE), self::FORWARD_PREFIX_RE);
            if ($next === $rest) {
                return $rest;
            }
            $rest = $next;
        }
    }

    private static function stripPrefixes(string $subject, string $re): string
    {
        $rest = trim((string) preg_replace('/\s*[\r\n]+\s*/u', ' ', $subject));
        for (;;) {
            $next = (string) preg_replace($re, '', $rest);
            if ($next === $rest) {
                return $rest;
            }
            $rest = $next;
        }
    }

    public static function subjectKey(string $subject): ?string
    {
        $base = mb_strtolower(self::baseSubject($subject), 'UTF-8');

        return $base === '' ? null : $base;
    }

    /**
     * @param list<string> $references
     *
     * @return list<string>
     */
    public static function links(?string $messageId, ?string $inReplyTo, array $references): array
    {
        $links = [];
        foreach ([...$references, $inReplyTo ?? ''] as $id) {
            $trimmed = trim($id);
            if ($trimmed !== '' && $trimmed !== $messageId) {
                $links[$trimmed] = true;
            }
        }

        return array_map('strval', array_keys($links));
    }

    /**
     * Groups messages into threads (lists of ids). Input entries:
     * id, messageId, inReplyTo, references, subjectKey, isReply, date (seconds or null).
     *
     * @param list<array{id: string, messageId: ?string, inReplyTo: ?string, references: list<string>, subjectKey: ?string, isReply: bool, date: ?float}> $messages
     *
     * @return list<list<string>>
     */
    public static function group(array $messages, int $windowSeconds = self::SUBJECT_THREAD_WINDOW_SECONDS): array
    {
        $parent = [];
        $find = static function (string $key) use (&$parent): string {
            $root = $key;
            while (isset($parent[$root]) && $parent[$root] !== $root) {
                $root = $parent[$root];
            }
            $node = $key;
            while ($node !== $root) {
                $next = $parent[$node];
                $parent[$node] = $root;
                $node = $next;
            }
            $parent[$root] ??= $root;

            return $root;
        };
        $union = static function (string $a, string $b) use (&$parent, $find): void {
            $rootA = $find($a);
            $rootB = $find($b);
            if ($rootA !== $rootB) {
                $parent[$rootB] = $rootA;
            }
        };

        foreach ($messages as $message) {
            $find("m:{$message['id']}");
            if ($message['messageId'] !== null && $message['messageId'] !== '') {
                $union("m:{$message['id']}", "id:{$message['messageId']}");
            }
            foreach (self::links($message['messageId'], $message['inReplyTo'], $message['references']) as $link) {
                $union("m:{$message['id']}", "id:{$link}");
            }
        }

        foreach ($messages as $message) {
            if (!$message['isReply'] || $message['subjectKey'] === null || $message['date'] === null
                || self::links($message['messageId'], $message['inReplyTo'], $message['references']) !== []) {
                continue;
            }
            $best = null;
            foreach ($messages as $candidate) {
                if ($candidate['id'] === $message['id'] || $candidate['subjectKey'] !== $message['subjectKey'] || $candidate['date'] === null) {
                    continue;
                }
                $distance = abs($candidate['date'] - $message['date']);
                if ($distance > $windowSeconds) {
                    continue;
                }
                $earlier = $candidate['date'] <= $message['date'];
                $better = $best === null
                    || ($earlier && !$best['earlier'])
                    || ($earlier === $best['earlier']
                        && ($distance < $best['distance'] || ($distance === $best['distance'] && $candidate['id'] < $best['id'])));
                if ($better) {
                    $best = ['id' => $candidate['id'], 'earlier' => $earlier, 'distance' => $distance];
                }
            }
            if ($best !== null) {
                $union("m:{$message['id']}", "m:{$best['id']}");
            }
        }

        $groups = [];
        foreach ($messages as $message) {
            $root = $find("m:{$message['id']}");
            $groups[$root] ??= [];
            if (!\in_array($message['id'], $groups[$root], true)) {
                $groups[$root][] = $message['id'];
            }
        }

        return array_values($groups);
    }

    /** Assigns threads to unthreaded messages of an account (bounded); returns the count. */
    public static function assign(\PDO $pdo, string $dek, string $accountId, int $minMetadataVersion): int
    {
        $sortAt = self::SORT_AT;
        $columns = "id, message_id_header, in_reply_to, `references`, subject_enc, subject_hash, thread_id, {$sortAt} AS sort_at";
        $pdo->beginTransaction();
        try {
            Database::run($pdo, 'SELECT 1 FROM mail_account WHERE id = ? FOR UPDATE', [$accountId]);
            /** @var list<array<string, mixed>> $pending */
            $pending = Database::run(
                $pdo,
                "SELECT {$columns} FROM message
                 WHERE account_id = ? AND thread_id IS NULL AND metadata_version >= ?
                 ORDER BY {$sortAt}, id LIMIT " . self::THREAD_ASSIGN_LIMIT,
                [$accountId, $minMetadataVersion],
            )->fetchAll();
            $hmacKey = Envelope::deriveHmacKey($dek, 'thread-subject');

            foreach ($pending as $row) {
                $message = self::row($row);
                $subject = self::decryptSubject($dek, $message);
                $key = self::subjectKey($subject);
                $subjectHash = $key === null ? null : (string) hex2bin(Envelope::hmacValue($hmacKey, $key));
                $links = self::links($message['message_id_header'], $message['in_reply_to'], $message['references']);
                $ids = [...$links, $message['message_id_header']];

                $conditions = ['in_reply_to IN (' . self::marks($ids) . ')',
                    'id IN (SELECT message_id FROM message_reference WHERE account_id = ? AND ref IN (' . self::marks($ids) . '))'];
                $params = [...$ids, $accountId, ...$ids];
                if ($links !== []) {
                    $conditions[] = 'message_id_header IN (' . self::marks($links) . ')';
                    array_push($params, ...$links);
                }
                if ($subjectHash !== null) {
                    $conditions[] = "(subject_hash = ? AND {$sortAt} BETWEEN ? - INTERVAL ? SECOND AND ? + INTERVAL ? SECOND)";
                    array_push($params, $subjectHash, $message['sort_at'], self::SUBJECT_THREAD_WINDOW_SECONDS, $message['sort_at'], self::SUBJECT_THREAD_WINDOW_SECONDS);
                }
                /** @var list<array<string, mixed>> $candidateRows */
                $candidateRows = Database::run(
                    $pdo,
                    "SELECT {$columns} FROM message
                     WHERE account_id = ? AND thread_id IS NOT NULL AND id <> ? AND (" . implode(' OR ', $conditions) . ')
                     LIMIT ' . self::MAX_CANDIDATES,
                    [$accountId, $message['id'], ...$params],
                )->fetchAll();
                $candidates = array_map(self::row(...), $candidateRows);

                $hashHex = $subjectHash === null ? null : bin2hex($subjectHash);
                $input = [self::threadingMessage($message, $hashHex, self::hasReplyPrefix($subject))];
                foreach ($candidates as $candidate) {
                    $same = $hashHex !== null && $candidate['subject_hash'] !== null && bin2hex($candidate['subject_hash']) === $hashHex;
                    $input[] = self::threadingMessage($candidate, $same ? $hashHex : null, $same && self::hasReplyPrefix(self::decryptSubject($dek, $candidate)));
                }
                $members = [];
                foreach (self::group($input) as $group) {
                    if (\in_array($message['id'], $group, true)) {
                        $members = array_flip($group);
                    }
                }
                $threadIds = [];
                foreach ($candidates as $candidate) {
                    if (isset($members[$candidate['id']]) && $candidate['thread_id'] !== null) {
                        $threadIds[$candidate['thread_id']] = true;
                    }
                }
                $threadIds = array_map('strval', array_keys($threadIds));

                if ($threadIds === []) {
                    $threadId = Uuid::v4();
                    Database::run($pdo, 'INSERT INTO thread (id, account_id) VALUES (?, ?)', [$threadId, $accountId]);
                } else {
                    // Merge into the oldest thread.
                    $threadId = (string) Database::run(
                        $pdo,
                        'SELECT id FROM thread WHERE id IN (' . self::marks($threadIds) . ') ORDER BY created_at, id LIMIT 1',
                        $threadIds,
                    )->fetchColumn();
                    $merged = array_values(array_filter($threadIds, static fn(string $id): bool => $id !== $threadId));
                    if ($merged !== []) {
                        Database::run($pdo, 'UPDATE message SET thread_id = ? WHERE account_id = ? AND thread_id IN (' . self::marks($merged) . ')', [$threadId, $accountId, ...$merged]);
                        Database::run($pdo, 'DELETE FROM thread WHERE id IN (' . self::marks($merged) . ')', $merged);
                    }
                }
                Database::run($pdo, 'UPDATE message SET thread_id = ?, subject_hash = ? WHERE id = ?', [$threadId, $subjectHash, $message['id']]);
                Database::run(
                    $pdo,
                    "UPDATE thread SET last_message_at = (SELECT MAX({$sortAt}) FROM message WHERE thread_id = ?) WHERE id = ?",
                    [$threadId, $threadId],
                );
            }
            $pdo->commit();

            return \count($pending);
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
    }

    /** Deletes threads of an account without any message. */
    public static function removeEmptyThreads(\PDO $pdo, string $accountId): void
    {
        Database::run(
            $pdo,
            'DELETE FROM thread WHERE account_id = ? AND NOT EXISTS (SELECT 1 FROM message m WHERE m.thread_id = thread.id)',
            [$accountId],
        );
    }

    /** @param list<mixed> $values */
    private static function marks(array $values): string
    {
        return implode(', ', array_fill(0, max(1, \count($values)), '?'));
    }

    /**
     * @param array<string, mixed> $row
     *
     * @return array{id: string, message_id_header: string, in_reply_to: ?string, references: list<string>, subject_enc: string, subject_hash: ?string, thread_id: ?string, sort_at: string}
     */
    private static function row(array $row): array
    {
        $references = json_decode((string) ($row['references'] ?? '[]'), true);

        return [
            'id' => (string) $row['id'],
            'message_id_header' => (string) $row['message_id_header'],
            'in_reply_to' => isset($row['in_reply_to']) ? (string) $row['in_reply_to'] : null,
            'references' => \is_array($references) ? array_values(array_map('strval', array_filter($references, 'is_string'))) : [],
            'subject_enc' => (string) $row['subject_enc'],
            'subject_hash' => isset($row['subject_hash']) ? (string) $row['subject_hash'] : null,
            'thread_id' => isset($row['thread_id']) ? (string) $row['thread_id'] : null,
            'sort_at' => (string) $row['sort_at'],
        ];
    }

    /**
     * @param array{id: string, message_id_header: string, in_reply_to: ?string, references: list<string>, sort_at: string} $row
     *
     * @return array{id: string, messageId: ?string, inReplyTo: ?string, references: list<string>, subjectKey: ?string, isReply: bool, date: ?float}
     */
    private static function threadingMessage(array $row, ?string $subjectKey, bool $isReply): array
    {
        $date = strtotime($row['sort_at'] . ' UTC');

        return [
            'id' => $row['id'],
            'messageId' => $row['message_id_header'],
            'inReplyTo' => $row['in_reply_to'],
            'references' => $row['references'],
            'subjectKey' => $subjectKey,
            'isReply' => $isReply,
            'date' => $date === false ? null : (float) $date,
        ];
    }

    /** @param array{id: string, subject_enc: string} $row */
    private static function decryptSubject(string $dek, array $row): string
    {
        try {
            return Envelope::decryptField($dek, $row['subject_enc'], Envelope::messageFieldAad('subject', $row['id']));
        } catch (\Throwable) {
            return '';
        }
    }
}
