<?php

declare(strict_types=1);

namespace Fma\Jobs;

use Fma\Config;
use Fma\Crypto\Envelope;
use Fma\Db\Database;
use Fma\Log\Logger;
use Fma\Mail\AccountContext;
use Fma\Mail\ImapAppend;
use Fma\Mail\ImapClient;
use Fma\Mail\MailException;
use Fma\Mail\MimeBuilder;
use Fma\Mail\SmtpClient;
use Fma\Mail\TransportPolicy;
use Fma\Mail\Uploads;

/**
 * send_message job: sends an
 * outbox message via SMTP, then stores a copy in "Sent" (APPEND, \Seen).
 *
 * - Not yet accepted (`sent_at` NULL): permanent errors (auth, 5xx,
 *   blocked host/port) fail the message at once; transient ones leave it
 *   'queued' with the code and throw (retry with backoff); after the last
 *   attempt it becomes 'failed'.
 * - Accepted: never sent again, only the Sent copy is retried; after the
 *   last attempt the copy is given up (`sent_copy` 'failed').
 * - Sent copy skipped without Sent folder or for Gmail (stores it itself).
 * - Fewer uploads than `attachment_count`: fails with ATTACHMENT_MISSING.
 * - Settled: content and uploads are deleted, message_sync of Sent queued.
 *
 * Never logged: content, addresses, server replies.
 */
final class SendMessageJob implements JobHandler
{
    private const AUTO_SAVE_HOST_RE = '/(^|\.)(gmail|googlemail)\.com$/i';

    public function __construct(
        private readonly Database $db,
        private readonly Config $config,
        private readonly JobQueue $queue,
        private readonly Logger $logger,
        private readonly ?TransportPolicy $policy = null,
    ) {}

    public function run(Job $job, Deadline $deadline): bool
    {
        $outboxId = $job->payload['outboxId'] ?? null;
        if (!\is_string($outboxId) || $job->accountId === null) {
            throw new \RuntimeException('send_message job without outbox id');
        }
        $finalAttempt = $job->attempts >= JobQueue::MAX_ATTEMPTS;
        try {
            return $this->send($job->accountId, $outboxId, $finalAttempt);
        } catch (SendRetryException $e) {
            throw $e;
        } catch (\Throwable $e) {
            // Unexpected error (e.g. undecryptable credentials) on the last attempt: make it visible.
            if ($finalAttempt) {
                $this->markGivenUp($outboxId);
            }
            throw $e;
        }
    }

    /**
     * Maps a mail error to an outbox error code and whether retrying can help.
     *
     * @return array{code: string, permanent: bool}
     */
    public static function classify(\Throwable $e): array
    {
        $code = $e instanceof MailException ? $e->errorCode : '';

        return match ($code) {
            'PRIVATE_HOST_BLOCKED' => ['code' => 'BLOCKED_HOST', 'permanent' => true],
            'PORT_NOT_ALLOWED' => ['code' => 'BLOCKED_PORT', 'permanent' => true],
            'TLS_REQUIRED' => ['code' => 'TLS_REQUIRED', 'permanent' => false],
            'AUTH_FAILED' => ['code' => 'AUTH_FAILED', 'permanent' => true],
            'SMTP_REJECTED' => ['code' => 'SMTP_REJECTED', 'permanent' => true],
            'SMTP_TEMPORARY' => ['code' => 'SMTP_TEMPORARY', 'permanent' => false],
            'ENOTFOUND' => ['code' => 'HOST_NOT_FOUND', 'permanent' => false],
            'ECONNREFUSED' => ['code' => 'CONNECTION_REFUSED', 'permanent' => false],
            'ETIMEDOUT' => ['code' => 'TIMEOUT', 'permanent' => false],
            'ETLS' => ['code' => 'TLS_ERROR', 'permanent' => false],
            default => ['code' => 'UNKNOWN', 'permanent' => false],
        };
    }

