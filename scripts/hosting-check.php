<?php
/*
 * Hosting check (#109) - one file, no dependencies.
 *
 * Upload this file into the webroot of your hosting package and open it in
 * the browser (https://your-domain/hosting-check.php). It checks whether
 * the package can run the PHP backend (PHP + MySQL/MariaDB + cron):
 * PHP version and extensions, crypto, limits, a folder outside the webroot,
 * outbound mail ports and - with the form - the database incl. SKIP LOCKED
 * and the rights the migrations need.
 *
 * Nothing is stored: the database password is only used for this one
 * request and never printed. The check stops working 60 minutes after its
 * first call; delete the file afterwards (button at the bottom).
 *
 * Deliberately written in old PHP syntax, so that a too old PHP version
 * shows a readable result instead of a blank page. Keep the checks in line
 * with apps/server-php/src/Install/SystemCheck.php and
 * docs/operations/installation-php.md.
 */

error_reporting(E_ALL);
ini_set('display_errors', '0');
header('Content-Type: text/html; charset=utf-8');
header('Cache-Control: no-store');
header('X-Robots-Tag: noindex, nofollow');
header('Referrer-Policy: no-referrer');
header("Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; form-action 'self'");

define('CHECK_LIFETIME', 3600);

function h($s)
{
    return htmlspecialchars((string) $s, ENT_QUOTES, 'UTF-8');
}

function bytes_from_ini($value)
{
    $value = trim((string) $value);
    if ($value === '' || $value === '-1') {
        return -1;
    }
    $unit = strtolower(substr($value, -1));
    $n = (float) $value;
    if ($unit === 'g') {
        $n *= 1024 * 1024 * 1024;
    } elseif ($unit === 'm') {
        $n *= 1024 * 1024;
    } elseif ($unit === 'k') {
        $n *= 1024;
    }
    return (int) $n;
}

function mb_text($bytes)
{
    return $bytes < 0 ? 'unbegrenzt' : round($bytes / 1048576) . ' MB';
}

// --- Self-protection: expires 60 minutes after the first call -------------

$marker = rtrim(sys_get_temp_dir(), '/\\') . '/fma-hosting-check-' . md5(__FILE__);
$started = @file_exists($marker) ? (int) @file_get_contents($marker) : 0;
if ($started === 0) {
    $started = time();
    if (@file_put_contents($marker, (string) $started) === false) {
        // No writable temp dir: fall back to the file's own time.
        $started = (int) @filemtime(__FILE__);
    }
}
$expired = time() - $started > CHECK_LIFETIME;

if ($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_POST['action']) && $_POST['action'] === 'delete') {
    $deleted = @unlink(__FILE__);
    @unlink($marker);
    echo '<!doctype html><meta name="viewport" content="width=device-width"><title>Hosting-Check</title><body style="font:16px system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 16px">';
    echo $deleted ? '<h1>Gelöscht</h1><p>Die Prüfdatei wurde vom Server entfernt.</p>' : '<h1>Nicht gelöscht</h1><p>PHP darf die Datei nicht löschen. Bitte per FTP entfernen.</p>';
    exit;
}

if ($expired) {
    http_response_code(410);
    echo '<!doctype html><meta name="viewport" content="width=device-width"><title>Hosting-Check</title><body style="font:16px system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 16px">';
    echo '<h1>Abgelaufen</h1><p>Diese Prüfdatei ist nur 60 Minuten nach dem ersten Aufruf nutzbar. Bitte die Datei per FTP löschen und für einen neuen Test neu hochladen.</p>';
    echo '<form method="post"><button name="action" value="delete">Datei jetzt löschen</button></form>';
    exit;
}

// --- Checks -----------------------------------------------------------------

$groups = array();
function add(&$groups, $group, $name, $status, $detail)
{
    // status: ok | warn | fail | info
    $groups[$group][] = array('name' => $name, 'status' => $status, 'detail' => $detail);
}

