<?php

declare(strict_types=1);

namespace Fma\Mail;

use Fma\Db\Database;

/**
 * Folder roles per account (roadmap 3.3), port of the resolution part of
 * packages/shared/src/folders.ts: a manual override always wins; every
 * role is assigned to at most one folder per account and every folder has
 * at most one role.
 */
final class FolderRoles
{
    /** Roles a user may assign manually (INBOX is fixed by IMAP). */
    public const ROLES = ['sent', 'drafts', 'trash', 'archive', 'junk'];

    public static function isRole(mixed $value): bool
    {
        return \is_string($value) && \in_array($value, self::ROLES, true);
    }

    /**
     * Effective role per path: overrides first, then detected roles for the
     * remaining roles and folders.
     *
     * @param list<array{path: string, detected: ?string, override: ?string}> $folders
     *
     * @return array<string, ?string> path => role
     */
    public static function resolve(array $folders): array
    {
        $result = [];
        foreach ($folders as $folder) {
            $result[$folder['path']] = null;
        }
        $taken = [];
        $sorted = $folders;
        // Prefer top-level/shorter paths, then alphabetical (byte order, deterministic).
        usort($sorted, static fn(array $a, array $b): int => (mb_strlen($a['path']) <=> mb_strlen($b['path'])) ?: strcmp($a['path'], $b['path']));

        foreach ($sorted as $folder) {
            if (strtoupper($folder['path']) === 'INBOX') {
                $result[$folder['path']] = 'inbox';
                $taken['inbox'] = true;
                break;
            }
        }
        foreach ($sorted as $folder) {
            $override = $folder['override'];
            if ($result[$folder['path']] !== null || !self::isRole($override) || isset($taken[$override])) {
                continue;
            }
            $result[$folder['path']] = $override;
            $taken[$override] = true;
        }
        foreach ($sorted as $folder) {
            $detected = $folder['detected'];
            if ($result[$folder['path']] !== null || self::isRole($folder['override'])) {
                continue;
            }
            if ((!self::isRole($detected) && $detected !== 'all') || isset($taken[$detected])) {
                continue;
            }
            $result[$folder['path']] = $detected;
            $taken[$detected] = true;
        }

        return $result;
    }

    /** Recomputes folder.special_use of one account from detected roles + overrides. */
    public static function apply(\PDO $pdo, string $accountId): void
    {
        /** @var list<array{id: string, path: string, special_use: ?string, special_use_detected: ?string, special_use_override: ?string}> $rows */
        $rows = Database::run(
            $pdo,
            'SELECT id, path, special_use, special_use_detected, special_use_override FROM folder WHERE account_id = ?',
            [$accountId],
        )->fetchAll();
        $roles = self::resolve(array_map(
            static fn(array $row): array => ['path' => $row['path'], 'detected' => $row['special_use_detected'], 'override' => $row['special_use_override']],
            $rows,
        ));
        foreach ($rows as $row) {
            $role = $roles[$row['path']] ?? null;
            if ($role !== $row['special_use']) {
                Database::run($pdo, 'UPDATE folder SET special_use = ? WHERE id = ?', [$role, $row['id']]);
            }
        }
    }
}
