<?php

declare(strict_types=1);

namespace Fma\Tests\Support;

use Fma\Mail\ConnectionTester;
use Fma\Mail\HostConfig;
use Fma\Mail\TestResult;

/** Records the tested configs; fails with a code when one is set. */
final class FakeConnectionTester implements ConnectionTester
{
    /** @var list<HostConfig> */
    public array $calls = [];
    public ?string $imapCode = null;
    public ?string $smtpCode = null;
    /** @var list<string> */
    public array $capabilities = ['IMAP4rev1'];

    public function reset(): void
    {
        $this->calls = [];
    }

    public function testImap(HostConfig $config): TestResult
    {
        $this->calls[] = $config;

        return $this->imapCode !== null ? new TestResult(false, $this->imapCode, 'Zugangsdaten wurden abgelehnt.') : new TestResult(true, capabilities: $this->capabilities);
    }

    public function testSmtp(HostConfig $config): TestResult
    {
        $this->calls[] = $config;

        return $this->smtpCode !== null ? new TestResult(false, $this->smtpCode, 'Zugangsdaten wurden abgelehnt.') : new TestResult(true);
    }
}
