<?php

declare(strict_types=1);

namespace Fma\Jobs;

use Fma\Db\Database;

/**
 * Progress and cooperative cancellation of one folder_sync/message_sync
 * run (#119), stored in its job row.
 *
 * - report(): phase, folder id and done/total; written when the phase or
 *   the folder changes, otherwise at most every MIN_WRITE_SECONDS (the Pi
 *   and shared hosting should not get one write per message).
 * - cancelled(): whether cancel_requested_at is set. Handlers call it
 *   between their atomic units (a stored message, a folder) and stop
 *   cleanly; the answer sticks once true.
 *
 * Only ids and numbers are stored, never names or contents (principles 5/6).
 */
final class SyncProgress
{
    public const MIN_WRITE_SECONDS = 2.0;
    /** Phases as the API reports them. */
    public const PHASES = ['folders', 'headers', 'bodies', 'flags', 'expunge'];

    private float $lastWrite = -INF;
    private ?string $phase = null;
    private ?string $folderId = null;
    private bool $cancelled = false;

    /** @param (\Closure(): float)|null $clock seconds, for tests */
    public function __construct(
        private readonly Database $db,
        private readonly string $jobId,
        private readonly ?\Closure $clock = null,
    ) {}

    public function report(string $phase, ?string $folderId, ?int $done = null, ?int $total = null): void
    {
        if (!\in_array($phase, self::PHASES, true)) {
            throw new \InvalidArgumentException('unknown sync phase');
        }
        $now = $this->now();
        $changed = $phase !== $this->phase || $folderId !== $this->folderId;
        if (!$changed && $now - $this->lastWrite < self::MIN_WRITE_SECONDS) {
            return;
        }
        $this->phase = $phase;
        $this->folderId = $folderId;
        $this->lastWrite = $now;
        Database::run(
            $this->db->pdo(),
            "UPDATE job SET progress_phase = ?, progress_folder_id = ?, progress_done = ?, progress_total = ?,
               progress_updated_at = UTC_TIMESTAMP(6)
             WHERE id = ? AND state = 'running'",
            [$phase, $folderId, $done === null ? null : max(0, $done), $total === null ? null : max(0, $total), $this->jobId],
        );
    }

    public function cancelled(): bool
    {
        if (!$this->cancelled) {
            $this->cancelled = Database::run(
                $this->db->pdo(),
                'SELECT 1 FROM job WHERE id = ? AND cancel_requested_at IS NOT NULL',
                [$this->jobId],
            )->fetchColumn() !== false;
        }

        return $this->cancelled;
    }

    private function now(): float
    {
        return $this->clock !== null ? ($this->clock)() : microtime(true);
    }
}
