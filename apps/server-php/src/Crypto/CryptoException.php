<?php

declare(strict_types=1);

namespace Fma\Crypto;

/** Encryption/decryption failure. Messages never contain keys, plaintext or AAD. */
class CryptoException extends \RuntimeException {}
