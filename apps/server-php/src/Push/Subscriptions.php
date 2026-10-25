<?php

declare(strict_types=1);

namespace Fma\Push;

use Fma\Auth\Sessions;
use Fma\Config;
use Fma\Crypto\Envelope;
use Fma\Db\Database;
use Fma\Db\Uuid;
use Fma\Mail\Ssrf;

/**
 * Web Push subscriptions (roadmap 4.3, ADR-0005, docs/architecture/push.md):
 * - endpoints must be https URLs on a public host without credentials
 *   (SSRF guard; the job checks the host again before every send);
 *   MAIL_INSECURE_TRANSPORT=1 (dev/test) allows http and private hosts;
 * - p256dh/auth are encrypted with the user DEK under
 *   Envelope::pushKeysAad(endpoint); the DEK is created on first use;
 * - upsert by endpoint: the same browser after a new login moves to the
 *   new device; an endpoint of another user is refused;
 * - transport 'fcm' (#139): `{transport: "fcm", token}` from the Android
 *   app; the registration token is stored in `endpoint` (it is only usable
 *   with the instance's own FCM service account), keys_enc stays empty.
 */
final class Subscriptions
{
    public const MAX_ENDPOINT_LENGTH = 2048;
    public const FCM_TOKEN_RE = '/^[A-Za-z0-9_:\-]{20,1024}$/';
    /** MySQL: duplicate key, deadlock (a concurrent first upsert of the same endpoint). */
    private const RETRY_ERRORS = [1062, 1213];

    /** @param (callable(string): list<string>)|null $resolve test override for DNS */
    public function __construct(
        private readonly Database $db,
        private readonly Config $config,
        private readonly mixed $resolve = null,
    ) {}

    /**
     * Validates a PushSubscription JSON body.
     *
     * @param array<mixed> $body
     *
     * @return array{transport: 'webpush'|'fcm', endpoint: string, keys: array{p256dh: string, auth: string}|null}
     */
    public function validate(array $body): array
    {
        if (($body['transport'] ?? 'webpush') === 'fcm') {
            $token = isset($body['token']) && \is_string($body['token']) ? $body['token'] : '';
            if (preg_match(self::FCM_TOKEN_RE, $token) !== 1) {
                throw new InvalidSubscriptionException('Ungültiges FCM-Token.');
            }

            return ['transport' => 'fcm', 'endpoint' => $token, 'keys' => null];
        }
        if (($body['transport'] ?? 'webpush') !== 'webpush') {
            throw new InvalidSubscriptionException('Unbekannter Push-Transport.');
        }
        $endpoint = isset($body['endpoint']) && \is_string($body['endpoint']) ? $body['endpoint'] : '';
        if ($endpoint === '' || \strlen($endpoint) > self::MAX_ENDPOINT_LENGTH) {
            throw new InvalidSubscriptionException('Ungültiger Push-Endpoint.');
        }
        $url = Endpoint::parse($endpoint);
        if ($url === null) {
            throw new InvalidSubscriptionException('Ungültiger Push-Endpoint.');
        }
        $testMode = $this->config->bool('MAIL_INSECURE_TRANSPORT');
        $allowHttp = $testMode && $url['scheme'] === 'http';
        if (($url['scheme'] !== 'https' && !$allowHttp) || $url['hasCredentials']) {
            throw new InvalidSubscriptionException('Der Push-Endpoint muss eine https-URL sein.');
        }
        if (!$testMode) {
            try {
                Ssrf::assertPublicHost($url['host'], \is_callable($this->resolve) ? $this->resolve : null);
            } catch (\Throwable) {
                throw new InvalidSubscriptionException('Der Push-Endpoint ist nicht erreichbar.');
            }
        }

        $keys = isset($body['keys']) && \is_array($body['keys']) ? $body['keys'] : [];
        $p256dh = isset($keys['p256dh']) && \is_string($keys['p256dh']) ? $keys['p256dh'] : '';
        $auth = isset($keys['auth']) && \is_string($keys['auth']) ? $keys['auth'] : '';
        $publicKey = WebPushCrypto::base64UrlDecode($p256dh);
        $authSecret = WebPushCrypto::base64UrlDecode($auth);
        if ($publicKey === null || \strlen($publicKey) !== 65 || $publicKey[0] !== "\x04" || $authSecret === null || \strlen($authSecret) !== 16) {
            throw new InvalidSubscriptionException('Ungültige Schlüssel der Push-Subscription.');
        }

        return ['transport' => 'webpush', 'endpoint' => $endpoint, 'keys' => ['p256dh' => $p256dh, 'auth' => $auth]];
    }

    /**
     * The user's data key, created and stored on first use. A concurrent
     * first use keeps whichever key was stored first.
     */
    public function ensureUserKey(string $userId): string
    {
        $masterKey = Envelope::loadMasterKey($this->config->get('MASTER_KEY'));
        $keyId = $this->config->get('MASTER_KEY_ID', 'v1');
        $pdo = $this->db->pdo();
        Database::run(
            $pdo,
            'UPDATE `user` SET wrapped_dek = ?, key_id = ? WHERE id = ? AND wrapped_dek IS NULL',
            [Envelope::wrapDataKey($masterKey, Envelope::generateDataKey(), $keyId), $keyId, $userId],
        );
        $stored = Database::run($pdo, 'SELECT wrapped_dek FROM `user` WHERE id = ?', [$userId])->fetchColumn();
        if (!\is_string($stored) || $stored === '') {
            throw new \RuntimeException('user key missing');
        }

        return Envelope::unwrapDataKey($masterKey, $stored)['dataKey'];
    }