$G_PHP = 'PHP';
$G_SEC = 'Verschlüsselung';
$G_WEB = 'Webserver und Limits';
$G_FS = 'Dateien';
$G_NET = 'Verbindungen nach außen';
$G_DB = 'Datenbank';

// PHP
$phpOk = version_compare(PHP_VERSION, '8.2.0', '>=');
add($groups, $G_PHP, 'PHP-Version 8.2 oder neuer', $phpOk ? 'ok' : 'fail', 'gefunden: ' . PHP_VERSION . ($phpOk ? '' : ' - im Kundenmenü des Hosters meist umstellbar'));
add($groups, $G_PHP, '64-Bit-PHP', PHP_INT_SIZE >= 8 ? 'ok' : 'warn', PHP_INT_SIZE >= 8 ? '' : '32-Bit: große Postfächer und Dateien können Probleme machen');
foreach (array('openssl', 'pdo_mysql', 'mbstring', 'json', 'hash', 'iconv') as $ext) {
    add($groups, $G_PHP, 'Erweiterung ' . $ext, extension_loaded($ext) ? 'ok' : 'fail', extension_loaded($ext) ? '' : 'fehlt (Pflicht)');
}
foreach (array('intl' => 'bessere Zeichensatz-Behandlung', 'sodium' => 'Argon2id-Fallback', 'curl' => 'nicht zwingend') as $ext => $why) {
    add($groups, $G_PHP, 'Erweiterung ' . $ext . ' (optional)', extension_loaded($ext) ? 'ok' : 'warn', extension_loaded($ext) ? '' : 'fehlt - ' . $why);
}
$disabled = array_filter(array_map('trim', explode(',', (string) ini_get('disable_functions'))));
$needed = array('stream_socket_client' => true, 'stream_socket_enable_crypto' => true, 'stream_select' => false, 'set_time_limit' => false, 'ignore_user_abort' => false);
foreach ($needed as $fn => $required) {
    $ok = function_exists($fn) && !in_array($fn, $disabled, true);
    if (!$ok) {
        add($groups, $G_PHP, 'Funktion ' . $fn . '()', $required ? 'fail' : 'warn', 'vom Hoster gesperrt (disable_functions)');
    }
}
if (count(array_intersect(array_keys($needed), $disabled)) === 0) {
    add($groups, $G_PHP, 'Benötigte Netzwerk-Funktionen', 'ok', 'stream_socket_client, stream_socket_enable_crypto, stream_select');
}

// Crypto
$argon = defined('PASSWORD_ARGON2ID') && @password_hash('test', PASSWORD_ARGON2ID) !== false;
add($groups, $G_SEC, 'Passwort-Hashing Argon2id', $argon ? 'ok' : 'fail', $argon ? '' : 'PHP ohne libargon2/sodium gebaut');
$gcm = false;
if (function_exists('openssl_encrypt')) {
    $key = function_exists('random_bytes') ? random_bytes(32) : openssl_random_pseudo_bytes(32);
    $iv = substr($key, 0, 12);
    $tag = '';
    $enc = @openssl_encrypt('hosting-check', 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $iv, $tag);
    $gcm = $enc !== false && @openssl_decrypt($enc, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $iv, $tag) === 'hosting-check';
}
add($groups, $G_SEC, 'AES-256-GCM (Mails at rest)', $gcm ? 'ok' : 'fail', $gcm ? '' : 'OpenSSL kann AES-GCM nicht');
add($groups, $G_SEC, 'HKDF', function_exists('hash_hkdf') ? 'ok' : 'fail', '');
$ec = false;
if (function_exists('openssl_pkey_new')) {
    $k = @openssl_pkey_new(array('curve_name' => 'prime256v1', 'private_key_type' => OPENSSL_KEYTYPE_EC));
    $ec = $k !== false;
}
add($groups, $G_SEC, 'EC-Schlüssel P-256 (Web Push)', $ec ? 'ok' : 'warn', $ec ? '' : 'Push-Benachrichtigungen gehen nicht; Mail funktioniert trotzdem');

