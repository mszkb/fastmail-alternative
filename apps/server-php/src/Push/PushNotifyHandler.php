<?php

declare(strict_types=1);

namespace Fma\Push;

use Fma\Config;
use Fma\Crypto\Envelope;
use Fma\Db\Database;
use Fma\Jobs\Deadline;
use Fma\Jobs\Job;
use Fma\Jobs\JobHandler;
use Fma\Log\Logger;

/**
 * push_notify job (roadmap 4.3, ADR-0005, ADR-0013: sent from the cron runner):
 * - sends a content-free Web Push to every active subscription of the
 *   user whose device still has a valid session;
 * - payload ONLY {type, installationId, badge} (PushPayload, principle 4);
 *   the badge is computed when the job runs (unread INBOX messages of all
 *   accounts of the user);
 * - VAPID + aes128gcm, TTL 15 min, Urgency normal; the request goes out via
 *   the PushSender (SSRF-pinned, no redirects, timeout);
 * - 404/410: the subscription is gone and deleted; other failures count
 *   failure_count up, after MAX_FAILURES in a row it is disabled; a
 *   success resets the count. The job itself is not retried for single
 *   delivery failures (healthy subscriptions would be notified again);
 * - logs show only the push service host and a short hash of the endpoint;
 * - transport 'fcm' (#139, Android app): the endpoint column holds the FCM
 *   registration token; sent through the FCM HTTP v1 API (Fcm) with the
 *   same content-free data and the same failure handling. Web Push and FCM
 *   are configured independently; a missing one only skips its transport.
 */
final class PushNotifyHandler implements JobHandler
{
    /** Consecutive failed deliveries after which a subscription is disabled. */
    public const MAX_FAILURES = 5;
    /** Push services drop the message when the device is offline this long. */
    public const TTL_SECONDS = 15 * 60;

    public function __construct(
        private readonly Database $db,
        private readonly Config $config,
        private readonly Logger $logger,
        private readonly PushSender $sender,
        private readonly ?Vapid $vapid,
        private readonly ?Fcm $fcm = null,
    ) {}

    public static function fromConfig(Database $db, Config $config, Logger $logger): self
    {
        $fcm = null;
        try {
            $fcm = Fcm::fromConfig($config);
        } catch (\Throwable $e) {
            $logger->warn('FCM not usable, check FCM_SERVICE_ACCOUNT_JSON', ['errName' => $e::class]);
        }

        return new self($db, $config, $logger, new StreamPushSender($config->bool('MAIL_INSECURE_TRANSPORT')), Vapid::fromConfig($config), $fcm);
    }

    public function run(Job $job, Deadline $deadline): bool
    {
        $outcome = $this->notify($job->payload);
        $this->logger->info('push_notify done', ['jobId' => $job->id] + (\is_array($outcome) ? $outcome : ['outcome' => $outcome]));

        // No mail provider involved: nothing to report to the account health.
        return false;
    }