    /**
     * Stores the subscription for the device (upsert by endpoint), resetting
     * failure_count and disabled_at. Returns null when the endpoint belongs
     * to another user.
     *
     * @param array{transport?: 'webpush'|'fcm', endpoint: string, keys: array{p256dh: string, auth: string}|null} $subscription
     */
    public function save(string $userId, string $deviceId, array $subscription): ?string
    {
        $endpoint = $subscription['endpoint'];
        $transport = $subscription['transport'] ?? 'webpush';
        $keysEnc = '';
        if ($subscription['keys'] !== null) {
            $dek = $this->ensureUserKey($userId);
            $keysEnc = Envelope::encryptField($dek, json_encode($subscription['keys'], JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES), Envelope::pushKeysAad($endpoint));
        }
        $pdo = $this->db->pdo();
        for ($attempt = 1; ; ++$attempt) {
            $pdo->beginTransaction();
            try {
                /** @var array{id: string, user_id: string}|false $existing */
                $existing = Database::run(
                    $pdo,
                    'SELECT ps.id, d.user_id FROM push_subscription ps JOIN device d ON d.id = ps.device_id
                     WHERE ps.endpoint_hash = UNHEX(SHA2(?, 256)) FOR UPDATE',
                    [$endpoint],
                )->fetch();
                if ($existing === false) {
                    $id = Uuid::v4();
                    Database::run(
                        $pdo,
                        'INSERT INTO push_subscription (id, device_id, transport, endpoint, keys_enc) VALUES (?, ?, ?, ?, ?)',
                        [$id, $deviceId, $transport, $endpoint, $keysEnc],
                    );
                } elseif ($existing['user_id'] !== $userId) {
                    $id = null;
                } else {
                    $id = $existing['id'];
                    Database::run(
                        $pdo,
                        'UPDATE push_subscription SET device_id = ?, keys_enc = ?, failure_count = 0, disabled_at = NULL WHERE id = ?',
                        [$deviceId, $keysEnc, $id],
                    );
                }
                $pdo->commit();

                return $id;
            } catch (\PDOException $e) {
                if ($pdo->inTransaction()) {
                    $pdo->rollBack();
                }
                if ($attempt >= 3 || !\in_array((int) ($e->errorInfo[1] ?? 0), self::RETRY_ERRORS, true)) {
                    throw $e;
                }
            } catch (\Throwable $e) {
                if ($pdo->inTransaction()) {
                    $pdo->rollBack();
                }
                throw $e;
            }
        }
    }

    /**
     * Active subscriptions of non-revoked devices, current device first;
     * never endpoints or keys, only the push service host.
     *
     * @return list<array{id: string, deviceId: string, deviceName: string, platform: string, isCurrentDevice: bool, pushService: string, createdAt: ?string, lastSuccessAt: ?string}>
     */
    public function list(string $userId, string $currentDeviceId): array
    {
        $rows = Database::run(
            $this->db->pdo(),
            'SELECT ps.id, ps.device_id, d.name AS device_name, d.platform, ps.transport, ps.endpoint, ps.created_at, ps.last_success_at
             FROM push_subscription ps
             JOIN device d ON d.id = ps.device_id
             WHERE d.user_id = ? AND d.revoked_at IS NULL AND ps.disabled_at IS NULL
             ORDER BY (ps.device_id = ?) DESC, ps.created_at DESC',
            [$userId, $currentDeviceId],
        )->fetchAll();
        $result = [];
        foreach ($rows as $row) {
            /** @var array{id: string, device_id: string, device_name: string, platform: string, transport: string, endpoint: string, created_at: string, last_success_at: ?string} $row */
            $result[] = [
                'id' => $row['id'],
                'deviceId' => $row['device_id'],
                'deviceName' => $row['device_name'],
                'platform' => $row['platform'],
                'isCurrentDevice' => $row['device_id'] === $currentDeviceId,
                'pushService' => $row['transport'] === 'fcm' ? 'fcm.googleapis.com' : Endpoint::host($row['endpoint']),
                'createdAt' => Sessions::iso($row['created_at']),
                'lastSuccessAt' => Sessions::iso($row['last_success_at']),
            ];
        }

        return $result;
    }

    /** This browser unsubscribes (by endpoint); false when not found. */
    public function deleteByEndpoint(string $userId, string $endpoint): bool
    {
        return Database::run(
            $this->db->pdo(),
            'DELETE FROM push_subscription
             WHERE endpoint_hash = UNHEX(SHA2(?, 256))
               AND device_id IN (SELECT id FROM device WHERE user_id = ?)',
            [$endpoint, $userId],
        )->rowCount() > 0;
    }

    /** Device management: removes any subscription of the user; false when not found. */
    public function deleteById(string $userId, string $id): bool
    {
        return Database::run(
            $this->db->pdo(),
            'DELETE FROM push_subscription WHERE id = ? AND device_id IN (SELECT id FROM device WHERE user_id = ?)',
            [$id, $userId],
        )->rowCount() > 0;
    }
}