// Web server and limits
$https = (!empty($_SERVER['HTTPS']) && strtolower((string) $_SERVER['HTTPS']) !== 'off')
    || (isset($_SERVER['HTTP_X_FORWARDED_PROTO']) && strtolower((string) $_SERVER['HTTP_X_FORWARDED_PROTO']) === 'https')
    || (isset($_SERVER['SERVER_PORT']) && (string) $_SERVER['SERVER_PORT'] === '443');
add($groups, $G_WEB, 'Aufruf über HTTPS', $https ? 'ok' : 'fail', $https ? '' : 'App-Installation, Service Worker und Push brauchen HTTPS (z. B. kostenloses Let\'s-Encrypt-Zertifikat im Kundenmenü)');
$software = isset($_SERVER['SERVER_SOFTWARE']) ? (string) $_SERVER['SERVER_SOFTWARE'] : '';
$isApache = stripos($software, 'apache') !== false || stripos($software, 'litespeed') !== false;
if (function_exists('apache_get_modules')) {
    $mods = apache_get_modules();
    $rw = in_array('mod_rewrite', $mods, true);
    $hd = in_array('mod_headers', $mods, true);
    add($groups, $G_WEB, 'Apache mit mod_rewrite und mod_headers', $rw && $hd ? 'ok' : 'fail', ($rw ? '' : 'mod_rewrite fehlt ') . ($hd ? '' : 'mod_headers fehlt'));
} elseif ($isApache) {
    add($groups, $G_WEB, 'Apache/LiteSpeed mit .htaccess', 'warn', 'Webserver: ' . ($software !== '' ? $software : 'unbekannt') . '. Ob .htaccess und mod_rewrite erlaubt sind, lässt sich von hier nicht prüfen - meist ja; der Installer merkt es spätestens.');
} else {
    add($groups, $G_WEB, 'Apache mit .htaccess', 'warn', 'Webserver: ' . ($software !== '' ? $software : 'unbekannt') . '. Die App liefert ihre Regeln als .htaccess; bei nginx muss der Hoster sie übernehmen.');
}
$met = (int) ini_get('max_execution_time');
add($groups, $G_WEB, 'Laufzeit je Anfrage', $met === 0 || $met >= 30 ? 'ok' : 'warn', ($met === 0 ? 'unbegrenzt' : $met . ' s') . ($met !== 0 && $met < 30 ? ' - die Suche braucht bis zu 30 s' : ''));
$mem = bytes_from_ini(ini_get('memory_limit'));
add($groups, $G_WEB, 'Arbeitsspeicher (memory_limit)', $mem < 0 || $mem >= 128 * 1048576 ? 'ok' : 'warn', mb_text($mem) . ($mem >= 0 && $mem < 128 * 1048576 ? ' - empfohlen 128 MB' : ''));
$up = bytes_from_ini(ini_get('upload_max_filesize'));
$post = bytes_from_ini(ini_get('post_max_size'));
$upOk = ($up < 0 || $up >= 10 * 1048576) && ($post <= 0 || $post >= 15 * 1048576);
add($groups, $G_WEB, 'Anhänge hochladen', $upOk ? 'ok' : 'warn', 'Datei bis ' . mb_text($up) . ', Anfrage bis ' . mb_text($post) . ($upOk ? '' : ' - für 10-MB-Anhänge sollten es 10 MB / 15 MB sein'));

// Files: the app lives next to the webroot, never inside
$parent = dirname(__DIR__);
$basedir = (string) ini_get('open_basedir');
$probeDir = $parent . '/fma-hosting-check-' . substr(md5(uniqid('', true)), 0, 8);
$parentOk = false;
if (@mkdir($probeDir, 0700)) {
    $parentOk = @file_put_contents($probeDir . '/x', 'x') === 1;
    @unlink($probeDir . '/x');
    @rmdir($probeDir);
}
add($groups, $G_FS, 'Ordner neben dem Webroot beschreibbar', $parentOk ? 'ok' : 'warn',
    $parentOk ? 'App und verschlüsselte Mails können außerhalb des Webroots liegen'
    : 'In ' . $parent . ' darf PHP nichts anlegen' . ($basedir !== '' ? ' (open_basedir: ' . $basedir . ')' : '') . '. Dann einen anderen Ordner außerhalb des Webroots wählen; liegt keiner frei, im Kundenmenü einen anlegen.');
