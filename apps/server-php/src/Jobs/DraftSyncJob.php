<?php

declare(strict_types=1);

namespace Fma\Jobs;

use Fma\Config;
use Fma\Crypto\Envelope;
use Fma\Db\Database;
use Fma\Mail\AccountContext;
use Fma\Mail\Compose;
use Fma\Mail\ImapAppend;
use Fma\Mail\ImapClient;
use Fma\Mail\MailException;
use Fma\Mail\MimeBuilder;
use Fma\Mail\TransportPolicy;
use Fma\Mail\Uploads;

/**
 * draft_sync job: mirrors a
 * server-side draft into the account's IMAP Drafts folder and removes it
 * once discarded or sent.
 *
 * - Upload (`imap_version < version`): APPEND with \Draft \Seen, then
 *   delete every older copy (UID SEARCH HEADER Message-ID <draft id>) and
 *   the original copy of a draft opened from another client (`source_*`),
 *   unless `keep_source`.
 * - Delete (`deleted_at` set): remove all copies, then the row.
 * - Without a Drafts folder the draft stays server-only.
 * - Afterwards a message_sync of the touched folders is queued.
 *
 * Never logged: content, addresses, folder names.
 */
final class DraftSyncJob implements JobHandler
{
    public function __construct(
        private readonly Database $db,
        private readonly Config $config,
        private readonly JobQueue $queue,
        private readonly ?TransportPolicy $policy = null,
    ) {}

    public static function draftMessageId(string $draftId, int $version, string $fromAddress): string
    {
        $at = strrpos($fromAddress, '@');
        $domain = $at === false ? '' : substr($fromAddress, $at + 1);

        return "<{$draftId}.{$version}@" . ($domain !== '' ? $domain : 'localhost') . '>';
    }

