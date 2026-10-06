<?php

declare(strict_types=1);

namespace Fma\Jobs;

use Fma\Mail\ImapClient;

/** Mutable state of one account's IDLE connection (IdleManager only). */
final class IdleConnection
{
    public const WAITING = 'waiting';   // not connected, retry at $retryAt
    public const STARTING = 'starting'; // IDLE sent, waiting for '+'
    public const IDLING = 'idling';     // in IDLE
    public const ENDING = 'ending';     // DONE sent, waiting for the tagged completion

    public ?ImapClient $client = null;
    public string $state = self::WAITING;
    public int $failures = 0;
    /** microtime of the last successful connect (0 while not connected). */
    public float $connectedAt = 0.0;
    /** microtime of the last state change (IDLE start, DONE sent, ...). */
    public float $stateSince = 0.0;
    public float $retryAt = 0.0;
    public string $tag = '';
    /** Received data without a complete line yet. */
    public string $buffer = '';

    public function __construct(
        public readonly string $accountId,
        public readonly string $folderId,
    ) {}

    public function connected(): bool
    {
        return $this->client !== null && $this->state !== self::WAITING;
    }
}
