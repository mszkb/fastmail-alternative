<?php

declare(strict_types=1);

namespace Fma\Jobs;

use Fma\Config;
use Fma\Crypto\Envelope;
use Fma\Db\Database;
use Fma\Db\Uuid;
use Fma\Log\Logger;
use Fma\Mail\AccountContext;
use Fma\Mail\FileStore;
use Fma\Mail\ImapClient;
use Fma\Mail\ImapMailbox;
use Fma\Mail\MailException;
use Fma\Mail\Threading;
use Fma\Mail\TransportPolicy;
use Fma\Push\PushNotifyQueue;
use ZBateson\MailMimeParser\MailMimeParser;

/**
 * message_sync job (payload {folderId, loadOlder?}). Per run:
 * - discard locations of another uidvalidity (re-linked by Message-ID),
 * - list UIDs + flags (CONDSTORE: UID SEARCH ALL + CHANGEDSINCE only),
 *   update changed flags, remove vanished locations and orphaned messages,
 * - fetch new UIDs (initial: newest MESSAGE_SYNC_LIMIT, honoring
 *   mail_account.sync_since; incremental: above the highest synced UID;
 *   loadOlder: the next window below the lowest synced UID),
 * - store encrypted metadata, flags, the encrypted raw mail
 *   (<account>/<message>/raw.eml.enc) and the encrypted plain text,
 * - drop stale move placeholders, update the folder state, push hint for
 *   new unseen INBOX mail, thread assignment.
 *
 * Deadline (ADR-0013 cron budget): new messages are processed in batches;
 * when the budget runs out between messages the run stops, keeps the
 * folder's uidvalidity/highestmodseq unchanged (the next run continues as
 * the same kind of run) and enqueues a follow-up message_sync.
 *
 * Progress and cancellation (#119): phases 'flags' (listing), 'expunge'
 * (reconcile), 'headers' (new messages incl. their bodies, done/total) and
 * 'bodies' (bodies missing from earlier runs, done/total), written via
 * SyncProgress. A cancel request is checked between two stored messages and
 * ends the run like an expired deadline (uidvalidity/highestmodseq stay, so
 * the next run continues without duplicates), but without a follow-up job;
 * the job then ends as 'cancelled'.
 *
 * Metadata backfill: rows with an outdated metadata_version get addresses,
 * Reply-To and threading headers re-derived from the stored raw mail, else
 * from IMAP.
 */
final class MessageSyncJob implements JobHandler
{
    public const MESSAGE_SYNC_LIMIT = 200;
    public const MESSAGE_METADATA_VERSION = 3;
    private const DEFAULT_MAX_RAW_MESSAGE_BYTES = 20 * 1024 * 1024;
    private const MAX_TEXT_PLAIN_BYTES = 100 * 1024;
    private const MAX_REFERENCES = 100;
    private const MAX_DELIVERED_TO = 10;
    /** UIDs per metadata FETCH. */
    private const FETCH_BATCH = 50;
    /** Outdated messages re-derived per run and folder. */
    private const METADATA_BACKFILL_LIMIT = 200;

    public function __construct(
        private readonly Database $db,
        private readonly Config $config,
        private readonly JobQueue $queue,
        private readonly FileStore $files,
        private readonly Logger $logger,
        private readonly ?TransportPolicy $policy = null,
        private readonly int $limit = self::MESSAGE_SYNC_LIMIT,
    ) {}

    public function run(Job $job, Deadline $deadline): bool
    {
        if ($job->accountId === null) {
            throw new \RuntimeException('message_sync job without account_id');
        }
        $folderId = $job->payload['folderId'] ?? null;
        if (!\is_string($folderId) || !Uuid::isValid($folderId)) {
            throw new \RuntimeException('message_sync job without folderId');
        }
        $loadOlder = ($job->payload['loadOlder'] ?? false) === true;
        $accountId = $job->accountId;
        $pdo = $this->db->pdo();

        /** @var array{id: string, path: string, uidvalidity: int|string|null, highestmodseq: int|string|null, last_synced_at: ?string, special_use: ?string, selectable: int|string}|false $folder */
        $folder = Database::run(
            $pdo,
            'SELECT id, path, uidvalidity, highestmodseq, last_synced_at, special_use, selectable FROM folder WHERE id = ? AND account_id = ?',
            [$folderId, $accountId],
        )->fetch();
        if ($folder === false) {
            throw new \RuntimeException('folder not found');
        }
        $syncSince = Database::run($pdo, 'SELECT sync_since FROM mail_account WHERE id = ?', [$accountId])->fetchColumn();
        // \Noselect container: nothing to select.
        if ((int) $folder['selectable'] === 0) {
            return false;
        }

        $progress = $this->queue->progress($job->id);
        if ($progress->cancelled()) {
            throw new JobCancelledException();
        }
        $ctx = AccountContext::load($pdo, $accountId, $this->config->get('MASTER_KEY'));
        try {
            $client = ImapClient::connect($this->policy ?? TransportPolicy::fromConfig($this->config), $ctx->imap);
        } catch (MailException $e) {
            throw self::accountError($e);
        }
        $newUnseen = 0;
        $cancelled = false;
        try {
            [$newUnseen, $cancelled] = $this->sync($pdo, $ctx, new ImapMailbox($client), $folder, \is_string($syncSince) ? $syncSince : null, $loadOlder, $deadline, $job, $progress);
        } catch (MailException $e) {
            throw self::accountError($e);
        } finally {
            $client->logout();
        }

        if ($newUnseen > 0 && $folder['special_use'] === 'inbox') {
            // Best effort: push is only a hint.
            try {
                (new PushNotifyQueue($this->db))->enqueueForAccount($accountId);
            } catch (\Throwable $e) {
                $this->logger->warn('push enqueue failed', ['accountId' => $accountId, 'error' => $e::class]);
            }
        }
        // Best effort: unthreaded messages are picked up by the next run.
        try {
            Threading::assign($pdo, $ctx->dek, $accountId, self::MESSAGE_METADATA_VERSION);
        } catch (\Throwable $e) {
            $this->logger->warn('thread assignment failed', ['accountId' => $accountId, 'folderId' => $folderId, 'error' => $e::class]);
        }
        if ($cancelled) {
            throw new JobCancelledException();
        }

        return true;
    }