$free = @disk_free_space($parent);
if ($free !== false) {
    add($groups, $G_FS, 'Freier Speicher', $free >= 1024 * 1048576 ? 'ok' : 'warn', round($free / 1073741824, 1) . ' GB frei (Hoster-Quota kann kleiner sein). Der Server speichert alle Mails, plane die Größe deiner Postfächer ein.');
}

// Outbound connections (fixed hosts only)
function probe($host, $port, $tls, $expect)
{
    $ctx = stream_context_create(array('ssl' => array('verify_peer' => true, 'verify_peer_name' => true, 'SNI_enabled' => true, 'peer_name' => $host)));
    $t = microtime(true);
    $s = @stream_socket_client(($tls ? 'ssl' : 'tcp') . '://' . $host . ':' . $port, $errno, $errstr, 6, STREAM_CLIENT_CONNECT, $ctx);
    if ($s === false) {
        return array(false, $tls && $errno === 0 ? 'TLS-Prüfung fehlgeschlagen (CA-Zertifikate des Hosters?)' : 'keine Verbindung (Port gesperrt?)');
    }
    stream_set_timeout($s, 6);
    $line = $expect !== '' ? (string) fgets($s, 512) : '';
    fclose($s);
    $ms = (int) round((microtime(true) - $t) * 1000);
    if ($expect !== '' && strpos($line, $expect) !== 0) {
        return array(false, 'verbunden, aber unerwartete Antwort');
    }
    return array(true, $ms . ' ms' . ($tls ? ', Zertifikat geprüft' : ''));
}
$probes = array(
    array('IMAP 993 (TLS) - imap.gmail.com', 'imap.gmail.com', 993, true, '* OK', 'fail'),
    array('SMTP 465 (TLS) - smtp.gmail.com', 'smtp.gmail.com', 465, true, '220', 'warn'),
    array('SMTP 587 (STARTTLS) - smtp.gmail.com', 'smtp.gmail.com', 587, false, '220', 'warn'),
    array('IMAP 993 (TLS) - outlook.office365.com', 'outlook.office365.com', 993, true, '* OK', 'warn'),
    array('HTTPS 443 - Web Push (fcm.googleapis.com)', 'fcm.googleapis.com', 443, true, '', 'warn'),
);
foreach ($probes as $p) {
    $r = probe($p[1], $p[2], $p[3], $p[4]);
    add($groups, $G_NET, $p[0], $r[0] ? 'ok' : $p[5], $r[1]);
}
$smtpAny = false;
foreach ($groups[$G_NET] as $row) {
    if (strpos($row['name'], 'SMTP') === 0 && $row['status'] === 'ok') {
        $smtpAny = true;
    }
}
if (!$smtpAny) {
    add($groups, $G_NET, 'Senden', 'fail', 'Weder Port 465 noch 587 erreichbar - Mails verschicken wäre nicht möglich. Beim Hoster nach ausgehendem SMTP fragen.');
}

// Own IMAP server (optional, host name only, port 993)
$ownHost = isset($_POST['imap_host']) ? trim((string) $_POST['imap_host']) : '';
if ($ownHost !== '') {
    if (preg_match('/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i', $ownHost) !== 1 || strlen($ownHost) > 253) {
        add($groups, $G_NET, 'Dein IMAP-Server', 'fail', 'ungültiger Hostname');
    } else {
        $r = probe($ownHost, 993, true, '* OK');
        add($groups, $G_NET, 'IMAP 993 (TLS) - ' . $ownHost, $r[0] ? 'ok' : 'fail', $r[1]);
    }
}

