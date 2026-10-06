<?php

declare(strict_types=1);

namespace Fma\Crypto;

/** A backup cannot be decrypted (wrong key, corrupt or truncated). */
final class BackupDecryptException extends CryptoException {}