    public function run(Job $job, Deadline $deadline): bool
    {
        $draftId = $job->payload['draftId'] ?? null;
        $accountId = $job->accountId;
        if (!\is_string($draftId) || $accountId === null) {
            throw new \RuntimeException('draft_sync job without draft id');
        }
        $pdo = $this->db->pdo();
        /** @var array{id: string, identity_id: ?string, content_enc: ?string, in_reply_to: ?string, references: string, version: int|string, imap_version: int|string, updated_at: string, deleted_at: ?string, source_folder_id: ?string, source_uidvalidity: int|string|null, source_uid: int|string|null, keep_source: int|string}|false $row */
        $row = Database::run(
            $pdo,
            'SELECT id, identity_id, content_enc, in_reply_to, `references`, version, imap_version, updated_at, deleted_at,
                    source_folder_id, source_uidvalidity, source_uid, keep_source
             FROM draft WHERE id = ? AND account_id = ?',
            [$draftId, $accountId],
        )->fetch();
        if ($row === false) {
            return false;
        }
        $deleted = $row['deleted_at'] !== null;
        $version = (int) $row['version'];
        if (!$deleted && (int) $row['imap_version'] >= $version) {
            return false;
        }
        /** @var array{id: string, path: string}|false $drafts */
        $drafts = Database::run(
            $pdo,
            "SELECT id, path FROM folder WHERE account_id = ? AND special_use = 'drafts' AND selectable ORDER BY path LIMIT 1",
            [$accountId],
        )->fetch();
        $keepSource = (bool) $row['keep_source'];
        $hasSource = $row['source_folder_id'] !== null && $row['source_uid'] !== null && !$keepSource;

        if ($drafts === false && (!$hasSource || !$deleted)) {
            if ($deleted) {
                Database::run($pdo, 'DELETE FROM draft WHERE id = ? AND deleted_at IS NOT NULL', [$row['id']]);

                return false;
            }
            Database::run($pdo, 'UPDATE draft SET imap_version = ? WHERE id = ?', [$version, $row['id']]);

            return false;
        }

        $ctx = AccountContext::load($pdo, $accountId, $this->config);
        $upload = null;
        $updatedAt = new \DateTimeImmutable($row['updated_at'], new \DateTimeZone('UTC'));
        if (!$deleted && $drafts !== false) {
            if ($row['content_enc'] === null) {
                throw new \RuntimeException('draft without content');
            }
            $content = json_decode(Envelope::decryptField($ctx->dek, $row['content_enc'], Envelope::draftContentAad($row['id'])), true, 64, JSON_THROW_ON_ERROR);
            $content = \is_array($content) ? $content : [];
            $text = static fn(string $key): string => \is_string($content[$key] ?? null) ? $content[$key] : '';
            $from = $this->senderOf($ctx, $row['identity_id']);
            $messageId = self::draftMessageId($row['id'], $version, $from['address']);
            $references = json_decode($row['references'], true);
            $raw = MimeBuilder::build([
                'from' => $from,
                'to' => Compose::parseAddressList($text('to')),
                'cc' => Compose::parseAddressList($text('cc')),
                'bcc' => Compose::parseAddressList($text('bcc')),
                'subject' => $text('subject'),
                'text' => $text('text'),
                'messageId' => $messageId,
                'date' => $updatedAt,
                'inReplyTo' => $row['in_reply_to'],
                'references' => \is_array($references) ? array_values(array_filter($references, 'is_string')) : [],
            ], Uploads::load($pdo, $ctx->dek, null, $row['id']), true);
            $upload = ['raw' => $raw, 'messageId' => $messageId];
        }

        $touched = [];
        try {
            $client = ImapClient::connect($this->policy ?? TransportPolicy::fromConfig($this->config), $ctx->imap);
        } catch (MailException $e) {
            throw new AccountErrorException(self::accountErrorCode($e), $e);
        }
        try {
            $imap = new ImapAppend($client);
            if ($drafts !== false) {
                if ($upload !== null) {
                    $imap->append($drafts['path'], $upload['raw'], ['\Draft', '\Seen'], $updatedAt);
                }
                $uidValidity = $imap->select($drafts['path']);
                $copies = $imap->searchMessageId($row['id']);
                // The copy just uploaded is the newest one with this draft id.
                $keep = $upload !== null && $copies !== [] ? max($copies) : 0;
                $remove = array_values(array_filter($copies, static fn(int $uid): bool => $uid !== $keep));
                if (!$keepSource && $row['source_uid'] !== null && $row['source_folder_id'] === $drafts['id']
                    && $uidValidity !== null && $uidValidity === (string) $row['source_uidvalidity']) {
                    $remove[] = (int) $row['source_uid'];
                }
                $imap->deleteUids($remove);
                $touched[] = $drafts['id'];
            }
            if ($hasSource && $row['source_folder_id'] !== ($drafts !== false ? $drafts['id'] : null)) {
                /** @var array{path: string}|false $folder */
                $folder = Database::run($pdo, 'SELECT path FROM folder WHERE id = ?', [$row['source_folder_id']])->fetch();
                if ($folder !== false) {
                    // Stale UID after a UIDVALIDITY change: leave the message alone.
                    if ($imap->select($folder['path']) === (string) $row['source_uidvalidity']) {
                        $imap->deleteUids([(int) $row['source_uid']]);
                    }
                    $touched[] = (string) $row['source_folder_id'];
                }
            }
        } finally {
            $client->logout();
        }

        if ($deleted) {
            Database::run($pdo, 'DELETE FROM draft WHERE id = ? AND deleted_at IS NOT NULL', [$row['id']]);
        } else {
            // The source copy is gone now; later saves only replace our own copies.
            Database::run(
                $pdo,
                'UPDATE draft SET imap_version = GREATEST(imap_version, ?), message_id_header = ?,
                   source_folder_id = NULL, source_uidvalidity = NULL, source_uid = NULL WHERE id = ?',
                [$version, $upload['messageId'], $row['id']],
            );
        }
        foreach (array_unique($touched) as $folderId) {
            $this->queue->enqueueMessageSync($accountId, $folderId);
        }

        return true;
    }

    /** @return array{name: string, address: string} */
    private function senderOf(AccountContext $ctx, ?string $identityId): array
    {
        /** @var array{name: string, email_address: string}|false $identity */
        $identity = Database::run(
            $this->db->pdo(),
            'SELECT i.name, i.email_address FROM identity i JOIN mail_account a ON a.id = i.account_id
             WHERE i.account_id = ? AND (i.id = ? OR ? IS NULL)
             ORDER BY (i.id = a.default_identity_id) DESC, i.email_address LIMIT 1',
            [$ctx->accountId, $identityId, $identityId],
        )->fetch();

        return $identity !== false
            ? ['name' => Compose::singleLine($identity['name']), 'address' => $identity['email_address']]
            : ['name' => '', 'address' => $ctx->emailAddress];
    }

    private static function accountErrorCode(MailException $e): string
    {
        return match ($e->errorCode) {
            'AUTH_FAILED' => 'AUTH_FAILED',
            'TLS_REQUIRED' => 'TLS_REQUIRED',
            'ENOTFOUND' => 'HOST_NOT_FOUND',
            'ECONNREFUSED' => 'CONNECTION_REFUSED',
            'ETIMEDOUT' => 'TIMEOUT',
            'ETLS' => 'TLS_ERROR',
            'PRIVATE_HOST_BLOCKED' => 'BLOCKED_HOST',
            'PORT_NOT_ALLOWED' => 'BLOCKED_PORT',
            default => 'CONNECTION_LOST',
        };
    }
}
