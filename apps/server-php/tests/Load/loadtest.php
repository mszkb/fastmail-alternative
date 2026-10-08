<?php

declare(strict_types=1);

// Load test for the PHP backend (roadmap 6.6, #60): many accounts, large
// mailboxes. Fills one GreenMail mailbox via IMAP APPEND, creates N accounts
// on it (separate accounts with their own DEK, like real ones), lets the real
// job runner sync them in this process and measures sync time, jobs, peak
// memory, database size and the latency of the main API endpoints (in-process
// Slim requests). Optionally adds synthetic rows to one folder to measure the
// message list on a very large folder.
//
//   LOADTEST_DATABASE_URL=mysql://root:root@127.0.0.1:33306/fma_load \
//   GREENMAIL_HOST=127.0.0.1 composer loadtest -- --accounts=3 --messages=5000 --synthetic=50000 [--full-history]
//
// The database in LOADTEST_DATABASE_URL is WIPED. GreenMail must accept any
// login (greenmail.auth.disabled, see `make test-services`). Prints Markdown.

use Fma\App;
use Fma\Auth\Sessions;
use Fma\Config;
use Fma\Crypto\Envelope;
use Fma\Db\Database;
use Fma\Db\Migrator;
use Fma\Db\Uuid;
use Fma\Jobs\Bootstrap;
use Fma\Jobs\Deadline;
use Fma\Log\Logger;
use Fma\Mail\HostConfig;
use Fma\Mail\ImapClient;
use Fma\Mail\TransportPolicy;
use Fma\Tests\Support\Http;

require __DIR__ . '/../../vendor/autoload.php';

$options = getopt('', ['accounts::', 'messages::', 'synthetic::', 'runs::', 'full-history']);
$option = static fn(string $name, int $default): int => \is_array($options) && \is_string($options[$name] ?? null) ? (int) $options[$name] : $default;
$accounts = max(1, $option('accounts', 3));
$messages = max(1, $option('messages', 1000));
$synthetic = max(0, $option('synthetic', 0));
$runs = max(5, $option('runs', 30));
$fullHistory = \is_array($options) && \array_key_exists('full-history', $options);
$url = getenv('LOADTEST_DATABASE_URL');
$host = getenv('GREENMAIL_HOST');
if (!is_string($url) || $url === '' || !is_string($host) || $host === '') {
    fwrite(STDERR, "LOADTEST_DATABASE_URL (wiped!) and GREENMAIL_HOST are required\n");
    exit(2);
}
$imapPort = (int) (getenv('GREENMAIL_IMAP_PORT') ?: 3143);
$smtpPort = (int) (getenv('GREENMAIL_SMTP_PORT') ?: 3025);
// Any password works with GreenMail (auth disabled); the Dovecot test image wants `pass`.
$imapPassword = getenv('LOADTEST_IMAP_PASSWORD') ?: 'pw';

$dataDir = sys_get_temp_dir() . '/fma-loadtest-' . bin2hex(random_bytes(4));
mkdir($dataDir, 0o700);
$masterKey = base64_encode(random_bytes(32));
$config = Config::fromArray([
    'DATABASE_URL' => $url,
    'MASTER_KEY' => $masterKey,
    'MAIL_DATA_DIR' => $dataDir,
    'MAIL_ALLOW_PRIVATE_HOSTS' => '1',
    'MAIL_INSECURE_TRANSPORT' => '1',
    'MAIL_EXTRA_PORTS' => "{$imapPort},{$smtpPort}",
    'LOG_LEVEL' => 'error',
]);
$db = new Database($config);
$pdo = $db->pdo();
$logStream = fopen('php://memory', 'w+b');
\assert($logStream !== false);
$logger = new Logger('loadtest', 'error', $logStream);
$apiLogger = new Logger('api', 'error');

/** @param list<float> $values */
$percentile = static function (array $values, float $p): float {
    sort($values);

    return $values[(int) min(\count($values) - 1, ceil($p * \count($values)) - 1)];
};
$ms = static fn(float $seconds): string => number_format($seconds * 1000, 1, ',', '');
$mb = static fn(int|float $bytes): string => number_format($bytes / 1048576, 1, ',', '');
$out = new class {
    /** Prints each line at once, so a late failure keeps the results so far. */
    public function add(string $line): void
    {
        echo $line, "\n";
    }
};