    private function send(string $accountId, string $outboxId, bool $finalAttempt): bool
    {
        $pdo = $this->db->pdo();
        /** @var array{id: string, status: string, content_enc: ?string, message_id_header: string, in_reply_to: ?string, references: string, sent_copy: ?string, sent_at: ?string, attachment_count: int|string}|false $row */
        $row = Database::run(
            $pdo,
            'SELECT id, status, content_enc, message_id_header, in_reply_to, `references`, sent_copy, sent_at, attachment_count
             FROM outbox_message WHERE id = ? AND account_id = ?',
            [$outboxId, $accountId],
        )->fetch();
        if ($row === false) {
            return false;
        }
        if ($row['sent_at'] !== null && $row['sent_copy'] !== 'pending') {
            return false;
        }
        if ($row['sent_at'] === null && $row['status'] !== 'queued' && $row['status'] !== 'sending') {
            return false;
        }
        if ($row['content_enc'] === null) {
            throw new \RuntimeException('outbox message without content');
        }
        $ctx = AccountContext::load($pdo, $accountId, $this->config->get('MASTER_KEY'));
        $content = json_decode(Envelope::decryptField($ctx->dek, $row['content_enc'], Envelope::outboxContentAad($row['id'])), true, 64, JSON_THROW_ON_ERROR);
        if (!\is_array($content)) {
            throw new \RuntimeException('invalid outbox content');
        }
        $attachments = Uploads::load($pdo, $ctx->dek, $row['id']);
        $missing = \count($attachments) < (int) $row['attachment_count'];
        if ($missing && $row['sent_at'] === null) {
            // Never send without an attachment the user added.
            $this->setStatus($row['id'], ['status' => 'failed', 'last_error_code' => 'ATTACHMENT_MISSING']);
            $this->logger->warn('send_message failed', ['accountId' => $accountId, 'outboxId' => $outboxId, 'code' => 'ATTACHMENT_MISSING']);

            return false;
        }
        $references = json_decode($row['references'], true);
        $mail = [
            'from' => self::person($content['from'] ?? null),
            'to' => self::people($content['to'] ?? null),
            'cc' => self::people($content['cc'] ?? null),
            'bcc' => self::people($content['bcc'] ?? null),
            'subject' => \is_string($content['subject'] ?? null) ? $content['subject'] : '',
            'text' => \is_string($content['text'] ?? null) ? $content['text'] : '',
            'messageId' => $row['message_id_header'],
            'inReplyTo' => $row['in_reply_to'],
            'references' => \is_array($references) ? array_values(array_filter($references, 'is_string')) : [],
        ];
        $policy = $this->policy ?? TransportPolicy::fromConfig($this->config);

        // Step 1: SMTP (only while not yet accepted).
        $sentAt = $row['sent_at'] !== null ? new \DateTimeImmutable($row['sent_at'], new \DateTimeZone('UTC')) : null;
        if ($sentAt === null) {
            Database::run($pdo, "UPDATE outbox_message SET status = 'sending', attempts = attempts + 1, updated_at = UTC_TIMESTAMP(6) WHERE id = ?", [$row['id']]);
            $date = new \DateTimeImmutable('now', new \DateTimeZone('UTC'));
            try {
                $raw = MimeBuilder::build($mail + ['date' => $date], $attachments, false);
                $smtp = SmtpClient::connect($policy, $ctx->smtp, 15.0);
                try {
                    $smtp->sendMail($mail['from']['address'], MimeBuilder::envelopeRecipients($mail['to'], $mail['cc'], $mail['bcc']), $raw);
                } finally {
                    $smtp->quit();
                }
            } catch (MailException $e) {
                ['code' => $code, 'permanent' => $permanent] = self::classify($e);
                if ($permanent || $finalAttempt) {
                    $this->setStatus($row['id'], ['status' => 'failed', 'last_error_code' => $code]);
                    $this->logger->warn('send_message failed', ['accountId' => $accountId, 'outboxId' => $outboxId, 'code' => $code, 'permanent' => $permanent]);

                    return false;
                }
                $this->setStatus($row['id'], ['status' => 'queued', 'last_error_code' => $code]);
                throw new SendRetryException($code, $e);
            }
            $sentAt = $date;
            $this->setStatus($row['id'], ['status' => 'sent', 'sent_at' => $date->format('Y-m-d H:i:s.u'), 'last_error_code' => null, 'sent_copy' => 'pending']);
            $this->logger->info('send_message accepted by smtp', ['accountId' => $accountId, 'outboxId' => $outboxId]);
        }

        // Step 2: copy in "Sent".
        /** @var array{id: string, path: string}|false $sent */
        $sent = Database::run($pdo, "SELECT id, path FROM folder WHERE account_id = ? AND special_use = 'sent' ORDER BY path LIMIT 1", [$accountId])->fetch();
        if ($sent === false || preg_match(self::AUTO_SAVE_HOST_RE, $ctx->smtp->host) === 1 || preg_match(self::AUTO_SAVE_HOST_RE, $ctx->imap->host) === 1) {
            $sentCopy = 'skipped';
        } elseif ($missing) {
            // The copy would differ from what was sent.
            $sentCopy = 'failed';
        } else {
            try {
                $raw = MimeBuilder::build($mail + ['date' => $sentAt], $attachments, true);
                $imap = ImapClient::connect($policy, $ctx->imap, 15.0);
                try {
                    (new ImapAppend($imap))->append($sent['path'], $raw, ['\Seen'], $sentAt);
                } finally {
                    $imap->logout();
                }
                $sentCopy = 'done';
            } catch (MailException $e) {
                if (!$finalAttempt) {
                    throw new SendRetryException('SENT_COPY_FAILED', $e);
                }
                $this->logger->warn('send_message: copy to Sent failed for good', ['accountId' => $accountId, 'outboxId' => $outboxId, 'err' => $e->errorCode]);
                $sentCopy = 'failed';
            }
        }
        // Settled: drop the content (the copy lives in "Sent" on the server now).
        $this->setStatus($row['id'], ['sent_copy' => $sentCopy, 'content_enc' => null]);
        Database::run($pdo, 'DELETE FROM attachment_upload WHERE outbox_id = ?', [$row['id']]);
        if ($sentCopy === 'done') {
            $this->queue->enqueueMessageSync($accountId, $sent['id']);
        }

        return true;
    }