    /**
     * @param array{id: string, path: string, uidvalidity: int|string|null, highestmodseq: int|string|null, last_synced_at: ?string, special_use: ?string, selectable: int|string} $folder
     *
     * @return array{0: int, 1: bool} new unseen messages of an incremental run, whether it stopped on a cancel request
     */
    private function sync(\PDO $pdo, AccountContext $ctx, ImapMailbox $mailbox, array $folder, ?string $syncSince, bool $loadOlder, Deadline $deadline, Job $job, SyncProgress $progress): array
    {
        $accountId = $ctx->accountId;
        $folderId = $folder['id'];
        $progress->report('flags', $folderId);
        $selected = $mailbox->examine($folder['path']);
        $serverUidvalidity = $selected['uidValidity'];
        $dbUidvalidity = $folder['uidvalidity'] === null ? null : (int) $folder['uidvalidity'];

        // Locations of another uidvalidity are meaningless; placeholders (uid < 0) stay.
        $stale = Database::run($pdo, 'SELECT message_id FROM message_location WHERE folder_id = ? AND uidvalidity <> ? AND uid > 0', [$folderId, $serverUidvalidity])->fetchAll(\PDO::FETCH_COLUMN);
        if ($stale !== []) {
            Database::run($pdo, 'DELETE FROM message_location WHERE folder_id = ? AND uidvalidity <> ? AND uid > 0', [$folderId, $serverUidvalidity]);
            $this->logger->warn('uidvalidity changed, stale locations discarded', ['accountId' => $accountId, 'folderId' => $folderId, 'locationsRemoved' => \count($stale)]);
        }

        $serverModseq = $mailbox->condstoreEnabled() && !$selected['noModseq'] && ($selected['highestModseq'] ?? 0) > 0 ? $selected['highestModseq'] : null;
        // A failed message_action write-back forces the full listing (reverts optimistic flags).
        $failedActions = Database::run(
            $pdo,
            "SELECT 1 FROM job WHERE type = 'message_action' AND account_id = ? AND state = 'failed'
               AND run_at >= COALESCE(?, '1000-01-01') LIMIT 1",
            [$accountId, $folder['last_synced_at']],
        )->fetchColumn() !== false;
        $storedModseq = $dbUidvalidity === $serverUidvalidity && $folder['highestmodseq'] !== null && !$failedActions ? (int) $folder['highestmodseq'] : null;

        $allUids = [];
        $serverFlags = [];
        if ($selected['exists'] > 0) {
            if ($serverModseq !== null && $storedModseq !== null && $storedModseq <= $serverModseq) {
                $allUids = $mailbox->searchUids('ALL');
                if ($serverModseq > $storedModseq) {
                    $serverFlags = $mailbox->flagsChangedSince($storedModseq);
                }
            } else {
                $serverFlags = $mailbox->allFlags();
                $allUids = array_keys($serverFlags);
            }
        }
        $serverUids = array_flip($allUids);

        $progress->report('expunge', $folderId);
        $this->reconcile($pdo, $accountId, $folderId, $serverUidvalidity, $serverUids, $serverFlags);
        // Phase boundary: a stop during listing/reconcile ends the run here,
        // even when there is nothing new to fetch.
        $cancelled = $progress->cancelled();

        $knownUids = array_map('intval', Database::run($pdo, 'SELECT uid FROM message_location WHERE folder_id = ? AND uidvalidity = ?', [$folderId, $serverUidvalidity])->fetchAll(\PDO::FETCH_COLUMN));
        $known = array_flip($knownUids);
        $highestSynced = max([0, ...$knownUids]);

        $candidates = $allUids;
        $eligible = null;
        if ($syncSince !== null && $allUids !== []) {
            $eligible = array_flip($mailbox->searchUids('SINCE ' . ImapMailbox::searchDate(new \DateTimeImmutable($syncSince, new \DateTimeZone('UTC')))));
            $candidates = array_values(array_filter($allUids, static fn(int $uid): bool => isset($eligible[$uid])));
        }
        $windowStart = \count($candidates) - $this->limit;
        $targets = [];
        foreach ($candidates as $index => $uid) {
            if (!isset($known[$uid]) && ($index >= $windowStart || ($highestSynced > 0 && $uid > $highestSynced))) {
                $targets[] = $uid;
            }
        }
        $older = [];
        if ($loadOlder) {
            $positive = array_filter($knownUids, static fn(int $uid): bool => $uid > 0);
            $lowestSynced = $positive === [] ? \PHP_INT_MAX : min($positive);
            $pending = array_flip($targets);
            $olderAll = array_values(array_filter(
                $allUids,
                static fn(int $uid): bool => !isset($known[$uid]) && !isset($pending[$uid]) && ($uid < $lowestSynced || ($eligible !== null && !isset($eligible[$uid]))),
            ));
            // Newest first: an interrupted run leaves the rest below the lowest synced UID.
            $older = array_reverse(\array_slice($olderAll, -$this->limit));
        }
        $isIncremental = $dbUidvalidity !== null && $dbUidvalidity === $serverUidvalidity;

        $newUnseen = 0;
        $complete = !$cancelled;
        $hmacKey = Envelope::deriveHmacKey($ctx->dek, 'thread');
        $seen = [];
        $total = \count($targets) + \count($older);
        $done = 0;
        $progress->report('headers', $folderId, 0, $total);
        foreach ($cancelled ? [] : array_chunk([...$targets, ...$older], self::FETCH_BATCH) as $batch) {
            if ($deadline->expired()) {
                $complete = false;
                break;
            }
            foreach ($mailbox->fetchMetadata($batch) as $message) {
                if (self::outOfTime($deadline)) {
                    $complete = false;
                    break 2;
                }
                // Between two stored messages: each one is stored completely or not at all.
                if ($progress->cancelled()) {
                    $complete = false;
                    $cancelled = true;
                    break 2;
                }
                $isNew = $this->storeMessage($pdo, $ctx, $mailbox, $hmacKey, $folderId, $serverUidvalidity, $message, $seen);
                if ($isNew && $isIncremental && $highestSynced > 0 && $message['uid'] > $highestSynced && !\in_array('\\Seen', $message['flags'], true)) {
                    ++$newUnseen;
                }
                $progress->report('headers', $folderId, ++$done, $total);
            }
        }

        if ($complete && ($targets !== [] || $older !== [])) {
            // Bodies missing from earlier (interrupted) runs.
            $missing = Database::run(
                $pdo,
                'SELECT ml.message_id, MIN(ml.uid) AS uid, MAX(m.size_bytes) AS size_bytes FROM message_location ml
                 JOIN message m ON m.id = ml.message_id
                 LEFT JOIN message_body mb ON mb.message_id = ml.message_id
                 WHERE ml.folder_id = ? AND ml.uidvalidity = ? AND ml.uid > 0 AND mb.message_id IS NULL
                 GROUP BY ml.message_id',
                [$folderId, $serverUidvalidity],
            )->fetchAll();
            $progress->report('bodies', $folderId, 0, \count($missing));
            foreach ($missing as $index => $row) {
                /** @var array{message_id: string, uid: int|string, size_bytes: int|string} $row */
                if ($deadline->expired()) {
                    $complete = false;
                    break;
                }
                if ($progress->cancelled()) {
                    $complete = false;
                    $cancelled = true;
                    break;
                }
                if (isset($serverUids[(int) $row['uid']])) {
                    // RFC822.SIZE from the metadata sync (0 = unknown): an
                    // oversized body is skipped without downloading it.
                    $size = (int) $row['size_bytes'];
                    $this->downloadBody($pdo, $ctx, $mailbox, $row['message_id'], (int) $row['uid'], $size > 0 ? $size : null);
                }
                $progress->report('bodies', $folderId, $index + 1, \count($missing));
            }
        }

        if ($stale !== [] || $dbUidvalidity !== $serverUidvalidity) {
            $removed = (new CleanupJob($this->db, $this->files, $this->logger, $this->config))->purgeLocationlessMessages($accountId);
            if ($removed > 0) {
                $this->logger->info('messages without location removed', ['accountId' => $accountId, 'folderId' => $folderId, 'messagesRemoved' => $removed]);
            }
        }

        if ($complete) {
            try {
                $this->backfillMetadata($pdo, $ctx, $mailbox, $folderId, $serverUidvalidity, $serverUids);
            } catch (MailException $e) {
                throw $e;
            } catch (\Throwable $e) {
                // Best effort: the next run retries.
                $this->logger->warn('metadata backfill failed', ['accountId' => $accountId, 'folderId' => $folderId, 'error' => $e::class]);
            }
        }

        $this->dropStalePlaceholders($pdo, $accountId, $folderId);

        $unread = 'unread_count = (SELECT COUNT(*) FROM message_location ml WHERE ml.folder_id = ?
            AND NOT EXISTS (SELECT 1 FROM message_flag mf WHERE mf.location_id = ml.id AND mf.flag = ?))';
        if ($complete) {
            Database::run(
                $pdo,
                "UPDATE folder SET uidvalidity = ?, uidnext = ?, highestmodseq = ?, last_synced_at = UTC_TIMESTAMP(6), {$unread} WHERE id = ?",
                [$serverUidvalidity, $selected['uidNext'], $serverModseq, $folderId, '\\Seen', $folderId],
            );
        } else {
            Database::run($pdo, "UPDATE folder SET {$unread} WHERE id = ?", [$folderId, '\\Seen', $folderId]);
            // The running job blocks enqueueMessageSync(); enqueue the continuation directly - not after a cancel request.
            $continued = !$cancelled && $this->queue->chainUnlessCancelled(
                $job,
                fn() => $this->queue->enqueue('message_sync', $accountId, ['folderId' => $folderId] + ($older !== [] ? ['loadOlder' => true] : [])),
            );
            if ($continued) {
                $this->logger->info('message sync continues in a follow-up job', ['accountId' => $accountId, 'folderId' => $folderId, 'jobId' => $job->id]);
            } else {
                $cancelled = true;
                $this->logger->info('message sync stopped on request', ['accountId' => $accountId, 'folderId' => $folderId, 'jobId' => $job->id]);
            }
        }

