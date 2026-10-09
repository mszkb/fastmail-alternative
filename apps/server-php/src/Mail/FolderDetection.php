<?php

declare(strict_types=1);

namespace Fma\Mail;

/**
 * Detected folder roles, port of detectFolderRoles/roleFromName in
 * packages/shared/src/folders.ts: INBOX, else the RFC 6154 SPECIAL-USE
 * attribute, else a German/English name heuristic - but only for roles no
 * folder announces via SPECIAL-USE. Resolution with manual overrides:
 * FolderRoles.
 */
final class FolderDetection
{
    private const ROLES = ['sent', 'drafts', 'trash', 'archive', 'junk'];
    private const NAMES = [
        'sent' => ['sent', 'sent items', 'sent mail', 'sent messages', 'gesendet', 'gesendete objekte', 'gesendete elemente', 'gesendete nachrichten'],
        'drafts' => ['drafts', 'draft', 'entwürfe', 'entwurf'],
        'trash' => ['trash', 'deleted', 'deleted items', 'deleted messages', 'bin', 'papierkorb', 'gelöschte elemente', 'gelöschte objekte', 'gelöschte nachrichten'],
        'archive' => ['archive', 'archives', 'archiv'],
        'junk' => ['junk', 'spam', 'junk e-mail', 'junk-e-mail', 'junk email', 'junk mail', 'bulk mail'],
    ];

    /**
     * @param list<array{path: string, delimiter: ?string, specialUse: ?string}> $folders
     *
     * @return array<string, ?string> role per path
     */
    public static function detect(array $folders): array
    {
        $byAttribute = [];
        $announced = [];
        foreach ($folders as $folder) {
            $role = strtoupper($folder['path']) === 'INBOX' ? 'inbox' : self::attributeRole($folder['specialUse']);
            $byAttribute[$folder['path']] = $role;
            if ($role !== null) {
                $announced[$role] = true;
            }
        }
        $result = [];
        foreach ($folders as $folder) {
            $role = $byAttribute[$folder['path']];
            if ($role === null) {
                $guessed = self::roleFromName($folder['path'], $folder['delimiter']);
                $role = $guessed !== null && !isset($announced[$guessed]) ? $guessed : null;
            }
            $result[$folder['path']] = $role;
        }

        return $result;
    }

    public static function roleFromName(string $path, ?string $delimiter): ?string
    {
        $index = $delimiter !== null && $delimiter !== '' ? strrpos($path, $delimiter) : false;
        $name = $index !== false ? substr($path, $index + \strlen((string) $delimiter)) : $path;
        if (class_exists(\Normalizer::class)) {
            $name = \Normalizer::normalize($name, \Normalizer::FORM_C) ?: $name;
        }
        $name = mb_strtolower(trim($name), 'UTF-8');
        foreach (self::NAMES as $role => $names) {
            if (\in_array($name, $names, true)) {
                return $role;
            }
        }

        return null;
    }

    private static function attributeRole(?string $attribute): ?string
    {
        if ($attribute === null || !str_starts_with($attribute, '\\')) {
            return null;
        }
        $value = strtolower(substr($attribute, 1));
        if ($value === 'inbox') {
            return 'inbox';
        }
        // Gmail's "All Mail" (\All): holds every message once more; only
        // detected, never assigned manually (global search skips it, #121).
        if ($value === 'all') {
            return 'all';
        }

        return \in_array($value, self::ROLES, true) ? $value : null;
    }
}
