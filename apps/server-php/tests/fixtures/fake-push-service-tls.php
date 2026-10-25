<?php

declare(strict_types=1);

// Fake push service over TLS for tests/Integration/PushTest.php.
// Usage: php fake-push-service-tls.php <cert+key.pem> <request.json>
// Listens on a random port of 127.0.0.1 and prints "PORT <n>" once ready.
// Records the last request like fake-push-service.php and answers with the
// status from the path (/status/<code>, default 201). Failed handshakes
// (a client that does not trust the certificate) are skipped. Serves at most
// 100 connections, plenty for one test.

[, $pemFile, $requestFile] = $argv;
$context = stream_context_create(['ssl' => ['local_cert' => $pemFile]]);
$server = stream_socket_server('tls://127.0.0.1:0', $errno, $errstr, STREAM_SERVER_BIND | STREAM_SERVER_LISTEN, $context);
if ($server === false) {
    fwrite(STDERR, "listen failed: {$errstr}\n");
    exit(1);
}
$name = (string) stream_socket_get_name($server, false);
echo 'PORT ' . substr($name, strrpos($name, ':') + 1) . "\n";

for ($served = 0; $served < 100; ++$served) {
    $conn = @stream_socket_accept($server, -1);
    if ($conn === false) {
        continue;
    }
    stream_set_timeout($conn, 5);
    $head = '';
    while (!str_contains($head, "\r\n\r\n") && ($line = fgets($conn)) !== false) {
        $head .= $line;
    }
    [$requestLine] = explode("\r\n", $head, 2);
    $headers = [];
    foreach (\array_slice(explode("\r\n", trim($head)), 1) as $header) {
        [$key, $value] = array_map('trim', explode(':', $header, 2)) + [1 => ''];
        $headers[strtolower($key)] = $value;
    }
    $length = (int) ($headers['content-length'] ?? 0);
    $body = '';
    while (\strlen($body) < $length && !feof($conn)) {
        $body .= (string) fread($conn, max(1, $length - \strlen($body)));
    }
    [$method, $uri] = explode(' ', $requestLine) + [1 => ''];
    file_put_contents($requestFile, json_encode([
        'method' => $method,
        'uri' => $uri,
        'headers' => $headers,
        'body' => base64_encode($body),
    ]));
    $status = preg_match('#/status/(\d{3})#', $uri, $m) === 1 ? (int) $m[1] : 201;
    fwrite($conn, "HTTP/1.1 {$status} Fake\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    fclose($conn);
}
