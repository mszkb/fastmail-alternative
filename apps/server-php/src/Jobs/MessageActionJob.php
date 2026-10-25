<?php

declare(strict_types=1);

namespace Fma\Jobs;

use Fma\Config;
use Fma\Db\Database;
use Fma\Log\Logger;
use Fma\Mail\AccountContext;
use Fma\Mail\FileStore;
use Fma\Mail\ImapActions;
use Fma\Mail\ImapClient;
use Fma\Mail\MailException;
use Fma\Mail\TransportPolicy;

/**
 * message_action job (roadmap 2.4): writes a user action that POST /api/messages/actions has
 * already applied optimistically to the database back to the IMAP server -
 * flags (\Seen, \Flagged), moves (move/archive/delete to Trash) and
 * permanent deletes (\Deleted + EXPUNGE inside Trash).
 *
 * - UID commands only. UIDs that are gone on the server are skipped.
 * - UIDVALIDITY check: if the folder's UIDVALIDITY changed since the action,
 *   the stored UIDs are meaningless; the action is dropped and the folder
 *   resynced.
 * - Moves turn their placeholder locations (negative uid) into real ones
 *   via the server's COPYUID (UIDPLUS); otherwise the follow-up sync of the
 *   target folder replaces them.
 * - Failures throw and are retried with backoff; connection-level failures
 *   feed the account circuit breaker like folder_sync.
 */
final class MessageActionJob implements JobHandler
{
    public const OPERATIONS = ['read', 'unread', 'flag', 'unflag', 'move', 'expunge'];

    /** Flag changes per operation: [flag, add?]. */
    private const FLAG_OPERATIONS = [
        'read' => ['\Seen', true],
        'unread' => ['\Seen', false],
        'flag' => ['\Flagged', true],
        'unflag' => ['\Flagged', false],
    ];

    public function __construct(
        private readonly Database $db,
        private readonly Config $config,
        private readonly JobQueue $queue,
        private readonly FileStore $files,
        private readonly Logger $logger,
        private readonly ?TransportPolicy $policy = null,
    ) {}

    public function run(Job $job, Deadline $deadline): bool
    {
        if ($job->accountId === null) {
            throw new \RuntimeException('message_action job without account_id');
        }
        $outcome = $this->runAction($job->accountId, $job->payload);

        return $outcome !== 'folder_missing';
    }

