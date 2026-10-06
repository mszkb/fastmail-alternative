<?php

declare(strict_types=1);

namespace Fma\Push;

/**
 * The push payload, port of buildPushPayload (packages/shared/src/push.ts):
 * ONLY event type, installation id and badge - never subjects, senders or
 * any other mail content (CLAUDE.md principle 4).
 */
final class PushPayload
{
    /** @return array{type: 'new_mail', installationId: string, badge: int} */
    public static function build(string $installationId, int $badge): array
    {
        return ['type' => 'new_mail', 'installationId' => $installationId, 'badge' => max(0, $badge)];
    }

    public static function json(string $installationId, int $badge): string
    {
        return json_encode(self::build($installationId, $badge), JSON_THROW_ON_ERROR);
    }
}
