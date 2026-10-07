<?php

declare(strict_types=1);

namespace Fma\Jobs;

use Fma\Config;
use Fma\Db\Database;
use Fma\Db\Uuid;
use Fma\Mail\AccountContext;
use Fma\Mail\FolderDetection;
use Fma\Mail\FolderRoles;
use Fma\Mail\ImapClient;
use Fma\Mail\MailException;
use Fma\Mail\TransportPolicy;

/**
 * folder_sync job, port of apps/worker/src/jobs/folder-sync.ts: lists the
 * mailboxes, upserts them with uidnext/unread and the detected role, removes
 * vanished folders (their messages without any other location are removed
 * by the next cleanup run) and resolves the effective roles. Chains one
 * message_sync per selectable folder. folder.uidvalidity is written by
 * message_sync only.
 *
 * Progress (#119): phase 'folders' with done/total mailboxes. A cancel
 * request stops it between two mailboxes (IMAP logout, no folder removal,
 * nothing chained); folders upserted so far stay, the next run continues.
 */
final class FolderSyncJob implements JobHandler
{
    public function __construct(
        private readonly Database $db,
        private readonly Config $config,
        private readonly JobQueue $queue,
        private readonly ?TransportPolicy $policy = null,
    ) {}

    public function run(Job $job, Deadline $deadline): bool
    {
        if ($job->accountId === null) {
            throw new \RuntimeException('folder_sync job without account_id');
        }
        $pdo = $this->db->pdo();
        $progress = $this->queue->progress($job->id);
        if ($progress->cancelled()) {
            throw new JobCancelledException();
        }
        $account = AccountContext::load($pdo, $job->accountId, $this->config->get('MASTER_KEY'));
        try {
            $client = ImapClient::connect($this->policy ?? TransportPolicy::fromConfig($this->config), $account->imap);
        } catch (MailException $e) {
            throw self::accountError($e);
        }
        try {
            $mailboxes = $client->list();
            $selectable = array_values(array_filter($mailboxes, self::isSelectable(...)));
            $detected = FolderDetection::detect($selectable);
            $progress->report('folders', null, 0, \count($mailboxes));
            foreach ($mailboxes as $index => $mailbox) {
                if ($progress->cancelled()) {
                    throw new JobCancelledException();
                }
                $progress->report('folders', null, $index, \count($mailboxes));
                $isSelectable = self::isSelectable($mailbox);
                $status = $isSelectable ? $client->status($mailbox['path']) : ['uidNext' => null, 'unseen' => null];
                Database::run(
                    $pdo,
                    'INSERT INTO folder (id, account_id, path, delimiter, special_use_detected, uidnext, unread_count, selectable, last_synced_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))
                     ON DUPLICATE KEY UPDATE delimiter = VALUES(delimiter), selectable = VALUES(selectable),
                       special_use_detected = VALUES(special_use_detected), uidnext = VALUES(uidnext),
                       unread_count = VALUES(unread_count), last_synced_at = VALUES(last_synced_at)',
                    [Uuid::v4(), $job->accountId, $mailbox['path'], $mailbox['delimiter'], $detected[$mailbox['path']] ?? null,
                        $status['uidNext'], $status['unseen'] ?? 0, $isSelectable ? 1 : 0],
                );
            }
        } catch (MailException $e) {
            throw self::accountError($e);
        } finally {
            $client->logout();
        }

        $paths = array_column($mailboxes, 'path');
        if ($paths !== []) {
            $in = implode(', ', array_fill(0, \count($paths), '?'));
            Database::run($pdo, "DELETE FROM folder WHERE account_id = ? AND path NOT IN ({$in})", [$job->accountId, ...$paths]);
        }
        $pdo->beginTransaction();
        try {
            // Same lock as PATCH /api/folders/{id}: a concurrent manual change is not overwritten.
            Database::run($pdo, 'SELECT 1 FROM mail_account WHERE id = ? FOR UPDATE', [$job->accountId]);
            FolderRoles::apply($pdo, $job->accountId);
            $pdo->commit();
        } catch (\Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }
        $folders = Database::run($pdo, 'SELECT id FROM folder WHERE account_id = ? AND selectable', [$job->accountId])->fetchAll(\PDO::FETCH_COLUMN);
        $accountId = $job->accountId;
        $chained = $this->queue->chainUnlessCancelled($job, function () use ($folders, $accountId): void {
            foreach ($folders as $folderId) {
                $this->queue->enqueueMessageSync($accountId, (string) $folderId);
            }
        });
        if (!$chained) {
            throw new JobCancelledException();
        }

        return true;
    }

    /** @param array{flags: list<string>} $mailbox */
    public static function isSelectable(array $mailbox): bool
    {
        $flags = array_map('strtolower', $mailbox['flags']);

        return !\in_array('\noselect', $flags, true) && !\in_array('\nonexistent', $flags, true);
    }

    /** Connection-level failures feed the account circuit breaker. */
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
}