// Database (only with the form)
$dbTested = false;
$db = array(
    'host' => isset($_POST['db_host']) ? trim((string) $_POST['db_host']) : 'localhost',
    'port' => isset($_POST['db_port']) ? trim((string) $_POST['db_port']) : '3306',
    'name' => isset($_POST['db_name']) ? trim((string) $_POST['db_name']) : '',
    'user' => isset($_POST['db_user']) ? trim((string) $_POST['db_user']) : '',
);
if ($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_POST['action']) && $_POST['action'] === 'check' && $db['name'] !== '' && $db['user'] !== '') {
    $dbTested = true;
    $pass = isset($_POST['db_pass']) ? (string) $_POST['db_pass'] : '';
    if (!extension_loaded('pdo_mysql')) {
        add($groups, $G_DB, 'Verbindung', 'fail', 'pdo_mysql fehlt');
    } else {
        $pdo = null;
        try {
            $dsn = 'mysql:host=' . $db['host'] . ';port=' . (int) $db['port'] . ';dbname=' . $db['name'] . ';charset=utf8mb4';
            $pdo = new PDO($dsn, $db['user'], $pass, array(PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_TIMEOUT => 6));
            add($groups, $G_DB, 'Verbindung', 'ok', 'angemeldet');
        } catch (Exception $e) {
            // No message: it may echo host or user names.
            add($groups, $G_DB, 'Verbindung', 'fail', 'Anmeldung fehlgeschlagen - Host, Datenbankname, Benutzer und Passwort im Kundenmenü prüfen (Host ist oft nicht "localhost")');
        }
        unset($pass);
        if ($pdo !== null) {
            $version = (string) $pdo->query('SELECT VERSION()')->fetchColumn();
            $isMaria = stripos($version, 'mariadb') !== false;
            $number = preg_replace('/^(\d+\.\d+\.\d+).*$/', '$1', $version);
            $vOk = $isMaria ? version_compare($number, '10.6.0', '>=') : version_compare($number, '8.0.1', '>=');
            add($groups, $G_DB, 'Version (MariaDB 10.6+ / MySQL 8.0.1+)', $vOk ? 'ok' : 'fail', ($isMaria ? 'MariaDB ' : 'MySQL ') . $number);

            $table = 'fma_check_' . substr(md5(uniqid('', true)), 0, 8);
            $steps = array(
                'Tabelle anlegen (InnoDB, utf8mb4)' => "CREATE TABLE `$table` (id INT NOT NULL PRIMARY KEY, v VARCHAR(20) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
                'Spalte und Index ändern (ALTER, INDEX)' => "ALTER TABLE `$table` ADD COLUMN at DATETIME(6) NULL, ADD INDEX idx_at (at)",
                'Schreiben und lesen' => "INSERT INTO `$table` (id, v) VALUES (1, 'a'), (2, 'b')",
            );
            $created = false;
            try {
                foreach ($steps as $label => $sql) {
                    try {
                        $pdo->exec($sql);
                        add($groups, $G_DB, $label, 'ok', '');
                        if (strpos($sql, 'CREATE TABLE') === 0) {
                            $created = true;
                        }
                    } catch (Exception $e) {
                        add($groups, $G_DB, $label, 'fail', 'Rechte fehlen - der Datenbankbenutzer braucht CREATE, ALTER, INDEX, DROP, INSERT, UPDATE, DELETE, SELECT');
                        break;
                    }
                }
                if ($created) {
                    try {
                        $pdo->beginTransaction();
                        $rows = $pdo->query("SELECT id FROM `$table` ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED")->fetchAll();
                        $pdo->commit();
                        add($groups, $G_DB, 'SELECT … FOR UPDATE SKIP LOCKED (Job-Warteschlange)', count($rows) === 1 ? 'ok' : 'fail', '');
                    } catch (Exception $e) {
                        if ($pdo->inTransaction()) {
                            $pdo->rollBack();
                        }
                        add($groups, $G_DB, 'SELECT … FOR UPDATE SKIP LOCKED (Job-Warteschlange)', 'fail', 'nicht unterstützt - Datenbankversion zu alt');
                    }
                }
            } finally {
                if ($created) {
                    try {
                        $pdo->exec("DROP TABLE `$table`");
                        add($groups, $G_DB, 'Testtabelle wieder löschen (DROP)', 'ok', '');
                    } catch (Exception $e) {
                        add($groups, $G_DB, 'Testtabelle wieder löschen (DROP)', 'fail', 'DROP nicht erlaubt - Tabelle ' . $table . ' bitte im Kundenmenü (phpMyAdmin) löschen');
                    }
                }
            }
        }
    }
}

