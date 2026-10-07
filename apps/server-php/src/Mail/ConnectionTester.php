<?php

declare(strict_types=1);

namespace Fma\Mail;

/**
 * IMAP/SMTP connection test (connect, TLS, login). Implementations go
 * through the transport policy (SSRF check, port allowlist, mandatory
 * STARTTLS). Tests inject a fake.
 */
interface ConnectionTester
{
    public function testImap(HostConfig $config): TestResult;

    public function testSmtp(HostConfig $config): TestResult;
}