    /**
     * @param array<string, mixed> $payload
     *
     * @return array{sent: int, removed: int, failed: int}|'not_configured'
     */
    public function notify(array $payload): array|string
    {
        $userId = isset($payload['userId']) && \is_string($payload['userId']) && $payload['userId'] !== '' ? $payload['userId'] : null;
        if ($userId === null) {
            throw new \InvalidArgumentException('push_notify job without userId');
        }
        $transports = array_keys(array_filter(['webpush' => $this->vapid !== null, 'fcm' => $this->fcm !== null]));
        if ($transports === []) {
            // Nothing to retry: neither VAPID keys (scripts/setup-env.sh) nor FCM are configured.
            $this->logger->warn('push_notify skipped: no push transport configured');

            return 'not_configured';
        }

        $pdo = $this->db->pdo();
        // Only devices that are still logged in (active session, not revoked).
        $placeholders = implode(', ', array_fill(0, \count($transports), '?'));
        $rows = Database::run(
            $pdo,
            "SELECT ps.id, ps.transport, ps.endpoint, ps.keys_enc, d.installation_id, u.wrapped_dek
             FROM push_subscription ps
             JOIN device d ON d.id = ps.device_id
             JOIN `user` u ON u.id = d.user_id
             WHERE d.user_id = ? AND ps.transport IN ({$placeholders}) AND ps.disabled_at IS NULL
               AND d.revoked_at IS NULL
               AND EXISTS (SELECT 1 FROM session s WHERE s.device_id = d.id AND s.expires_at > UTC_TIMESTAMP(6))",
            [$userId, ...$transports],
        )->fetchAll();
        $outcome = ['sent' => 0, 'removed' => 0, 'failed' => 0];
        if ($rows === []) {
            return $outcome;
        }
        /** @var list<array{id: string, transport: string, endpoint: string, keys_enc: string, installation_id: string, wrapped_dek: ?string}> $rows */
        $dek = null;
        $badge = $this->badgeCount($userId);

        foreach ($rows as $row) {
            $ref = $row['transport'] === 'fcm' ? ['pushHost' => 'fcm.googleapis.com', 'endpointHash' => substr(hash('sha256', $row['endpoint']), 0, 12)] : Endpoint::ref($row['endpoint']);
            try {
                if ($row['transport'] === 'fcm') {
                    \assert($this->fcm !== null);
                    $status = $this->fcm->send($row['endpoint'], $row['installation_id'], $badge);
                } else {
                    $dek ??= $this->userKey($row['wrapped_dek']);
                    $status = $this->deliver($dek, $row['endpoint'], $row['keys_enc'], PushPayload::json($row['installation_id'], $badge));
                }
            } catch (\Throwable $e) {
                $status = 0;
                $this->logger->warn('push delivery error', ['subscriptionId' => $row['id']] + $ref + ['errName' => $e::class]);
            }

            if ($status >= 200 && $status < 300) {
                ++$outcome['sent'];
                Database::run($pdo, 'UPDATE push_subscription SET failure_count = 0, last_success_at = UTC_TIMESTAMP(6) WHERE id = ?', [$row['id']]);
            } elseif ($status === 404 || $status === 410) {
                // Expired or unsubscribed in the browser: the endpoint is gone for good.
                ++$outcome['removed'];
                Database::run($pdo, 'DELETE FROM push_subscription WHERE id = ?', [$row['id']]);
                $this->logger->info('push subscription expired, removed', ['subscriptionId' => $row['id']] + $ref + ['status' => $status]);
            } else {
                ++$outcome['failed'];
                // MySQL assigns left to right: disabled_at sees the old failure_count.
                Database::run(
                    $pdo,
                    'UPDATE push_subscription
                     SET disabled_at = CASE WHEN failure_count + 1 >= ? THEN UTC_TIMESTAMP(6) ELSE disabled_at END,
                         failure_count = failure_count + 1
                     WHERE id = ?',
                    [self::MAX_FAILURES, $row['id']],
                );
                if ($status !== 0) {
                    $this->logger->warn('push delivery failed', ['subscriptionId' => $row['id']] + $ref + ['status' => $status]);
                }
                $disabled = Database::run($pdo, 'SELECT disabled_at IS NOT NULL FROM push_subscription WHERE id = ?', [$row['id']])->fetchColumn();
                if ((int) $disabled === 1) {
                    $this->logger->warn('push subscription disabled after failures', ['subscriptionId' => $row['id']] + $ref);
                }
            }
        }

        return $outcome;
    }

    private function userKey(?string $wrapped): string
    {
        if ($wrapped === null || $wrapped === '') {
            throw new \RuntimeException('user key missing');
        }

        return Envelope::unwrapAccountKey($this->config->get('MASTER_KEY'), $wrapped);
    }

    /**
     * Unread INBOX messages over all accounts of the user (the app badge),
     * counted like the unreadCount of GET /api/accounts.
     */
    public function badgeCount(string $userId): int
    {
        return (int) Database::run(
            $this->db->pdo(),
            "SELECT COUNT(*) FROM folder f
             JOIN mail_account ma ON ma.id = f.account_id
             JOIN message_location ml ON ml.folder_id = f.id
             WHERE ma.user_id = ? AND f.special_use = 'inbox'
               AND NOT EXISTS (SELECT 1 FROM message_flag mf WHERE mf.location_id = ml.id AND mf.flag = ?)",
            [$userId, '\Seen'],
        )->fetchColumn();
    }

    /** Encrypts and sends one message; returns the push service's HTTP status. */
    private function deliver(string $dek, string $endpoint, string $keysEnc, string $payload): int
    {
        \assert($this->vapid !== null);
        $keys = json_decode(Envelope::decryptField($dek, $keysEnc, Envelope::pushKeysAad($endpoint)), true, 4, JSON_THROW_ON_ERROR);
        $p256dh = \is_array($keys) && \is_string($keys['p256dh'] ?? null) ? WebPushCrypto::base64UrlDecode($keys['p256dh']) : null;
        $auth = \is_array($keys) && \is_string($keys['auth'] ?? null) ? WebPushCrypto::base64UrlDecode($keys['auth']) : null;
        if ($p256dh === null || $auth === null) {
            throw new \RuntimeException('invalid subscription keys');
        }
        $headers = [
            'TTL' => (string) self::TTL_SECONDS,
            'Urgency' => 'normal',
            'Content-Type' => 'application/octet-stream',
            'Content-Encoding' => 'aes128gcm',
            'Authorization' => $this->vapid->authorization($endpoint),
        ];

        return $this->sender->send($endpoint, $headers, WebPushCrypto::encrypt($payload, $p256dh, $auth));
    }
}
