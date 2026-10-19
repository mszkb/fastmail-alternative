<?php

declare(strict_types=1);

namespace Fma\Mail;

/** The raw mail does not fit into PHP's memory_limit (RawStorage::readStream()). */
final class RawTooLargeException extends \RuntimeException {}
