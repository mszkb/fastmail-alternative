<?php

declare(strict_types=1);

namespace Fma\Tests\Live;

use Fma\Config;
use Fma\Log\Logger;
use Fma\Mail\FolderDetection;
use Fma\Mail\HostConfig;
use Fma\Mail\ImapActions;
use Fma\Mail\ImapClient;
use Fma\Mail\MimeBuilder;
use Fma\Mail\SmtpClient;
use Fma\Mail\SocketConnectionTester;
use Fma\Mail\TransportPolicy;
use Fma\Tests\Support\Http;
use PHPUnit\Framework\TestCase;

/**
 * Tests against a real provider account (docs/product/mail-providers.md),
 * with the transport policy of production: public hosts only, verified
 * certificates. Configured by LIVE_MAIL_USER, LIVE_MAIL_PASSWORD and
 * LIVE_IMAP_HOST/PORT, LIVE_SMTP_HOST/PORT (`make test-live` reads
 * .env.live); skipped without them. Use a dedicated test account: each run
 * sends one mail to itself and deletes every mail with the marker subject.
 */
final class ProviderLiveTest extends TestCase
{
    private const MARKER = 'fma-live-';

    private HostConfig $imap;
    private HostConfig $smtp;

    protected function setUp(): void
    {
        $user = (string) getenv('LIVE_MAIL_USER');
        $password = (string) getenv('LIVE_MAIL_PASSWORD');
        $imapHost = (string) getenv('LIVE_IMAP_HOST');
        $smtpHost = (string) getenv('LIVE_SMTP_HOST');
        if ($user === '' || $password === '' || $imapHost === '' || $smtpHost === '') {
            self::markTestSkipped('LIVE_MAIL_USER, LIVE_MAIL_PASSWORD, LIVE_IMAP_HOST or LIVE_SMTP_HOST not set');
        }
        $imapPort = (int) (getenv('LIVE_IMAP_PORT') ?: 993);
        $smtpPort = (int) (getenv('LIVE_SMTP_PORT') ?: 587);
        $this->imap = new HostConfig($imapHost, $imapPort, TransportPolicy::isSecurePort($imapPort), $user, $password);
        $this->smtp = new HostConfig($smtpHost, $smtpPort, TransportPolicy::isSecurePort($smtpPort), $user, $password);
    }

    public function testConnectionTestPassesWithVerifiedTlsAndLogsNoCredentials(): void
    {
        $log = Http::memoryStream();
        $tester = new SocketConnectionTester(Config::fromArray([]), new Logger('api', 'info', $log), new TransportPolicy(), 20.0);

        $imap = $tester->testImap($this->imap);
        self::assertTrue($imap->ok, 'IMAP: ' . $imap->code);
        self::assertTrue($tester->testSmtp($this->smtp)->ok, 'SMTP');

        $relevant = ['IDLE', 'CONDSTORE', 'QRESYNC', 'MOVE', 'SPECIAL-USE', 'UIDPLUS', 'LITERAL+'];
        fwrite(\STDERR, "\n{$this->imap->host} supports: " . implode(' ', array_intersect($relevant, $imap->capabilities))
            . ' | missing: ' . implode(' ', array_diff($relevant, $imap->capabilities)) . "\n");

        $contents = Http::contents($log);
        self::assertStringNotContainsString($this->imap->password, $contents);
        self::assertStringNotContainsString($this->imap->user, $contents);
    }

    public function testWrongPasswordIsAuthFailed(): void
    {
        $tester = new SocketConnectionTester(Config::fromArray([]), new Logger('api', 'info', Http::memoryStream()), new TransportPolicy(), 20.0);
        $wrong = new HostConfig($this->imap->host, $this->imap->port, $this->imap->secure, $this->imap->user, 'wrong-' . bin2hex(random_bytes(4)));

        self::assertSame('AUTH_FAILED', $tester->testImap($wrong)->code);
    }

    public function testFolderRolesAreDetected(): void
    {
        $client = ImapClient::connect(new TransportPolicy(), $this->imap);
        try {
            $roles = array_filter(FolderDetection::detect($client->list()));
        } finally {
            $client->logout();
        }

        foreach (['inbox', 'sent', 'drafts', 'trash', 'junk'] as $role) {
            self::assertContains($role, $roles, "no folder with role {$role}");
        }
    }

    public function testSentMailIsFoundBySubjectSearchAndDeleted(): void
    {
        $subject = self::MARKER . bin2hex(random_bytes(6));
        $raw = MimeBuilder::build([
            'from' => ['name' => '', 'address' => $this->smtp->user],
            'to' => [['name' => '', 'address' => $this->smtp->user]],
            'cc' => [],
            'bcc' => [],
            'subject' => $subject,
            'text' => "Automated test of fastmail-alternative (tests/Live). Safe to delete.\n",
            'messageId' => '<' . bin2hex(random_bytes(12)) . '@fma-live.invalid>',
            'date' => new \DateTimeImmutable(),
        ]);
        $smtp = SmtpClient::connect(new TransportPolicy(), $this->smtp);
        try {
            $smtp->sendMail($this->smtp->user, [$this->smtp->user], $raw);
        } finally {
            $smtp->quit();
        }

        $client = ImapClient::connect(new TransportPolicy(), $this->imap);
        try {
            $folders = $this->deliveryFolders($client);
            $foundIn = null;
            $deadline = microtime(true) + 120;
            while ($foundIn === null && microtime(true) < $deadline) {
                // Delivery only: a copy in Sent may show up before the INBOX one.
                foreach ($folders['delivery'] as $path) {
                    if ($this->search($client, $path, $subject) !== []) {
                        $foundIn = $path;
                        break;
                    }
                }
                if ($foundIn === null) {
                    usleep(5_000_000);
                }
            }
            // Before the assertions; also removes leftovers of earlier aborted runs.
            foreach ([...$folders['delivery'], ...$folders['sent']] as $path) {
                $actions = new ImapActions($client);
                $actions->select($path);
                $actions->delete($actions->search(ImapActions::searchCriteria(['subject' => self::MARKER])['parts']));
            }

            self::assertNotNull($foundIn, 'sent mail not delivered within 120 s');
            self::assertSame('INBOX', $foundIn, 'mail to itself landed in the junk folder');
            self::assertSame([], $this->search($client, $foundIn, $subject));
        } finally {
            $client->logout();
        }
    }

    /**
     * Where the mail may be delivered (INBOX, junk) and the sent folders
     * (some providers keep a copy of SMTP mail there).
     *
     * @return array{delivery: list<string>, sent: list<string>}
     */
    private function deliveryFolders(ImapClient $client): array
    {
        $folders = ['delivery' => ['INBOX'], 'sent' => []];
        foreach (FolderDetection::detect($client->list()) as $path => $role) {
            if ($role === 'junk') {
                $folders['delivery'][] = $path;
            } elseif ($role === 'sent') {
                $folders['sent'][] = $path;
            }
        }

        return $folders;
    }

    /** @return list<int> */
    private function search(ImapClient $client, string $path, string $subject): array
    {
        $actions = new ImapActions($client);
        $actions->select($path, readOnly: true);

        return $actions->search(ImapActions::searchCriteria(['subject' => $subject])['parts']);
    }
}
