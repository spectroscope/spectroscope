package dev.spectroscope.core.provider;

import dev.spectroscope.core.config.governing.Governs;

import java.net.http.HttpClient;
import java.time.Duration;

/**
 * The deadline the HTTP model providers dial with (card 557, criterion 8).
 * One number for the OpenAI-compatible provider (LM Studio, llama.cpp,
 * spectro-local and the cloud endpoints), Ollama and Anthropic.
 */
final class ProviderTimeouts {

    /**
     * How long a model provider waits for the connection to its backend to be
     * set up. It covers the TCP connect, and for the OpenAI-compatible and
     * Ollama providers the TLS handshake too, because the JDK client counts
     * that as part of the connect. It never limits how long a connected stream
     * may take to answer. The owner set it on 2026-10-12. Without it, a host
     * that drops packets, such as a backend behind a VPN that is down, holds
     * every attempt until the operating system gives up, which took 75 s on
     * macOS (one connect to a black-holed address, measured 2026-10-12). The
     * stop button ends such a wait at once; this is the bound for a run that
     * nobody stops.
     */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.MILLISECONDS)
    static final long CONNECT_TIMEOUT_MS = 10_000;

    private ProviderTimeouts() {
    }

    /** @return the connect timeout as a duration */
    static Duration connect() {
        return Duration.ofMillis(CONNECT_TIMEOUT_MS);
    }

    /**
     * A JDK HTTP client for a chat stream: the connect timeout set, and no
     * other deadline, because a stream may take as long as the model needs.
     *
     * @return the client for Spring's JDK request factory
     */
    static HttpClient chatClient() {
        return HttpClient.newBuilder().connectTimeout(connect()).build();
    }
}