    /**
     * After the last attempt failed unexpectedly: a not yet sent message
     * becomes 'failed', a pending Sent copy is given up.
     */
    private function markGivenUp(string $outboxId): void
    {
        $pdo = $this->db->pdo();
        Database::run(
            $pdo,
            "UPDATE outbox_message SET status = 'failed', last_error_code = COALESCE(last_error_code, 'UNKNOWN'), updated_at = UTC_TIMESTAMP(6)
             WHERE id = ? AND sent_at IS NULL AND status IN ('queued', 'sending')",
            [$outboxId],
        );
        Database::run(
            $pdo,
            "UPDATE outbox_message SET sent_copy = 'failed', content_enc = NULL, updated_at = UTC_TIMESTAMP(6)
             WHERE id = ? AND sent_at IS NOT NULL AND sent_copy = 'pending'",
            [$outboxId],
        );
        Database::run(
            $pdo,
            'DELETE u FROM attachment_upload u JOIN outbox_message o ON o.id = u.outbox_id WHERE o.id = ? AND o.content_enc IS NULL',
            [$outboxId],
        );
    }

    /** @param array<string, string|null> $fields */
    private function setStatus(string $id, array $fields): void
    {
        $sets = array_map(static fn(string $key): string => "{$key} = ?", array_keys($fields));
        Database::run(
            $this->db->pdo(),
            'UPDATE outbox_message SET ' . implode(', ', [...$sets, 'updated_at = UTC_TIMESTAMP(6)']) . ' WHERE id = ?',
            [...array_values($fields), $id],
        );
    }

    /** @return array{name: string, address: string} */
    private static function person(mixed $value): array
    {
        return [
            'name' => \is_array($value) && \is_string($value['name'] ?? null) ? $value['name'] : '',
            'address' => \is_array($value) && \is_string($value['address'] ?? null) ? $value['address'] : '',
        ];
    }

    /** @return list<array{name: string, address: string}> */
    private static function people(mixed $value): array
    {
        return \is_array($value) ? array_values(array_map(self::person(...), $value)) : [];
    }
}