// Cron hint
add($groups, $G_WEB, 'Cronjob jede Minute', 'info', 'Von hier nicht prüfbar. Im Kundenmenü nach „Cronjobs“ oder „Geplante Aufgaben“ suchen. Geht nur seltener als jede Minute, kommen neue Mails entsprechend später. Ohne Cron-Menü geht ein externer Web-Cron-Dienst.');

// --- Verdict ----------------------------------------------------------------

$fails = 0;
$warns = 0;
foreach ($groups as $rows) {
    foreach ($rows as $row) {
        if ($row['status'] === 'fail') {
            $fails++;
        } elseif ($row['status'] === 'warn') {
            $warns++;
        }
    }
}
if ($fails > 0) {
    $verdict = array('fail', 'Funktioniert so nicht', $fails . ($fails === 1 ? ' Pflichtpunkt fehlt' : ' Pflichtpunkte fehlen') . '. Die roten Zeilen unten sagen, was zu tun ist.');
} elseif (!$dbTested) {
    $verdict = array('warn', 'Sieht gut aus, Datenbank noch offen', 'PHP und Verbindungen passen' . ($warns > 0 ? ' (mit ' . $warns . ' Hinweisen)' : '') . '. Trag unten die Datenbank-Zugangsdaten ein, dann ist der Test vollständig.');
} elseif ($warns > 0) {
    $verdict = array('ok', 'Sollte funktionieren', 'Alle Pflichtpunkte erfüllt. ' . $warns . ($warns === 1 ? ' Hinweis' : ' Hinweise') . ' unten beachten.');
} else {
    $verdict = array('ok', 'Sollte funktionieren', 'Alle Punkte erfüllt.');
}
$labels = array('ok' => 'OK', 'warn' => 'Hinweis', 'fail' => 'Fehlt', 'info' => 'Info');
$minutesLeft = max(1, (int) ceil((CHECK_LIFETIME - (time() - $started)) / 60));
?><!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Hosting-Check</title>
<style>
:root { --bg:#f4f6f5; --card:#fff; --ink:#15201d; --soft:#4b5a55; --line:#cfd8d4; --ok:#2f6b4f; --warn:#7a5a12; --fail:#b8322a; --info:#2f5f8f; }
@media (prefers-color-scheme: dark) { :root { --bg:#101614; --card:#161e1b; --ink:#e5ece9; --soft:#a3b3ad; --line:#2c3a35; --ok:#7fd1a8; --warn:#e9c36a; --fail:#ff6a5c; --info:#8cb8e6; color-scheme: dark; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
main { max-width:52rem; margin:0 auto; padding:32px 16px 64px; display:grid; gap:24px; }
h1 { margin:0; font-size:1.6rem; letter-spacing:-0.02em; }
h2 { margin:0 0 8px; font-size:1.05rem; }
p { margin:0; }
.sub { color:var(--soft); }
.verdict { padding:18px 20px; border-radius:12px; border:2px solid; background:var(--card); display:grid; gap:4px; }
.verdict.ok { border-color:var(--ok); } .verdict.warn { border-color:var(--warn); } .verdict.fail { border-color:var(--fail); }
.verdict b { font-size:1.2rem; }
section { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px 18px; }
table { width:100%; border-collapse:collapse; }
td { padding:8px 0; border-top:1px solid var(--line); vertical-align:top; }
tr:first-child td { border-top:0; }
td.s { width:5.5rem; padding-right:10px; }
.tag { display:inline-block; font:700 11px/1 ui-monospace,Menlo,Consolas,monospace; text-transform:uppercase; letter-spacing:.05em; padding:4px 6px; border-radius:4px; border:1px solid currentColor; }
.tag.ok { color:var(--ok); } .tag.warn { color:var(--warn); } .tag.fail { color:var(--fail); } .tag.info { color:var(--info); }
.d { color:var(--soft); font-size:.92em; display:block; overflow-wrap:anywhere; }
form { display:grid; gap:12px; }
.grid { display:grid; grid-template-columns:repeat(2, minmax(0,1fr)); gap:12px; }
label { display:grid; gap:4px; font-weight:600; font-size:.92rem; }
input { font:inherit; padding:9px 10px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--ink); min-width:0; }
button { font:inherit; font-weight:650; padding:10px 16px; border-radius:8px; border:1px solid var(--ink); background:var(--ink); color:var(--bg); cursor:pointer; justify-self:start; }
button.danger { background:transparent; color:var(--fail); border-color:var(--fail); }
.note { font-size:.88rem; color:var(--soft); }
@media (max-width:560px) { .grid { grid-template-columns:minmax(0,1fr); } td.s { width:4.8rem; } }
</style>
</head>
<body>
<main>
  <header>
    <h1>Hosting-Check</h1>
    <p class="sub">Prüft, ob dieses Webhosting den fastmail-alternative-Server (PHP-Backend) betreiben kann. Läuft noch etwa <?php echo $minutesLeft; ?> Minuten, danach Datei löschen.</p>
  </header>

  <div class="verdict <?php echo h($verdict[0]); ?>" role="status">
    <b><?php echo h($verdict[1]); ?></b>
    <p><?php echo h($verdict[2]); ?></p>
  </div>

  <section>
    <h2>Datenbank und eigener Mailserver testen</h2>
    <form method="post" autocomplete="off">
      <div class="grid">
        <label for="db_host">Datenbank-Host<input id="db_host" name="db_host" value="<?php echo h($db['host']); ?>"></label>
        <label for="db_port">Port<input id="db_port" name="db_port" inputmode="numeric" value="<?php echo h($db['port']); ?>"></label>
        <label for="db_name">Datenbankname<input id="db_name" name="db_name" value="<?php echo h($db['name']); ?>" required></label>
        <label for="db_user">Benutzer<input id="db_user" name="db_user" value="<?php echo h($db['user']); ?>" required></label>
        <label for="db_pass">Passwort<input id="db_pass" name="db_pass" type="password"></label>
        <label for="imap_host">Dein IMAP-Server (optional)<input id="imap_host" name="imap_host" placeholder="z. B. imap.example.org" value="<?php echo h($ownHost); ?>"></label>
      </div>
      <button name="action" value="check">Prüfen</button>
      <p class="note">Das Passwort wird nur für diese eine Prüfung benutzt und nirgends gespeichert oder angezeigt. Der Test legt eine Tabelle <code>fma_check_…</code> an und löscht sie sofort wieder. Nimm am besten die leere Datenbank, die du für die Installation angelegt hast.</p>
    </form>
  </section>

<?php foreach ($groups as $title => $rows): ?>
  <section>
    <h2><?php echo h($title); ?></h2>
    <table>
<?php foreach ($rows as $row): ?>
      <tr><td class="s"><span class="tag <?php echo h($row['status']); ?>"><?php echo h($labels[$row['status']]); ?></span></td><td><?php echo h($row['name']); ?><?php if ($row['detail'] !== ''): ?><span class="d"><?php echo h($row['detail']); ?></span><?php endif; ?></td></tr>
<?php endforeach; ?>
    </table>
  </section>
<?php endforeach; ?>

  <section>
    <h2>Aufräumen</h2>
    <form method="post">
      <p class="note">Die Datei verrät Details über deinen Server. Lösche sie, sobald du fertig bist.</p>
      <button class="danger" name="action" value="delete">Diese Prüfdatei vom Server löschen</button>
    </form>
  </section>
</main>
</body>
</html>
