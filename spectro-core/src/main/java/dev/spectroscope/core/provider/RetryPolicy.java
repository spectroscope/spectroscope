package dev.spectroscope.core.provider;

import com.anthropic.errors.AnthropicIoException;
import com.anthropic.errors.AnthropicRetryableException;
import com.anthropic.errors.AnthropicServiceException;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.time.Duration;

/**
 * The pure backoff parameters plus the single transient-vs-terminal classifier.
 * No I/O — unit-tested directly. {@code maxRetries <= 0} means "no retry" and
 * turns {@link RetryingProvider#wrap} into a pass-through.
 *
 * @param maxRetries how many re-attempts follow the first try; 0 or less disables retry
 * @param baseDelay  the first backoff delay, doubled per attempt
 * @param cap        the ceiling the exponential delay never exceeds
 * @param jitter     the random fraction (0..1) added on top of the capped delay
 */
public record RetryPolicy(int maxRetries, Duration baseDelay, Duration cap, double jitter) {

    /**
     * Build-time default curve: base 250 ms, capped at 8 s, 20% jitter.
     *
     * @param maxRetries the configured retry count; negative values clamp to 0
     * @return the policy carrying the house backoff curve
     */
    public static RetryPolicy from(int maxRetries) {
        return new RetryPolicy(Math.max(0, maxRetries),
                Duration.ofMillis(250), Duration.ofSeconds(8), 0.2);
    }

    /**
     * Retryable HTTP statuses: request timeout, conflict, too-early, rate limit, any 5xx.
     *
     * @param status the HTTP status code to classify
     * @return true when a fresh attempt has a realistic chance of succeeding
     */
    public static boolean retryableStatus(int status) {
        return status == 408 || status == 409 || status == 425 || status == 429 || status >= 500;
    }

    /**
     * True for a failure worth another attempt: our own marker, the SDK's transient
     * types, a retryable service status, or a bare IO failure (also when wrapped one
     * cause level deep, e.g. a RuntimeException around an IOException).
     *
     * @param error the failure to classify (null counts as terminal)
     * @return true when a retry is worth another attempt
     */
    public boolean isTransient(Throwable error) {
        if (error == null) {
            return false;
        }
        if (error instanceof TransientProviderException
                || error instanceof AnthropicIoException
                || error instanceof AnthropicRetryableException
                || error instanceof UncheckedIOException
                || error instanceof IOException) {
            return true;
        }
        if (error instanceof AnthropicServiceException service) {
            return retryableStatus(service.statusCode());
        }
        Throwable cause = error.getCause();
        return cause != null && cause != error && isTransient(cause);
    }
}
