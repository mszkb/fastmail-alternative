<?php

declare(strict_types=1);

// Scripted IMAP server for tests/Integration/CondstoreSyncTest.php (GreenMail
// has no CONDSTORE). Usage: php fake-imap-server.php <state.json> <commands.log>
// Listens on a random port of 127.0.0.1 and prints "PORT <n>" once ready.
// The mailbox is re-read from the state file for every command, so a test
// changes it between syncs by rewriting the file:
//   {"capabilities": "IMAP4rev1 CONDSTORE", "highestModseq": 12 | null (NOMODSEQ),
//    "uids": [1, 2], "flags": {"1": ["\\Seen"]}, "modseqs": {"1": 12}}
// Every command line is appended to the log (LOGIN without credentials).
// With "oauthUser"/"oauthToken" in the state, AUTHENTICATE XOAUTH2 checks the
// SASL response (inline with SASL-IR, else after a continuation) and answers
// a wrong token like Gmail: an error challenge, then NO.
// One connection at a time, which is all message_sync uses.

[, $stateFile, $logFile] = $argv;
$server = stream_socket_server('tcp://127.0.0.1:0', $errno, $errstr);
if ($server === false) {
    fwrite(STDERR, "listen failed: {$errstr}\n");
    exit(1);
}
echo 'PORT ' . parse_url('tcp://' . stream_socket_get_name($server, false), PHP_URL_PORT) . "\n";
fflush(STDOUT);

$state = static fn(): array => json_decode((string) file_get_contents($stateFile), true, 512, JSON_THROW_ON_ERROR);

while (($conn = @stream_socket_accept($server, -1)) !== false) {
    fwrite($conn, '* OK [CAPABILITY ' . $state()['capabilities'] . "] fake ready\r\n");
    while (($line = fgets($conn)) !== false) {
        $line = rtrim($line, "\r\n");
        if (preg_match('/^(\S+) (?:UID )?(\S+)(.*)$/i', $line, $m) !== 1) {
            continue;
        }
        [, $tag, $command, $rest] = $m;
        $command = strtoupper($command);
        file_put_contents($logFile, match ($command) {
            'LOGIN' => "{$tag} LOGIN",
            'AUTHENTICATE' => "{$tag} AUTHENTICATE " . strtoupper(explode(' ', trim($rest))[0]),
            default => $line,
        } . "\n", FILE_APPEND);
        $box = $state();
        if ($command === 'AUTHENTICATE') {
            $parts = explode(' ', trim($rest));
            $response = $parts[1] ?? null;
            if ($response === null) {
                fwrite($conn, "+ \r\n");
                $response = rtrim((string) fgets($conn), "\r\n");
            }
            $expected = 'user=' . ($box['oauthUser'] ?? '') . "\x01auth=Bearer " . ($box['oauthToken'] ?? '') . "\x01\x01";
            if (strtoupper($parts[0]) === 'XOAUTH2' && isset($box['oauthToken']) && base64_decode($response, true) === $expected) {
                fwrite($conn, "{$tag} OK authenticated\r\n");
            } else {
                fwrite($conn, '+ ' . base64_encode('{"status":"400","schemes":"Bearer","scope":"https://mail.google.com/"}') . "\r\n");
                fgets($conn);
                fwrite($conn, "{$tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n");
            }
            continue;
        }
        $out = '';
        switch ($command) {
            case 'CAPABILITY':
                $out = "* CAPABILITY {$box['capabilities']}\r\n";
                break;
            case 'SELECT':
            case 'EXAMINE':
                $modseq = $box['highestModseq'] === null ? '* OK [NOMODSEQ] no modseq' : "* OK [HIGHESTMODSEQ {$box['highestModseq']}] ok";
                $out = "* FLAGS (\\Seen \\Flagged \\Deleted)\r\n* " . ($box['exists'] ?? \count($box['uids'])) . " EXISTS\r\n"
                    . "* OK [UIDVALIDITY 7] ok\r\n* OK [UIDNEXT 10] ok\r\n{$modseq}\r\n";
                break;
            case 'SEARCH':
                $out = '* SEARCH ' . implode(' ', $box['uids']) . "\r\n";
                break;
            case 'FETCH':
                $since = preg_match('/CHANGEDSINCE (\d+)/i', $rest, $s) === 1 ? (int) $s[1] : null;
                foreach ($box['uids'] as $index => $uid) {
                    $modseq = $box['modseqs'][$uid] ?? 1;
                    if ($since !== null && $modseq <= $since) {
                        continue;
                    }
                    $flags = implode(' ', $box['flags'][$uid] ?? []);
                    $modseqPart = $box['highestModseq'] === null ? '' : " MODSEQ ({$modseq})";
                    $out .= '* ' . ($index + 1) . " FETCH (UID {$uid} FLAGS ({$flags}){$modseqPart})\r\n";
                }
                break;
            case 'LOGOUT':
                $out = "* BYE\r\n";
                break;
        }
        fwrite($conn, "{$out}{$tag} OK done\r\n");
        if ($command === 'LOGOUT') {
            break;
        }
    }
    fclose($conn);
}