// Fresh schema.
$pdo->exec('SET FOREIGN_KEY_CHECKS = 0');
foreach (Database::run($pdo, 'SHOW TABLES')->fetchAll(PDO::FETCH_COLUMN) as $table) {
    $pdo->exec('DROP TABLE `' . (string) $table . '`');
}
$pdo->exec('SET FOREIGN_KEY_CHECKS = 1');
(new Migrator($pdo))->migrate();

// Fill one GreenMail mailbox.
$mailbox = 'load-' . bin2hex(random_bytes(4)) . '@example.org';
$policy = new TransportPolicy(allowPrivateHosts: true, insecureTransport: true, extraPorts: [$imapPort, $smtpPort]);
$imap = ImapClient::connect($policy, new HostConfig($host, $imapPort, false, $mailbox, $imapPassword));
$start = microtime(true);
for ($i = 1; $i <= $messages; ++$i) {
    $date = gmdate('D, j M Y H:i:s +0000', 1_780_000_000 + $i * 60);
    $body = str_repeat("Zeile {$i} mit etwas Text für den Lasttest.\r\n", 20);
    $mail = "From: \"Sender {$i}\" <sender{$i}@example.org>\r\nTo: {$mailbox}\r\nSubject: Lasttest {$i}\r\n"
        . "Message-ID: <load-{$i}@example.org>\r\nDate: {$date}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{$body}";
    $imap->command('APPEND INBOX () {' . \strlen($mail) . "+}\r\n" . $mail);
}
$imap->logout();
$fill = microtime(true) - $start;

// Accounts (all on the same mailbox, each with its own DEK).
$userId = Uuid::v4();
Database::run($pdo, 'INSERT INTO `user` (id, email, password_hash, unified_inbox_enabled) VALUES (?, ?, ?, TRUE)', [$userId, 'load@example.org', 'unused']);
$accountIds = [];
for ($a = 0; $a < $accounts; ++$a) {
    $id = Uuid::v4();
    $dek = Envelope::generateDataKey();
    Database::run(
        $pdo,
        'INSERT INTO mail_account (id, user_id, display_name, email_address, imap_host, imap_port, smtp_host, smtp_port, wrapped_dek, key_id, credential_enc, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [$id, $userId, "Konto {$a}", $mailbox, $host, $imapPort, $host, $smtpPort, Envelope::wrapDataKey(Envelope::loadMasterKey($masterKey), $dek, 'v1'), 'v1',
            Envelope::encryptField($dek, json_encode(['imapUser' => $mailbox, 'imapPassword' => $imapPassword], JSON_THROW_ON_ERROR), Envelope::credentialAad($id)), $a],
    );
    $accountIds[] = $id;
}

// Initial sync with the real runner, until the queue is empty.
$runner = Bootstrap::runner($config, $logger, $db);
$queued = static fn(): int => (int) Database::run($pdo, "SELECT COUNT(*) FROM job WHERE state IN ('queued', 'running')")->fetchColumn();
$memoryBefore = memory_get_usage(true);
$start = microtime(true);
$runner->schedule();
$done = 0;
$failed = 0;
while ($queued() > 0) {
    $result = $runner->work(new Deadline(300));
    $done += $result['done'];
    $failed += $result['failed'];
}
$initial = microtime(true) - $start;
$synced = (int) Database::run($pdo, 'SELECT COUNT(*) FROM message')->fetchColumn();
$retried = (int) Database::run($pdo, 'SELECT COUNT(*) FROM job WHERE attempts > 1')->fetchColumn();

// Incremental run without changes (folder list, UID/FLAGS reconcile).
Database::run($pdo, "DELETE FROM job WHERE state IN ('done', 'failed')");
$start = microtime(true);
$runner->schedule();
Database::run($pdo, "INSERT INTO job (type, account_id, payload) SELECT 'folder_sync', id, '{}' FROM mail_account WHERE NOT EXISTS (SELECT 1 FROM job j WHERE j.account_id = mail_account.id AND j.state = 'queued')");
while ($queued() > 0) {
    $runner->work(new Deadline(300));
}
$incremental = microtime(true) - $start;

$out->add("Lauf: {$accounts} Konten, {$messages} Mails im Postfach, PHP " . PHP_VERSION . ', ' . php_uname('s') . '/' . php_uname('m') . ', '
    . (string) Database::run($pdo, 'SELECT VERSION()')->fetchColumn() . "; ein Prozess (Runner + API), Jobs nacheinander.\n");
