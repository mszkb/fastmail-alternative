<?php

declare(strict_types=1);

// Fake push service for tests/Integration/PushTest.php (php -S router):
// records the request and answers with the status from the path (/status/<code>).
$dir = getenv('FAKE_PUSH_DIR') ?: sys_get_temp_dir();
$headers = function_exists('getallheaders') ? getallheaders() : [];
file_put_contents($dir . '/request.json', json_encode([
    'method' => $_SERVER['REQUEST_METHOD'] ?? '',
    'uri' => $_SERVER['REQUEST_URI'] ?? '',
    'headers' => array_change_key_case($headers, CASE_LOWER),
    'body' => base64_encode((string) file_get_contents('php://input')),
]));
$status = preg_match('#/status/(\d{3})#', $_SERVER['REQUEST_URI'] ?? '', $m) === 1 ? (int) $m[1] : 201;
http_response_code($status);
if ($status === 302) {
    header('Location: http://127.0.0.1:1/elsewhere');
}