    /**
     * @param array<string, mixed> $rawPayload
     *
     * @return 'done'|'folder_missing'|'uidvalidity_changed'
     */
    public function runAction(string $accountId, array $rawPayload): string
    {
        $payload = self::parsePayload($rawPayload);
        $operation = $payload['operation'];
        $pdo = $this->db->pdo();

        $sourcePath = $this->folderPath($accountId, $payload['folderId']);
        $targetPath = $payload['targetFolderId'] !== null ? $this->folderPath($accountId, $payload['targetFolderId']) : null;
        if ($sourcePath === null || ($operation === 'move' && $targetPath === null)) {
            // Folder vanished on the server meanwhile: the next syncs drop
            // the placeholders and restore what is still there.
            $this->logger->warn('message_action folder missing, dropped', ['accountId' => $accountId, 'folderId' => $payload['folderId'], 'operation' => $operation]);

            return 'folder_missing';
        }

        $account = AccountContext::load($pdo, $accountId, $this->config);
        try {
            $client = ImapClient::connect($this->policy ?? TransportPolicy::fromConfig($this->config), $account->imap);
        } catch (MailException $e) {
            throw self::accountError($e);
        }
        $outcome = 'done';
        try {
            $imap = new ImapActions($client);
            $selected = $imap->select($sourcePath);
            if ($selected['uidValidity'] === null || $selected['uidValidity'] !== self::normalizeNumber($payload['uidvalidity'])) {
                $outcome = 'uidvalidity_changed';
            } else {
                $items = $payload['items'];
                // Skip UIDs that are already gone (expunged/moved by another client).
                $uids = $selected['exists'] > 0 ? $imap->existingUids(array_column($items, 'uid')) : [];
                $locationIds = array_column($items, 'locationId');
                $flagChange = self::FLAG_OPERATIONS[$operation] ?? null;
                if ($flagChange !== null) {
                    [$flag, $add] = $flagChange;
                    $imap->storeFlag($uids, $flag, $add);
                    // Re-apply locally: a sync in between may have reverted the optimistic change.
                    $this->applyFlagsLocally($locationIds, $flag, $add);
                } elseif ($operation === 'move') {
                    $copied = $imap->move($uids, $targetPath);
                    if ($copied !== null) {
                        $this->resolvePlaceholders($payload['targetFolderId'], $items, $copied);
                    }
                } else {
                    $imap->delete($uids);
                    $this->removeOrphanMessages($accountId, array_column($items, 'messageId'));
                }
            }
        } catch (MailException $e) {
            // A rejected command (NO/BAD) is retried; lost connections count for the account.
            throw $e->errorCode === 'PROTOCOL' ? new \RuntimeException('message_action command rejected', 0, $e) : self::accountError($e);
        } finally {
            $client->logout();
        }

        if ($outcome === 'uidvalidity_changed') {
            $this->logger->warn('message_action uidvalidity changed, dropped', ['accountId' => $accountId, 'folderId' => $payload['folderId'], 'operation' => $operation]);
        }
        // Moves: the source sync confirms the removal, the target sync learns
        // the new UIDs without COPYUID. After a dropped action both restore
        // the server state.
        if ($operation === 'move' || $outcome === 'uidvalidity_changed') {
            $this->queue->enqueueMessageSync($accountId, $payload['folderId']);
            if ($payload['targetFolderId'] !== null) {
                $this->queue->enqueueMessageSync($accountId, $payload['targetFolderId']);
            }
        }

        return $outcome;
    }

    /**
     * Validates the untyped job payload (ids only).
     *
     * @param array<string, mixed> $payload
     *
     * @return array{operation: string, folderId: string, uidvalidity: string, items: list<array{uid: int, locationId: string, messageId: string}>, targetFolderId: ?string}
     */
    public static function parsePayload(array $payload): array
    {
        $operation = $payload['operation'] ?? null;
        if (!\is_string($operation) || !\in_array($operation, self::OPERATIONS, true)) {
            throw new \RuntimeException('message_action job with invalid operation');
        }
        $folderId = $payload['folderId'] ?? null;
        $uidvalidity = $payload['uidvalidity'] ?? null;
        $items = $payload['items'] ?? null;
        if (!\is_string($folderId) || !\is_string($uidvalidity) || !\is_array($items)) {
            throw new \RuntimeException('message_action job with invalid payload');
        }
        $target = $payload['targetFolderId'] ?? null;
        if ($operation === 'move' && !\is_string($target)) {
            throw new \RuntimeException('message_action move job without target folder');
        }
        $parsed = [];
        foreach ($items as $item) {
            $item = \is_array($item) ? $item : [];
            $uid = $item['uid'] ?? null;
            if (!\is_int($uid) || $uid <= 0) {
                throw new \RuntimeException('message_action job with invalid uid');
            }
            $locationId = $item['locationId'] ?? '';
            $messageId = $item['messageId'] ?? '';
            $parsed[] = [
                'uid' => $uid,
                'locationId' => \is_scalar($locationId) ? (string) $locationId : '',
                'messageId' => \is_scalar($messageId) ? (string) $messageId : '',
            ];
        }

        return [
            'operation' => $operation,
            'folderId' => $folderId,
            'uidvalidity' => $uidvalidity,
            'items' => $parsed,
            'targetFolderId' => \is_string($target) ? $target : null,
        ];
    }

    private function folderPath(string $accountId, string $folderId): ?string
    {
        $path = Database::run($this->db->pdo(), 'SELECT path FROM folder WHERE id = ? AND account_id = ?', [$folderId, $accountId])->fetchColumn();

        return \is_string($path) ? $path : null;
    }