$out->add('| Messgröße | Wert |');
$out->add('| --- | --- |');
$out->add('| Befüllen per IMAP APPEND | ' . number_format($fill, 1, ',', '') . ' s (≈ ' . (int) round($messages / max($fill, 0.001)) . ' Mails/s) |');
$out->add("| Initial-Sync ({$accounts} Konten) | " . number_format($initial, 1, ',', '') . " s, {$synced} Nachrichten, {$done} Jobs, {$failed} fehlgeschlagen, {$retried} wiederholt |");
$out->add("| Inkrementeller Lauf ohne Änderungen ({$accounts} Konten) | " . number_format($incremental, 2, ',', '') . ' s |');
$out->add('| Speicher vor Sync / Spitze (PHP, `memory_get_*_usage(true)`) | ' . $mb($memoryBefore) . ' MB / ' . $mb(memory_get_peak_usage(true)) . ' MB |');

// API latency, in-process.
$app = App::create($config, $db, $apiLogger, []);
$token = (new Sessions($db))->createDeviceWithSession($userId, 'Lasttest', 'desktop');
$call = static function (string $path) use ($app, $token): float {
    $request = Http::request('GET', $path, ['Sec-Fetch-Site' => 'same-origin'])->withCookieParams(['fma_session' => $token]);
    $query = parse_url($path, PHP_URL_QUERY);
    if (is_string($query)) {
        parse_str($query, $params);
        $request = $request->withQueryParams($params);
    }
    $start = microtime(true);
    $response = $app->handle($request);
    $elapsed = microtime(true) - $start;
    if ($response->getStatusCode() !== 200) {
        throw new RuntimeException("{$path} answered " . $response->getStatusCode() . ': ' . $response->getBody());
    }

    return $elapsed;
};
$inbox = (string) Database::run($pdo, "SELECT id FROM folder WHERE account_id = ? AND path = 'INBOX'", [$accountIds[0]])->fetchColumn();
$firstPage = Http::json($app->handle(Http::request('GET', "/api/folders/{$inbox}/messages?limit=50", ['Sec-Fetch-Site' => 'same-origin'])
    ->withCookieParams(['fma_session' => $token])->withQueryParams(['limit' => '50'])));
$cursor = is_string($firstPage['nextCursor'] ?? null) ? $firstPage['nextCursor'] : '';
$endpoints = [
    'Nachrichtenliste (50)' => "/api/folders/{$inbox}/messages?limit=50",
    'Nachrichtenliste, Seite 2' => "/api/folders/{$inbox}/messages?limit=50&cursor=" . rawurlencode($cursor),
    'Unified Inbox (50)' => '/api/unified/inbox?limit=50',
    'Suche (IMAP `SEARCH`, ohne Cache, höchstens 9 Aufrufe)' => "/api/accounts/{$accountIds[0]}/search?q=" . rawurlencode('Lasttest 4999'),
    'Speicher gesamt' => '/api/storage',
    'Ordnerbaum' => "/api/accounts/{$accountIds[0]}/folders",
];
$out->add('');
$out->add("API-Latenz ({$runs} Aufrufe je Endpunkt, Slim in-process, ms):\n");
$out->add('| Endpunkt | p50 | p95 | max |');
$out->add('| --- | --- | --- | --- |');
foreach ($endpoints as $name => $path) {
    // The search has its own limit of 10 provider searches per account and minute.
    $count = str_contains($path, '/search') ? min($runs, 9) : $runs;
    $times = [];
    for ($r = 0; $r < $count; ++$r) {
        $times[] = $call($path);
    }
    $out->add("| {$name} | " . $ms($percentile($times, 0.5)) . ' | ' . $ms($percentile($times, 0.95)) . ' | ' . $ms(max($times)) . ' |');
}

