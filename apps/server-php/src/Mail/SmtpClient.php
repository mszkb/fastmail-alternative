<?php

declare(strict_types=1);

namespace Fma\Mail;

/**
 * Small ESMTP client: EHLO, mandatory STARTTLS on plain ports, AUTH PLAIN
 * or LOGIN (XOAUTH2 for OAuth accounts), QUIT. Sending (MAIL FROM/RCPT/DATA) follows with #105.
 */
final class SmtpClient
{
    /** @var list<string> */
    private array $extensions = [];

    private function __construct(private readonly MailSocket $socket) {}

    public static function connect(TransportPolicy $policy, HostConfig $config, float $timeout = 15.0): self
    {
        $client = new self(MailSocket::open($policy, 'smtp', $config->host, $config->port, $config->secure, $timeout));
        try {
            $client->expect(220);
            $client->ehlo();
            if (!$config->secure && !$policy->insecureTransport) {
                if (!$client->supports('STARTTLS')) {
                    throw new MailException('TLS_REQUIRED', 'server does not support STARTTLS');
                }
                $client->send('STARTTLS', 220, 'ETLS');
                $client->socket->startTls();
                $client->ehlo();
            }
            if ($config->oauthToken !== null) {
                // A rejected token gets a 334 challenge; the connection is closed anyway.
                $client->send('AUTH XOAUTH2 ' . $config->xoauth2(), 235, 'AUTH_FAILED');
            } else {
                $client->authenticate($config->user, $config->password);
            }
        } catch (\Throwable $e) {
            $client->socket->close();
            throw $e;
        }

        return $client;
    }

    public function quit(): void
    {
        try {
            $this->send('QUIT', 221);
        } catch (MailException) {
            // Closing anyway.
        } finally {
            $this->socket->close();
        }
    }

    private function ehlo(): void
    {
        $lines = $this->send('EHLO ' . self::localName(), 250);
        $this->extensions = array_map(static fn(string $line): string => strtoupper(trim(substr($line, 4))), \array_slice($lines, 1));
    }

    private function supports(string $extension): bool
    {
        foreach ($this->extensions as $line) {
            if ($line === $extension || str_starts_with($line, "{$extension} ")) {
                return true;
            }
        }

        return false;
    }

    private function authenticate(string $user, #[\SensitiveParameter] string $password): void
    {
        $auth = '';
        foreach ($this->extensions as $line) {
            if (str_starts_with($line, 'AUTH ') || str_starts_with($line, 'AUTH=')) {
                $auth .= ' ' . substr($line, 5);
            }
        }
        $mechanisms = array_filter(explode(' ', $auth));
        if (\in_array('PLAIN', $mechanisms, true)) {
            $this->send('AUTH PLAIN ' . base64_encode("\0{$user}\0{$password}"), 235, 'AUTH_FAILED');
        } elseif (\in_array('LOGIN', $mechanisms, true)) {
            $this->send('AUTH LOGIN', 334, 'AUTH_FAILED');
            $this->send(base64_encode($user), 334, 'AUTH_FAILED');
            $this->send(base64_encode($password), 235, 'AUTH_FAILED');
        } else {
            throw new MailException('AUTH_FAILED', 'no supported AUTH mechanism');
        }
    }

    /**
     * Sends a command and expects the reply code; otherwise throws with
     * `$errorCode` (no server text).
     *
     * @return list<string> reply lines
     */
    private function send(#[\SensitiveParameter] string $command, int $expected, string $errorCode = 'PROTOCOL'): array
    {
        $this->socket->write("{$command}\r\n");

        return $this->expect($expected, $errorCode);
    }

    /** @return list<string> */
    private function expect(int $code, string $errorCode = 'PROTOCOL'): array
    {
        $lines = [];
        do {
            $line = rtrim($this->socket->readLine(), "\r\n");
            $lines[] = $line;
        } while (isset($line[3]) && $line[3] === '-');
        if ((int) substr($lines[0], 0, 3) !== $code) {
            throw new MailException($errorCode, 'unexpected reply');
        }

        return $lines;
    }

    private static function localName(): string
    {
        $name = gethostname();

        return \is_string($name) && preg_match('/^[A-Za-z0-9.-]+$/', $name) === 1 ? $name : 'localhost';
    }

    /**
     * Sends a raw RFC 5322 message (MAIL FROM, RCPT TO, DATA with
     * dot-stuffing). Rejections throw MailException with SMTP_REJECTED (5xx;
     * AUTH_FAILED for 530/535) or SMTP_TEMPORARY (4xx) - never the server text.
     *
     * @param list<string> $recipients
     */
    public function sendMail(string $from, array $recipients, #[\SensitiveParameter] string $raw): void
    {
        foreach ([$from, ...$recipients] as $address) {
            if (preg_match('/[\r\n<>\x00]/', $address) === 1) {
                throw new MailException('SMTP_REJECTED', 'invalid address');
            }
        }
        $this->smtpStep("MAIL FROM:<{$from}>", 250);
        foreach ($recipients as $recipient) {
            $this->smtpStep("RCPT TO:<{$recipient}>", 250, 251);
        }
        $this->smtpStep('DATA', 354);
        $data = (string) preg_replace('/\r\n|\r|\n/', "\r\n", $raw);
        $data = (string) preg_replace('/^\./m', '..', $data);
        if (!str_ends_with($data, "\r\n")) {
            $data .= "\r\n";
        }
        $this->socket->write($data . ".\r\n");
        $this->smtpReply(250);
    }

    private function smtpStep(#[\SensitiveParameter] string $command, int ...$expected): void
    {
        $this->socket->write("{$command}\r\n");
        $this->smtpReply(...$expected);
    }

    private function smtpReply(int ...$expected): void
    {
        do {
            $line = rtrim($this->socket->readLine(), "\r\n");
        } while (isset($line[3]) && $line[3] === '-');
        $code = (int) substr($line, 0, 3);
        if (\in_array($code, $expected, true)) {
            return;
        }
        if ($code === 530 || $code === 535) {
            throw new MailException('AUTH_FAILED', "smtp reply {$code}");
        }
        if ($code >= 500 && $code < 600) {
            throw new MailException('SMTP_REJECTED', "smtp reply {$code}");
        }
        if ($code >= 400 && $code < 500) {
            throw new MailException('SMTP_TEMPORARY', "smtp reply {$code}");
        }
        throw new MailException('PROTOCOL', 'unexpected reply');
    }
}
