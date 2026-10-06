<?php

declare(strict_types=1);

namespace Fma\Mail;

use Fma\Config;

/**
 * Validation rules and limits shared by the outbox, draft and upload routes,
 * ported from packages/shared (compose.ts, drafts.ts, attachments.ts, mail.ts).
 */
final class Compose
{
    public const UUID_RE = '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i';
    private const ADDRESS_RE = '/^[^\s@<>()[\]",;:\\\\]+@[^\s@<>()[\]",;:\\\\]+\.[^\s@<>()[\]",;:\\\\]+$/u';
    private const MESSAGE_ID_RE = '/^<[^\s<>@]+@[^\s<>@]+>$/';
    public const MAX_MESSAGE_ID_LENGTH = 250;

    /** OUTBOX_LIMITS */
    public const MAX_RECIPIENTS = 100;
    public const MAX_SUBJECT_LENGTH = 998;
    public const MAX_TEXT_LENGTH = 500_000;
    public const MAX_REFERENCES = 100;
    public const MAX_NAME_LENGTH = 200;
    /** DRAFT_LIMITS.maxAddressFieldLength */
    public const MAX_ADDRESS_FIELD_LENGTH = 20_000;

    /** ATTACHMENT_LIMIT_DEFAULTS */
    public const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
    public const DEFAULT_MAX_TOTAL_BYTES = 14 * 1024 * 1024;
    public const MAX_ATTACHMENT_COUNT = 20;

    public const ATTACHMENT_MISSING = 'ATTACHMENT_MISSING';
    public const ATTACHMENT_MISSING_MESSAGE = 'Ein Anhang ist nicht mehr vorhanden (abgelaufen oder entfernt). Bitte erneut hinzufügen.';

    /** OUTBOX_ERROR_MESSAGES */
    public const OUTBOX_ERROR_MESSAGES = [
        'AUTH_FAILED' => 'Der SMTP-Server hat die Zugangsdaten abgelehnt.',
        'SMTP_REJECTED' => 'Der SMTP-Server hat die Nachricht abgelehnt (z. B. Empfänger unbekannt).',
        'SMTP_TEMPORARY' => 'Der SMTP-Server ist vorübergehend nicht bereit. Neuer Versuch folgt.',
        'HOST_NOT_FOUND' => 'SMTP-Server nicht gefunden - bitte Hostnamen prüfen.',
        'BLOCKED_HOST' => 'Interner SMTP-Host ist blockiert (SSRF-Schutz).',
        'BLOCKED_PORT' => 'Dieser SMTP-Port ist nicht erlaubt (25, 465, 587, 2525) – Port im Konto ändern.',
        'CONNECTION_REFUSED' => 'Verbindung zum SMTP-Server abgelehnt - Host/Port prüfen.',
        'TIMEOUT' => 'Zeitüberschreitung beim Verbinden mit dem SMTP-Server.',
        'TLS_ERROR' => 'TLS-Fehler - Zertifikat des SMTP-Servers konnte nicht verifiziert werden.',
        'TLS_REQUIRED' => 'Der SMTP-Server bietet keine verschlüsselte Verbindung (STARTTLS) an - das Passwort wurde nicht gesendet. Port 465 verwenden oder Anbieter prüfen.',
        'ATTACHMENT_MISSING' => 'Ein Anhang ist nicht mehr vorhanden - bitte die Nachricht neu schreiben und den Anhang erneut hinzufügen.',
        'UNKNOWN' => 'Versand fehlgeschlagen.',
    ];

    public static function isUuid(mixed $value): bool
    {
        return \is_string($value) && preg_match(self::UUID_RE, $value) === 1;
    }

    public static function isValidEmailAddress(string $address): bool
    {
        return mb_strlen($address, 'UTF-8') <= 320 && preg_match(self::ADDRESS_RE, $address) === 1;
    }

    public static function isValidMessageId(mixed $value): bool
    {
        return \is_string($value) && \strlen($value) <= self::MAX_MESSAGE_ID_LENGTH && preg_match(self::MESSAGE_ID_RE, $value) === 1;
    }