// Full history of one account: "load older" until the whole mailbox is synced.
if ($fullHistory) {
    $count = static fn(): int => (int) Database::run($pdo, 'SELECT COUNT(*) FROM message_location WHERE folder_id = ?', [$inbox])->fetchColumn();
    $before = $count();
    $start = microtime(true);
    $rounds = 0;
    do {
        $last = $count();
        $request = Http::request('POST', "/api/folders/{$inbox}/load-older", ['Sec-Fetch-Site' => 'same-origin'])->withCookieParams(['fma_session' => $token]);
        if ($app->handle($request)->getStatusCode() !== 202) {
            throw new RuntimeException('load-older failed');
        }
        while ($queued() > 0) {
            $runner->work(new Deadline(300));
        }
        ++$rounds;
    } while ($count() < $messages && $count() > $last);
    $elapsed = microtime(true) - $start;
    $loaded = $count() - $before;
    $out->add('');
    $out->add("Volle Historie (1 Konto, „Ältere laden“ bis alles da ist): {$loaded} weitere Mails in " . number_format($elapsed, 1, ',', '')
        . " s ({$rounds} Runden, ≈ " . (int) round($loaded / max($elapsed, 0.001)) . ' Mails/s), jetzt ' . $count() . ' im Ordner; Spitzen-Speicher ' . $mb(memory_get_peak_usage(true)) . ' MB.');
}

// Very large folder: synthetic rows (valid encryption, no raw files).
if ($synthetic > 0) {
    $account = $accountIds[0];
    $dek = Envelope::unwrapAccountKey($masterKey, (string) Database::run($pdo, 'SELECT wrapped_dek FROM mail_account WHERE id = ?', [$account])->fetchColumn());
    $folder = Uuid::v4();
    Database::run($pdo, "INSERT INTO folder (id, account_id, path, delimiter, uidvalidity) VALUES (?, ?, 'Gross', '/', 1)", [$folder, $account]);
    $start = microtime(true);
    $pdo->beginTransaction();
    for ($i = 1; $i <= $synthetic; ++$i) {
        $id = Uuid::v4();
        Database::run(
            $pdo,
            'INSERT INTO message (id, account_id, message_id_header, subject_enc, from_enc, recipients_enc, snippet_enc, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [$id, $account, "<syn-{$i}@example.org>", Envelope::encryptField($dek, "Synthetisch {$i}", Envelope::messageFieldAad('subject', $id)),
                Envelope::encryptField($dek, '[{"name":"S","address":"s@example.org"}]', Envelope::messageFieldAad('from', $id)),
                Envelope::encryptField($dek, '{"to":[],"cc":[]}', Envelope::messageFieldAad('recipients', $id)),
                Envelope::encryptField($dek, 'Vorschau', Envelope::messageFieldAad('snippet', $id)), gmdate('Y-m-d H:i:s', 1_700_000_000 + $i * 37)],
        );
        Database::run($pdo, 'INSERT INTO message_location (id, message_id, folder_id, uidvalidity, uid, sort_at) VALUES (?, ?, ?, 1, ?, ?)', [Uuid::v4(), $id, $folder, $i, gmdate('Y-m-d H:i:s', 1_700_000_000 + $i * 37)]);
        if ($i % 2000 === 0) {
            $pdo->commit();
            $pdo->beginTransaction();
        }
    }
    $pdo->commit();
    Database::run($pdo, 'ANALYZE TABLE message, message_location')->fetchAll();
    $insert = microtime(true) - $start;
    $times = [];
    for ($r = 0; $r < $runs; ++$r) {
        $times[] = $call("/api/folders/{$folder}/messages?limit=50");
    }
    $out->add('');
    $out->add("Großer Ordner: {$synthetic} synthetische Nachrichten (Einfügen " . number_format($insert, 1, ',', '') . ' s), Nachrichtenliste (50): p50 '
        . $ms($percentile($times, 0.5)) . ' ms, p95 ' . $ms($percentile($times, 0.95)) . ' ms, max ' . $ms(max($times)) . ' ms.');
}

$size = Database::run(
    $pdo,
    'SELECT table_name AS t, data_length + index_length AS b FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY b DESC',
)->fetchAll(PDO::FETCH_KEY_PAIR);
$total = array_sum(array_map(static fn(mixed $b): int => \is_numeric($b) ? (int) $b : 0, $size));
$top = array_slice($size, 0, 3, true);
$out->add('');
$out->add('DB-Größe (InnoDB, Daten + Indizes): ' . $mb($total) . ' MB; größte Tabellen: '
    . implode(', ', array_map(static fn(int|string $t, mixed $b): string => "`{$t}` " . $mb(\is_numeric($b) ? (int) $b : 0) . ' MB', array_keys($top), $top)) . '.');
$out->add('Spitzen-Speicher des Prozesses insgesamt: ' . $mb(memory_get_peak_usage(true)) . ' MB.');

exec('rm -rf ' . escapeshellarg($dataDir));