    /** @param list<string> $locationIds */
    private function applyFlagsLocally(array $locationIds, string $flag, bool $add): void
    {
        if ($locationIds === []) {
            return;
        }
        $in = implode(', ', array_fill(0, \count($locationIds), '?'));
        // Only locations that still exist (a sync may have removed some).
        Database::run(
            $this->db->pdo(),
            $add
                ? "INSERT IGNORE INTO message_flag (location_id, flag) SELECT id, ? FROM message_location WHERE id IN ({$in})"
                : "DELETE FROM message_flag WHERE flag = ? AND location_id IN ({$in})",
            [$flag, ...$locationIds],
        );
    }

    /**
     * Turns move placeholders into real locations using the COPYUID mapping.
     *
     * @param list<array{uid: int, locationId: string, messageId: string}> $items
     * @param array{uidValidity: string, map: array<int, int>} $copied
     */
    private function resolvePlaceholders(string $targetFolderId, array $items, array $copied): void
    {
        $pdo = $this->db->pdo();
        foreach ($items as $item) {
            $newUid = $copied['map'][$item['uid']] ?? null;
            if ($newUid === null) {
                continue;
            }
            $exists = Database::run(
                $pdo,
                'SELECT 1 FROM message_location WHERE folder_id = ? AND uidvalidity = ? AND uid = ?',
                [$targetFolderId, $copied['uidValidity'], $newUid],
            )->fetchColumn() !== false;
            $updated = !$exists && Database::run(
                $pdo,
                'UPDATE message_location SET uidvalidity = ?, uid = ? WHERE id = ? AND uid < 0',
                [$copied['uidValidity'], $newUid, $item['locationId']],
            )->rowCount() > 0;
            if (!$updated) {
                // A sync already stored the real location: drop the placeholder.
                Database::run($pdo, 'DELETE FROM message_location WHERE id = ? AND uid < 0', [$item['locationId']]);
            }
        }
    }

    /**
     * Deletes the given messages of an account if they no longer have any
     * location (a message may still live in another folder), including their
     * encrypted raw file.
     *
     * @param list<string> $candidates
     */
    private function removeOrphanMessages(string $accountId, array $candidates): int
    {
        if ($candidates === []) {
            return 0;
        }
        $pdo = $this->db->pdo();
        $in = implode(', ', array_fill(0, \count($candidates), '?'));
        $orphan = "m.account_id = ? AND m.id IN ({$in}) AND NOT EXISTS (SELECT 1 FROM message_location ml WHERE ml.message_id = m.id)";
        $pdo->beginTransaction();
        try {
            /** @var list<array{id: string, storage_ref: ?string}> $rows */
            $rows = Database::run(
                $pdo,
                "SELECT m.id, mb.storage_ref FROM message m LEFT JOIN message_body mb ON mb.message_id = m.id WHERE {$orphan} FOR UPDATE",
                [$accountId, ...$candidates],
            )->fetchAll();
            if ($rows !== []) {
                $ids = array_column($rows, 'id');
                Database::run($pdo, 'DELETE FROM message WHERE id IN (' . implode(', ', array_fill(0, \count($ids), '?')) . ')', $ids);
                Database::run(
                    $pdo,
                    'DELETE FROM thread WHERE account_id = ? AND NOT EXISTS (SELECT 1 FROM message m WHERE m.thread_id = thread.id)',
                    [$accountId],
                );
            }
            $pdo->commit();
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
        foreach ($rows as $row) {
            if ($row['storage_ref'] !== null) {
                $this->files->removeMessageDir($row['storage_ref']);
            }
        }

        return \count($rows);
    }

    private static function normalizeNumber(string $value): string
    {
        return ltrim(trim($value), '0') ?: '0';
    }

    /** Connection-level failures feed the account circuit breaker (as in FolderSyncJob). */
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
