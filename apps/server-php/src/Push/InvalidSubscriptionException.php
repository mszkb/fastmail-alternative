<?php

declare(strict_types=1);

namespace Fma\Push;

/** A rejected PushSubscription; the message is the German API error text. */
final class InvalidSubscriptionException extends \RuntimeException {}
