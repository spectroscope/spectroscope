package dev.spectroscope.core.provider;

import com.anthropic.errors.AnthropicIoException;
import com.anthropic.errors.AnthropicRetryableException;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.SocketTimeoutException;
import java.time.Duration;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The retry classifier is a pure function — proven directly over the exception
 * types it must recognise, with no client and no network. Terminal 4xx and
 * plain argument errors must NOT be retried; the SDK's transient types, our own
 * TransientProviderException, and bare IO failures must.
 */
class RetryPolicyTest {

    private static final RetryPolicy POLICY =
            new RetryPolicy(3, Duration.ZERO, Duration.ZERO, 0.0);

    @Test
    void ourTransientMarkerIsRetryable() {
        assertTrue(POLICY.isTransient(new TransientProviderException("Ollama HTTP 503")));
    }

    @Test
    void bareIoFailuresAreRetryable() {
        assertTrue(POLICY.isTransient(new IOException("connection reset")));
        assertTrue(POLICY.isTransient(new UncheckedIOException(new IOException("eof"))));
        assertTrue(POLICY.isTransient(new SocketTimeoutException("read timed out")));
    }

    @Test
    void anthropicTransientTypesAreRetryable() {
        assertTrue(POLICY.isTransient(new AnthropicIoException("io")));
        assertTrue(POLICY.isTransient(new AnthropicRetryableException("retry me")));
    }

    @Test
    void aTransientCauseWrappedInARuntimeExceptionIsRetryable() {
        assertTrue(POLICY.isTransient(new RuntimeException("wrapped", new IOException("io"))));
    }

    @Test
    void terminalErrorsAreNotRetryable() {
        assertFalse(POLICY.isTransient(new IllegalArgumentException("Unknown provider")));
        assertFalse(POLICY.isTransient(new RuntimeException("model does not support thinking")));
        assertFalse(POLICY.isTransient(null));
    }

    @Test
    void retryableStatusCodesMatchTheHttpTable() {
        for (int status : new int[] {408, 409, 425, 429, 500, 502, 503, 504}) {
            assertTrue(RetryPolicy.retryableStatus(status), "status " + status + " must retry");
        }
        for (int status : new int[] {400, 401, 403, 404, 422}) {
            assertFalse(RetryPolicy.retryableStatus(status), "status " + status + " must not retry");
        }
    }

    @Test
    void factoryDefaultsAreSaneAndClampNegatives() {
        assertTrue(RetryPolicy.from(2).maxRetries() == 2);
        assertTrue(RetryPolicy.from(-5).maxRetries() == 0, "a negative retry count clamps to 0");
        assertTrue(RetryPolicy.from(2).baseDelay().toMillis() > 0);
    }
}
