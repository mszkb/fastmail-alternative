<?php

declare(strict_types=1);

namespace Fma\Migration;

use Fma\Crypto\CryptoException;
use Fma\Crypto\Envelope;
use Fma\Db\Database;

/**
 * After an import or restore: unwraps every account DEK and decrypts every
 * credential and message subject with the configured MASTER_KEY, so a
 * wrong key or a broken copy shows up at once. Counts only, no contents.
 */
final class ReadabilityCheck
{
    /** @return array{accounts: int, messages: int, unreadable: int} */
    public static function run(\PDO $mysql, #[\SensitiveParameter] string $masterKeyBase64): array
    {
        $masterKey = Envelope::loadMasterKey($masterKeyBase64);
        $accounts = 0;
        $messages = 0;
        $unreadable = 0;
        $rows = Database::run($mysql, 'SELECT id, wrapped_dek, credential_enc FROM mail_account')->fetchAll();
        foreach ($rows as $account) {
            /** @var array{id: string, wrapped_dek: string, credential_enc: string} $account */
            try {
                $dek = Envelope::unwrapDataKey($masterKey, $account['wrapped_dek'])['dataKey'];
                Envelope::decryptField($dek, $account['credential_enc'], Envelope::credentialAad($account['id']));
                ++$accounts;
            } catch (CryptoException) {
                ++$unreadable;
                continue;
            }
            $subjects = Database::run($mysql, 'SELECT id, subject_enc FROM message WHERE account_id = ?', [$account['id']]);
            while (($message = $subjects->fetch()) !== false) {
                /** @var array{id: string, subject_enc: string} $message */
                try {
                    Envelope::decryptField($dek, $message['subject_enc'], Envelope::messageFieldAad('subject', $message['id']));
                    ++$messages;
                } catch (CryptoException) {
                    ++$unreadable;
                }
            }
        }

        return ['accounts' => $accounts, 'messages' => $messages, 'unreadable' => $unreadable];
    }
}