        return [$newUnseen, $cancelled];
    }

    /**
     * Stores one fetched message (new row or re-link by Message-ID), its
     * location with flags and, when missing, its body. Returns whether a new
     * message row was created.
     *
     * @param array{uid: int, flags: list<string>, modseq: ?int, size: int, envelope: array{date: ?string, subject: string, from: list<array{name: string, address: string}>, replyTo: list<array{name: string, address: string}>, to: list<array{name: string, address: string}>, cc: list<array{name: string, address: string}>, inReplyTo: ?string, messageId: ?string}, hasAttachments: bool, headers: string} $message
     * @param array<string, string> $seen Message-ID -> message id of this run
     */
    private function storeMessage(\PDO $pdo, AccountContext $ctx, ImapMailbox $mailbox, string $hmacKey, string $folderId, int $uidvalidity, array $message, array &$seen): bool
    {
        $envelope = $message['envelope'];
        $subject = $envelope['subject'];
        $sentAt = self::parseDate($envelope['date']);
        $messageIdHeader = $envelope['messageId'] ?? self::fallbackMessageId($sentAt, $message['size'], Envelope::hmacValue($hmacKey, $subject));

        $dbMessageId = $seen[$messageIdHeader] ?? null;
        if ($dbMessageId === null) {
            $existing = Database::run($pdo, 'SELECT id FROM message WHERE account_id = ? AND message_id_header = ?', [$ctx->accountId, $messageIdHeader])->fetchColumn();
            $dbMessageId = $existing === false ? null : (string) $existing;
        }
        $isNew = $dbMessageId === null;
        if ($dbMessageId === null) {
            $dbMessageId = Uuid::v4();
            $references = self::referencesFromHeaderBlock($message['headers']);
            $field = static fn(string $value, string $name): string => self::encrypt($ctx->dek, $value, $name, $dbMessageId);
            Database::run(
                $pdo,
                'INSERT INTO message (id, account_id, message_id_header, in_reply_to, `references`, subject_enc, from_enc, recipients_enc, snippet_enc,
                   sent_at, received_at, size_bytes, has_attachments, metadata_version)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6), ?, ?, ?)',
                [
                    $dbMessageId, $ctx->accountId, $messageIdHeader, $envelope['inReplyTo'], self::json($references),
                    $field($subject, 'subject'),
                    $field(self::json($envelope['from']), 'from'),
                    $field(self::json([
                        'to' => $envelope['to'],
                        'cc' => $envelope['cc'],
                        'replyTo' => self::distinctReplyTo($envelope['replyTo'], $envelope['from']),
                        'deliveredTo' => self::deliveredToFromHeaderBlock($message['headers']),
                    ]), 'recipients'),
                    $field('', 'snippet'),
                    $sentAt?->format('Y-m-d H:i:s.u'),
                    $message['size'], $message['hasAttachments'] ? 1 : 0, self::MESSAGE_METADATA_VERSION,
                ],
            );
            $this->storeReferences($pdo, $ctx->accountId, $dbMessageId, $references);
        }

        Database::run(
            $pdo,
            'INSERT INTO message_location (id, message_id, folder_id, uidvalidity, uid, modseq) VALUES (?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE message_id = VALUES(message_id), modseq = VALUES(modseq)',
            [Uuid::v4(), $dbMessageId, $folderId, $uidvalidity, $message['uid'], $message['modseq']],
        );
        $locationId = (string) Database::run($pdo, 'SELECT id FROM message_location WHERE folder_id = ? AND uidvalidity = ? AND uid = ?', [$folderId, $uidvalidity, $message['uid']])->fetchColumn();
        $this->replaceFlags($pdo, $locationId, $message['flags']);
        // Arrived through an optimistic move: the placeholder is replaced.
        Database::run($pdo, 'DELETE FROM message_location WHERE folder_id = ? AND message_id = ? AND uid < 0', [$folderId, $dbMessageId]);

        $seen[$messageIdHeader] ??= $dbMessageId;
        if (Database::run($pdo, 'SELECT 1 FROM message_body WHERE message_id = ?', [$dbMessageId])->fetchColumn() === false) {
            $this->downloadBody($pdo, $ctx, $mailbox, $dbMessageId, $message['uid'], $message['size']);
        }

        return $isNew;
    }

    /**
     * Downloads, encrypts and stores the raw source and the plain text.
     * Bodies never stored (too large, empty) get a row with skip_reason.
     */
    private function downloadBody(\PDO $pdo, AccountContext $ctx, ImapMailbox $mailbox, string $messageId, int $uid, ?int $knownSize): void
    {
        $max = $this->config->int('MAX_RAW_MESSAGE_BYTES', self::DEFAULT_MAX_RAW_MESSAGE_BYTES);
        $max = $max > 0 ? $max : self::DEFAULT_MAX_RAW_MESSAGE_BYTES;
        $raw = $knownSize !== null && $knownSize > $max ? null : $mailbox->fetchRaw($uid);
        if ($raw === null && ($knownSize === null || $knownSize <= $max)) {
            // The UID vanished meanwhile; the next run reconciles it.
            $this->logger->warn('message download returned no content', ['accountId' => $ctx->accountId, 'messageId' => $messageId, 'uid' => $uid]);

            return;
        }
        if ($raw === null || $raw === '' || \strlen($raw) > $max) {
            $skipReason = $raw === '' ? 'empty' : 'too_large';
            $this->logger->warn('message body skipped', ['accountId' => $ctx->accountId, 'messageId' => $messageId, 'uid' => $uid, 'skipReason' => $skipReason]);
            Database::run($pdo, 'INSERT IGNORE INTO message_body (message_id, storage_ref, skip_reason) VALUES (?, NULL, ?)', [$messageId, $skipReason]);

            return;
        }

        $dir = $this->files->root() . "/{$ctx->accountId}/{$messageId}";
        if (!is_dir($dir) && !@mkdir($dir, 0o700, true) && !is_dir($dir)) {
            throw new \RuntimeException('cannot create message directory');
        }
        $file = "{$dir}/" . FileStore::RAW_FILE;
        if (@file_put_contents($file, Envelope::encryptBytes($ctx->dek, $raw, Envelope::messageFieldAad('body', $messageId))) === false) {
            throw new \RuntimeException('cannot write raw message');
        }

        [$text, $references] = self::parseRaw($raw);
        $snippet = Envelope::encryptField($ctx->dek, mb_substr($text, 0, 200, 'UTF-8'), Envelope::messageFieldAad('snippet', $messageId));
        if ($references !== []) {
            Database::run($pdo, 'UPDATE message SET snippet_enc = ?, `references` = ? WHERE id = ?', [$snippet, self::json($references), $messageId]);
            $this->storeReferences($pdo, $ctx->accountId, $messageId, $references);
        } else {
            Database::run($pdo, 'UPDATE message SET snippet_enc = ? WHERE id = ?', [$snippet, $messageId]);
        }
        Database::run(
            $pdo,
            'INSERT IGNORE INTO message_body (message_id, storage_ref, text_plain_enc) VALUES (?, ?, ?)',
            [$messageId, FileStore::storageRef($ctx->accountId, $messageId), Envelope::encryptField($ctx->dek, $text, Envelope::messageFieldAad('text', $messageId))],
        );
    }

    /**
     * Plain text (trimmed, at most MAX_TEXT_PLAIN_BYTES) and References of a raw mail.
     *
     * @return array{0: string, 1: list<string>}
     */
    private static function parseRaw(string $raw): array
    {
        try {
            $stream = fopen('php://temp', 'r+b');
            if ($stream === false) {
                return ['', []];
            }
            fwrite($stream, $raw);
            rewind($stream);
            $message = (new MailMimeParser())->parse($stream, true);
            $text = $message->getTextContent();
            if ($text === null) {
                $html = $message->getHtmlContent();
                $text = $html === null ? '' : html_entity_decode(strip_tags((string) preg_replace('#<(style|script)\b[^>]*>.*?</\1>#is', '', $html)), \ENT_QUOTES | \ENT_HTML5, 'UTF-8');
            }
            $text = self::truncateUtf8(trim($text), self::MAX_TEXT_PLAIN_BYTES);
            $references = self::normalizeReferences((string) $message->getHeader('References')?->getRawValue());

            return [$text, \array_slice($references, -self::MAX_REFERENCES)];
        } catch (\Throwable) {
            return ['', []];
        }
    }

    private static function truncateUtf8(string $text, int $bytes): string
    {
        return \strlen($text) <= $bytes ? $text : mb_strcut($text, 0, $bytes, 'UTF-8');
    }

    /**
     * Applies server flags to known locations, removes vanished ones and
     * messages left without any location (incl. their raw file).
     *
     * @param array<int, int> $serverUids uid -> index
     * @param array<int, list<string>> $serverFlags
     */
    private function reconcile(\PDO $pdo, string $accountId, string $folderId, int $uidvalidity, array $serverUids, array $serverFlags): void
    {
        $rows = Database::run(
            $pdo,
            'SELECT ml.id, ml.uid, ml.message_id, GROUP_CONCAT(HEX(mf.flag)) AS flags FROM message_location ml
             LEFT JOIN message_flag mf ON mf.location_id = ml.id
             WHERE ml.folder_id = ? AND ml.uidvalidity = ? GROUP BY ml.id, ml.uid, ml.message_id',
            [$folderId, $uidvalidity],
        )->fetchAll();
        $vanished = [];
        $candidates = [];
        foreach ($rows as $row) {
            /** @var array{id: string, uid: int|string, message_id: string, flags: ?string} $row */
            $uid = (int) $row['uid'];
            if (!isset($serverUids[$uid])) {
                $vanished[] = $row['id'];
                $candidates[$row['message_id']] = true;
                continue;
            }
            if (!isset($serverFlags[$uid])) {
                continue;
            }
            $current = $row['flags'] === null ? [] : array_map(static fn(string $hex): string => (string) hex2bin($hex), explode(',', $row['flags']));
            $wanted = $serverFlags[$uid];
            if (\count($current) !== \count(array_unique($wanted)) || array_diff($wanted, $current) !== []) {
                $this->replaceFlags($pdo, $row['id'], $wanted);
            }
        }
        if ($vanished === []) {
            return;
        }
        foreach (array_chunk($vanished, 500) as $chunk) {
            Database::run($pdo, 'DELETE FROM message_location WHERE id IN (' . implode(', ', array_fill(0, \count($chunk), '?')) . ')', $chunk);
        }
        $removed = $this->removeOrphanMessages($pdo, $accountId, array_map('strval', array_keys($candidates)));
        $this->logger->info('expunged messages reconciled', ['accountId' => $accountId, 'folderId' => $folderId, 'locationsRemoved' => \count($vanished), 'messagesRemoved' => $removed]);
    }

    /**
     * Deletes the given messages when they have no location left, incl.
     * their raw files (rows first, then files). Returns the count.
     *
     * @param list<string> $candidates
     */
    private function removeOrphanMessages(\PDO $pdo, string $accountId, array $candidates): int
    {
        $total = 0;
        foreach (array_chunk($candidates, 500) as $chunk) {
            $in = implode(', ', array_fill(0, \count($chunk), '?'));
            /** @var list<array{id: string, storage_ref: ?string}> $orphans */
            $orphans = Database::run(
                $pdo,
                "SELECT m.id, mb.storage_ref FROM message m LEFT JOIN message_body mb ON mb.message_id = m.id
                 WHERE m.id IN ({$in}) AND m.account_id = ?
                   AND NOT EXISTS (SELECT 1 FROM message_location ml WHERE ml.message_id = m.id)",
                [...$chunk, $accountId],
            )->fetchAll();
            if ($orphans === []) {
                continue;
            }
            $ids = array_column($orphans, 'id');
            Database::run(
                $pdo,
                'DELETE FROM message WHERE id IN (' . implode(', ', array_fill(0, \count($ids), '?')) . ')
                   AND NOT EXISTS (SELECT 1 FROM message_location ml WHERE ml.message_id = message.id)',
                $ids,
            );
            foreach ($orphans as $orphan) {
                if ($orphan['storage_ref'] !== null) {
                    $this->files->removeMessageDir($orphan['storage_ref']);
                }
            }
            $total += \count($orphans);
        }
        if ($total > 0) {
            Threading::removeEmptyThreads($pdo, $accountId);
        }

        return $total;
    }

    /**
     * Re-derives metadata of outdated rows in this folder (bounded): from
     * the encrypted raw mail when readable, else via IMAP (envelope +
     * References/Delivered-To headers).
     *
     * @param array<int, int> $serverUids
     */
    private function backfillMetadata(\PDO $pdo, AccountContext $ctx, ImapMailbox $mailbox, string $folderId, int $uidvalidity, array $serverUids): void
    {
        $rows = Database::run(
            $pdo,
            'SELECT m.id, MIN(ml.uid) AS uid, MAX(mb.storage_ref) AS storage_ref FROM message m
             JOIN message_location ml ON ml.message_id = m.id
             LEFT JOIN message_body mb ON mb.message_id = m.id
             WHERE ml.folder_id = ? AND ml.uidvalidity = ? AND ml.uid > 0 AND m.account_id = ? AND m.metadata_version < ?
             GROUP BY m.id ORDER BY m.id LIMIT ' . self::METADATA_BACKFILL_LIMIT,
            [$folderId, $uidvalidity, $ctx->accountId, self::MESSAGE_METADATA_VERSION],
        )->fetchAll();
        if ($rows === []) {
            return;
        }
        $fromRaw = 0;
        $viaImap = [];
        foreach ($rows as $row) {
            /** @var array{id: string, uid: int|string, storage_ref: ?string} $row */
            $metadata = $row['storage_ref'] === null ? null : $this->metadataFromStoredRaw($ctx->dek, $row['id'], $row['storage_ref']);
            if ($metadata !== null) {
                $this->storeMetadata($pdo, $ctx, $row['id'], $metadata);
                ++$fromRaw;
            } elseif (isset($serverUids[(int) $row['uid']])) {
                $viaImap[(int) $row['uid']] = $row['id'];
            }
        }
        $fromImap = 0;
        foreach (array_chunk(array_keys($viaImap), self::FETCH_BATCH) as $batch) {
            foreach ($mailbox->fetchMetadata($batch) as $uid => $message) {
                $envelope = $message['envelope'];
                $this->storeMetadata($pdo, $ctx, $viaImap[$uid], [
                    'from' => $envelope['from'],
                    'to' => $envelope['to'],
                    'cc' => $envelope['cc'],
                    'replyTo' => self::distinctReplyTo($envelope['replyTo'], $envelope['from']),
                    'deliveredTo' => self::deliveredToFromHeaderBlock($message['headers']),
                    'inReplyTo' => $envelope['inReplyTo'],
                    'references' => self::referencesFromHeaderBlock($message['headers']),
                ]);
                ++$fromImap;
            }
        }
        $this->logger->info('message metadata backfilled', ['accountId' => $ctx->accountId, 'folderId' => $folderId, 'fromRaw' => $fromRaw, 'fromImap' => $fromImap, 'pending' => \count($rows) - $fromRaw - $fromImap]);
    }

    /**
     * Header metadata of the stored raw mail; null when missing or unreadable.
     *
     * @return array{from: list<array{name: string, address: string}>, to: list<array{name: string, address: string}>, cc: list<array{name: string, address: string}>, replyTo: list<array{name: string, address: string}>, deliveredTo: list<string>, inReplyTo: ?string, references: list<string>}|null
     */
    private function metadataFromStoredRaw(string $dek, string $messageId, string $storageRef): ?array
    {
        $dir = $this->files->messageDirOf($storageRef);
        if ($dir === null || !is_file("{$dir}/" . FileStore::RAW_FILE)) {
            return null;
        }
        try {
            $data = @file_get_contents("{$dir}/" . FileStore::RAW_FILE);
            if ($data === false) {
                return null;
            }
            $raw = Envelope::decryptBytes($dek, $data, Envelope::messageFieldAad('body', $messageId));
            // Headers only.
            $ends = array_filter([strpos($raw, "\r\n\r\n"), strpos($raw, "\n\n")], static fn(int|false $i): bool => $i !== false);
            $headerBlock = $ends === [] ? $raw : substr($raw, 0, min($ends) + 2);
            $message = (new MailMimeParser())->parse($headerBlock . "\r\n", false);
            $people = static function (string $name) use ($message): array {
                $header = $message->getHeader($name);
                $list = [];
                if ($header instanceof \ZBateson\MailMimeParser\Header\AddressHeader) {
                    foreach ($header->getAddresses() as $address) {
                        if ($address->getEmail() !== '') {
                            $list[] = ['name' => $address->getName(), 'address' => $address->getEmail()];
                        }
                    }
                }

                return $list;
            };
            $from = $people('From');
            $inReplyTo = trim((string) $message->getHeaderValue('In-Reply-To', ''));

            return [
                'from' => $from,
                'to' => $people('To'),
                'cc' => $people('Cc'),
                'replyTo' => self::distinctReplyTo($people('Reply-To'), $from),
                'deliveredTo' => self::deliveredToFromHeaderBlock($headerBlock),
                'inReplyTo' => $inReplyTo === '' ? null : $inReplyTo,
                'references' => \array_slice(self::normalizeReferences((string) $message->getHeader('References')?->getRawValue()), -self::MAX_REFERENCES),
            ];
        } catch (\Throwable) {
            return null;
        }
    }

    /** @param array{from: list<array{name: string, address: string}>, to: list<array{name: string, address: string}>, cc: list<array{name: string, address: string}>, replyTo: list<array{name: string, address: string}>, deliveredTo: list<string>, inReplyTo: ?string, references: list<string>} $metadata */
    private function storeMetadata(\PDO $pdo, AccountContext $ctx, string $messageId, array $metadata): void
    {
        Database::run(
            $pdo,
            'UPDATE message SET from_enc = ?, recipients_enc = ?, in_reply_to = ?, `references` = ?, metadata_version = ? WHERE id = ?',
            [
                self::encrypt($ctx->dek, self::json($metadata['from']), 'from', $messageId),
                self::encrypt($ctx->dek, self::json(['to' => $metadata['to'], 'cc' => $metadata['cc'], 'replyTo' => $metadata['replyTo'], 'deliveredTo' => $metadata['deliveredTo']]), 'recipients', $messageId),
                $metadata['inReplyTo'], self::json($metadata['references']), self::MESSAGE_METADATA_VERSION, $messageId,
            ],
        );
        $this->storeReferences($pdo, $ctx->accountId, $messageId, $metadata['references']);
    }

    /** Removes move placeholders (uid < 0) no pending message_action will resolve. */
    private function dropStalePlaceholders(\PDO $pdo, string $accountId, string $folderId): void
    {
        $pending = Database::run($pdo, "SELECT 1 FROM job WHERE type = 'message_action' AND account_id = ? AND state IN ('queued', 'running') LIMIT 1", [$accountId])->fetchColumn();
        if ($pending !== false) {
            return;
        }
        $messageIds = Database::run($pdo, 'SELECT message_id FROM message_location WHERE folder_id = ? AND uid < 0', [$folderId])->fetchAll(\PDO::FETCH_COLUMN);
        if ($messageIds === []) {
            return;
        }
        $removedLocations = Database::run($pdo, 'DELETE FROM message_location WHERE folder_id = ? AND uid < 0', [$folderId])->rowCount();
        $removed = $this->removeOrphanMessages($pdo, $accountId, array_values(array_unique(array_map('strval', $messageIds))));
        $this->logger->info('stale move placeholders removed', ['accountId' => $accountId, 'folderId' => $folderId, 'placeholdersRemoved' => $removedLocations, 'messagesRemoved' => $removed]);
    }

    /** @param list<string> $flags */
    private function replaceFlags(\PDO $pdo, string $locationId, array $flags): void
    {
        Database::run($pdo, 'DELETE FROM message_flag WHERE location_id = ?', [$locationId]);
        foreach (array_unique($flags) as $flag) {
            Database::run($pdo, 'INSERT IGNORE INTO message_flag (location_id, flag) VALUES (?, ?)', [$locationId, $flag]);
        }
    }

    /** @param list<string> $references */
    private function storeReferences(\PDO $pdo, string $accountId, string $messageId, array $references): void
    {
        Database::run($pdo, 'DELETE FROM message_reference WHERE message_id = ?', [$messageId]);
        foreach ($references as $position => $ref) {
            Database::run($pdo, 'INSERT INTO message_reference (message_id, position, account_id, ref) VALUES (?, ?, ?, ?)', [$messageId, $position, $accountId, $ref]);
        }
    }

    /** Connection-level failures feed the account circuit breaker (same mapping as folder_sync). */
    private static function accountError(MailException $e): AccountErrorException
    {
        return new AccountErrorException(match ($e->errorCode) {
            'AUTH_FAILED' => 'AUTH_FAILED',
            'TLS_REQUIRED' => 'TLS_REQUIRED',
            'ENOTFOUND' => 'HOST_NOT_FOUND',
            'ECONNREFUSED' => 'CONNECTION_REFUSED',
            'ETIMEDOUT' => 'TIMEOUT',
            'ETLS' => 'TLS_ERROR',
            'PRIVATE_HOST_BLOCKED' => 'BLOCKED_HOST',
            'PORT_NOT_ALLOWED' => 'BLOCKED_PORT',
            default => 'CONNECTION_LOST',
        }, $e);
    }

    /** @phpstan-impure */
    private static function outOfTime(Deadline $deadline): bool
    {
        return $deadline->expired();
    }

    private static function encrypt(string $dek, string $value, string $field, string $messageId): string
    {
        $aad = match ($field) {
            'subject', 'from', 'recipients', 'snippet' => Envelope::messageFieldAad($field, $messageId),
            default => throw new \LogicException('unknown field'),
        };

        return Envelope::encryptField($dek, $value, $aad);
    }

    /** Deterministic id when the message has no Message-ID (keep the hash input: stored rows are matched by it). */
    public static function fallbackMessageId(?\DateTimeImmutable $date, int $size, string $subjectHmac): string
    {
        $ms = $date === null ? '0' : $date->format('Uv');

        return '<' . hash('sha256', "{$ms}|{$size}|{$subjectHmac}") . '@fma.local>';
    }

    private static function parseDate(?string $value): ?\DateTimeImmutable
    {
        if ($value === null || trim($value) === '') {
            return null;
        }
        // Trailing comments like "(UTC)" are not understood by the parser.
        $clean = trim((string) preg_replace('/\([^()]*\)\s*$/', '', $value));
        try {
            return (new \DateTimeImmutable($clean))->setTimezone(new \DateTimeZone('UTC'));
        } catch (\Exception) {
            return null;
        }
    }

    /**
     * Reply-To only when it differs from From (servers fill it with From).
     *
     * @param list<array{name: string, address: string}> $replyTo
     * @param list<array{name: string, address: string}> $from
     *
     * @return list<array{name: string, address: string}>
     */
    public static function distinctReplyTo(array $replyTo, array $from): array
    {
        $fromSet = array_flip(array_map(static fn(array $p): string => strtolower($p['address']), $from));
        foreach ($replyTo as $person) {
            if (!isset($fromSet[strtolower($person['address'])])) {
                return $replyTo;
            }
        }

        return [];
    }

    /** @return list<string> */
    public static function referencesFromHeaderBlock(string $headers): array
    {
        $unfolded = (string) preg_replace('/\r?\n[ \t]+/', ' ', $headers);
        if (preg_match('/^references:[ \t]*(.*)$/im', $unfolded, $m) !== 1 || trim($m[1]) === '') {
            return [];
        }
        preg_match_all('/<[^<>\s]+>/', $m[1], $refs);

        return \array_slice($refs[0], -self::MAX_REFERENCES);
    }

    /** @return list<string> */
    public static function deliveredToFromHeaderBlock(string $headers): array
    {
        $unfolded = (string) preg_replace('/\r?\n[ \t]+/', ' ', $headers);
        preg_match_all('/^(?:delivered-to|x-original-to):[ \t]*(.*)$/im', $unfolded, $matches);
        $result = [];
        foreach ($matches[1] as $value) {
            $address = strtolower(trim((string) preg_replace('/^<|>$/', '', trim($value))));
            if (preg_match('/^[^\s@<>]+@[^\s@<>]+$/', $address) === 1) {
                $result[$address] = true;
            }
        }

        return \array_slice(array_map('strval', array_keys($result)), 0, self::MAX_DELIVERED_TO);
    }

    /** @return list<string> */
    private static function normalizeReferences(string $value): array
    {
        $parts = preg_split('/\s+/', $value) ?: [];

        return array_values(array_filter(array_map('trim', $parts), static fn(string $ref): bool => str_starts_with($ref, '<')));
    }

    private static function json(mixed $value): string
    {
        return json_encode($value, \JSON_THROW_ON_ERROR | \JSON_UNESCAPED_SLASHES | \JSON_UNESCAPED_UNICODE | \JSON_INVALID_UTF8_SUBSTITUTE);
    }
}
