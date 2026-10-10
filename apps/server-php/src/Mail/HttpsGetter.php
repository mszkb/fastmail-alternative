<?php

declare(strict_types=1);

namespace Fma\Mail;

/** Small HTTPS GET for public discovery documents (autoconfig, #165); tests inject a fake. */
interface HttpsGetter
{
    /**
     * The body of a 200 response, or null (any error, other status, too
     * large, timeout). Never throws for network problems.
     */
    public function get(string $url, float $timeoutSeconds): ?string;
}
