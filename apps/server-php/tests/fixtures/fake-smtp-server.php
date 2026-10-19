<?php

declare(strict_types=1);

// Scripted SMTP server for tests/Integration/SendMessageTest.php (GreenMail
// accepts any login). Usage: php fake-smtp-server.php <mode>
// Listens on a random port of 127.0.0.1 and prints "PORT <n>" once ready.
// Modes: "auth" answers AUTH with 535, "rejected" answers RCPT with 550,
// "temporary" answers RCPT with 451; everything else is accepted.

[, $mode] = $argv;
$server = stream_socket_server('tcp://127.0.0.1:0', $errno, $errstr);
if ($server === false) {
    fwrite(STDERR, "listen failed: {$errstr}\n");
    exit(1);
}
echo 'PORT ' . parse_url('tcp://' . stream_socket_get_name($server, false), PHP_URL_PORT) . "\n";
fflush(STDOUT);

while (($conn = @stream_socket_accept($server, -1)) !== false) {
    fwrite($conn, "220 fake ready\r\n");
    while (($line = fgets($conn)) !== false) {
        $command = strtoupper(explode(' ', rtrim($line, "\r\n"))[0]);
        if ($command === 'EHLO') {
            fwrite($conn, "250-fake\r\n250 AUTH PLAIN\r\n");
        } elseif ($command === 'AUTH') {
            fwrite($conn, $mode === 'auth' ? "535 5.7.8 bad credentials\r\n" : "235 ok\r\n");
        } elseif ($command === 'RCPT') {
            fwrite($conn, match ($mode) {
                'rejected' => "550 5.1.1 no such user\r\n",
                'temporary' => "451 4.3.0 try later\r\n",
                default => "250 ok\r\n",
            });
        } elseif ($command === 'DATA') {
            fwrite($conn, "354 go\r\n");
            while (($data = fgets($conn)) !== false && rtrim($data, "\r\n") !== '.') {
            }
            fwrite($conn, "250 queued\r\n");
        } elseif ($command === 'QUIT') {
            fwrite($conn, "221 bye\r\n");
            break;
        } else {
            fwrite($conn, "250 ok\r\n");
        }
    }
    fclose($conn);
}