    /** Length in UTF-16 code units, like JavaScript's String.length. */
    public static function jsLength(string $value): int
    {
        $utf16 = mb_convert_encoding($value, 'UTF-16LE', 'UTF-8');

        return intdiv(\strlen($utf16), 2);
    }

    /** @return array{maxFileBytes: int, maxTotalBytes: int} */
    public static function attachmentLimits(Config $config): array
    {
        return [
            'maxFileBytes' => $config->int('MAX_ATTACHMENT_BYTES', self::DEFAULT_MAX_FILE_BYTES),
            'maxTotalBytes' => $config->int('MAX_ATTACHMENTS_TOTAL_BYTES', self::DEFAULT_MAX_TOTAL_BYTES),
        ];
    }

    /** Human-readable size (German format), e.g. "1,4 MB". */
    public static function formatByteSize(int $bytes): string
    {
        if ($bytes < 1024) {
            return "{$bytes} B";
        }
        $units = ['KB', 'MB', 'GB'];
        $value = $bytes / 1024;
        $unit = 0;
        while ($value >= 1024 && $unit < \count($units) - 1) {
            $value /= 1024;
            ++$unit;
        }
        // JavaScript's Math.round / toFixed(1) round half up.
        $text = $value >= 10 ? (string) (int) floor($value + 0.5) : str_replace('.', ',', number_format($value, 1, '.', ''));

        return "{$text} {$units[$unit]}";
    }

    /** Removes line breaks (header injection) and trims. */
    public static function singleLine(string $value): string
    {
        return trim((string) preg_replace('/[\r\n]+/', ' ', $value));
    }

    /**
     * Recipients as editable text: `Name <a@b.c>, "Doe, John" <j@d.e>`.
     *
     * @param list<array{name: string, address: string}> $people
     */
    public static function formatAddressList(array $people): string
    {
        return implode(', ', array_map(static function (array $person): string {
            if ($person['name'] === '') {
                return $person['address'];
            }
            $name = preg_match('/[",;<>@()[\]:\\\\]/', $person['name']) === 1
                ? '"' . preg_replace('/(["\\\\])/', '\\\\$1', $person['name']) . '"'
                : $person['name'];

            return "{$name} <{$person['address']}>";
        }, $people));
    }

    /**
     * Valid people of a typed recipient field (invalid entries are dropped).
     *
     * @return list<array{name: string, address: string}>
     */
    public static function parseAddressList(string $input): array
    {
        $people = [];
        foreach (self::splitAddressList($input) as $entry) {
            $name = '';
            $address = $entry;
            if (preg_match('/^(.*?)\s*<([^<>]*)>$/su', $entry, $m) === 1) {
                $name = trim($m[1]);
                $address = trim($m[2]);
                if (\strlen($name) >= 2 && str_starts_with($name, '"') && str_ends_with($name, '"')) {
                    $name = (string) preg_replace('/\\\\(.)/su', '$1', substr($name, 1, -1));
                }
            }
            if (self::isValidEmailAddress($address)) {
                $people[] = ['name' => $name, 'address' => $address];
            }
        }

        return $people;
    }

    /** @return list<string> */
    private static function splitAddressList(string $input): array
    {
        $parts = [];
        $current = '';
        $quoted = false;
        $angle = false;
        $chars = mb_str_split($input, 1, 'UTF-8');
        $count = \count($chars);
        for ($i = 0; $i < $count; ++$i) {
            $char = $chars[$i];
            if ($quoted && $char === '\\' && $i + 1 < $count) {
                $current .= $char . $chars[$i + 1];
                ++$i;
                continue;
            }
            if ($char === '"') {
                $quoted = !$quoted;
            } elseif (!$quoted && $char === '<') {
                $angle = true;
            } elseif (!$quoted && $char === '>') {
                $angle = false;
            }
            if (!$quoted && !$angle && ($char === ',' || $char === ';')) {
                $parts[] = $current;
                $current = '';
                continue;
            }
            $current .= $char;
        }
        $parts[] = $current;

        return array_values(array_filter(array_map('trim', $parts), static fn(string $part): bool => $part !== ''));
    }
}
