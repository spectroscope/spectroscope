package dev.spectroscope.core.provider;

/**
 * A retryable provider failure, thrown at the SOURCE by the HTTP-based providers
 * (Ollama / OpenAI-compatible) where the status code is still in scope — so
 * classification happens on a typed exception instead of string-parsing an
 * "Ollama HTTP 503" message later. Extends {@link RuntimeException} so an
 * exhausted-retry failure still becomes a normal {@code error} event through the
 * Agent's existing {@code catch (RuntimeException)}.
 */
public final class TransientProviderException extends RuntimeException {

    /**
     * A transient failure without an underlying cause, e.g. a retryable HTTP status.
     *
     * @param message human-readable failure text including the status
     */
    public TransientProviderException(String message) {
        super(message);
    }

    /**
     * A transient failure wrapping the original error.
     *
     * @param message human-readable failure text
     * @param cause   the underlying failure, kept for the cause-chain classifier
     */
    public TransientProviderException(String message, Throwable cause) {
        super(message, cause);
    }
}
