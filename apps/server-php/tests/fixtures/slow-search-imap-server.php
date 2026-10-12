<?php

declare(strict_types=1);

// IMAP server for tests/Unit/Mail/ProviderSearchTest.php: UID SEARCH answers
// "* SEARCH 3 1" at once, except in the mailbox "Slow", where it takes
// <seconds> first and sends a progress line every second meanwhile, like
// Dovecot without a search index scanning bodies (`* OK [INPROGRESS ...]`).
// Usage: php slow-search-imap-server.php <seconds>
// Listens on a random port of 127.0.0.1 and prints "PORT <n>" once ready.

$delay = (int) ($argv[1] ?? 5);
$server = stream_socket_server('tcp://127.0.0.1:0', $errno, $errstr);
if ($server === false) {
    fwrite(STDERR, "listen failed: {$errstr}\n");
    exit(1);
}
echo 'PORT ' . parse_url('tcp://' . stream_socket_get_name($server, false), PHP_URL_PORT) . "\n";
fflush(STDOUT);

while (($conn = @stream_socket_accept($server, -1)) !== false) {
    fwrite($conn, "* OK [CAPABILITY IMAP4rev1] fake ready\r\n");
    $selected = '';
    while (($line = fgets($conn)) !== false) {
        if (preg_match('/^(\S+) (UID SEARCH|\S+) ?(.*)$/i', rtrim($line, "\r\n"), $m) !== 1) {
            continue;
        }
        [, $tag, $command, $rest] = $m;
        switch (strtoupper($command)) {
            case 'CAPABILITY':
                fwrite($conn, "* CAPABILITY IMAP4rev1\r\n{$tag} OK done\r\n");
                break;
            case 'EXAMINE':
            case 'SELECT':
                $selected = trim($rest, '"');
                fwrite($conn, "* 3 EXISTS\r\n* OK [UIDVALIDITY 7] ok\r\n{$tag} OK [READ-ONLY] done\r\n");
                break;
            case 'UID SEARCH':
                for ($i = 1; $selected === 'Slow' && $i <= $delay; ++$i) {
                    sleep(1);
                    @fwrite($conn, "* OK [INPROGRESS ({$tag} {$i} {$delay})] Searched\r\n");
                }
                @fwrite($conn, "* SEARCH 3 1\r\n{$tag} OK done\r\n");
                break;
            case 'LOGOUT':
                fwrite($conn, "* BYE\r\n{$tag} OK done\r\n");
                break 2;
            default:
                fwrite($conn, "{$tag} OK done\r\n");
        }
    }
    @fclose($conn);
}
