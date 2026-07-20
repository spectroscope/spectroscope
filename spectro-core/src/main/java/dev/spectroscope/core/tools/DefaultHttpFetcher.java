package dev.spectroscope.core.tools;

import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.web.client.RestClient;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;

/**
 * The production {@link HttpFetcher}: a spring-web {@link RestClient} with finite
 * connect/read timeouts (the same request-factory pattern the MCP HTTP transport
 * uses), so a stalled server cannot pin a thread. The body is read as a STREAM
 * and capped at {@link #MAX_BODY_BYTES} — {@code toEntity(String)} would buffer
 * a multi-hundred-MB page in full before the tool throws away everything past
 * 10k chars. 4xx/5xx never throw — {@link WebFetchTool} inspects the status
 * itself. RestClient is already on the core classpath (the Ollama provider uses
 * it), so no new dependency.
 */
public final class DefaultHttpFetcher implements HttpFetcher {

    private static final Duration TIMEOUT = Duration.ofSeconds(15);

    /** Plenty of raw HTML to yield the tool's 10k-char text; a hard ceiling on memory. */
    static final int MAX_BODY_BYTES = 512 * 1024;

    private final RestClient http;

    /** Wires the RestClient with the finite connect/read timeouts. */
    public DefaultHttpFetcher() {
        var factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout((int) TIMEOUT.toMillis());
        factory.setReadTimeout((int) TIMEOUT.toMillis());
        this.http = RestClient.builder().requestFactory(factory).build();
    }

    /** One streamed GET, reduced to status/content-type/capped body — error statuses return as data, transport failures throw for the tool to catch. */
    @Override
    public Fetched fetch(String url) {
        return http.get()
                .uri(url)
                .exchange((request, response) -> {
                    String contentType = response.getHeaders().getContentType() != null
                            ? response.getHeaders().getContentType().toString() : "";
                    String body = readCapped(response.getBody());
                    return new Fetched(response.getStatusCode().value(), contentType, body);
                }, false);
    }

    /**
     * Reads at most {@link #MAX_BODY_BYTES} and drops the rest of the stream.
     *
     * @param in the response body stream — closed here in every case
     * @return the capped body, decoded as UTF-8
     */
    private static String readCapped(InputStream in) {
        try (in) {
            return new String(in.readNBytes(MAX_BODY_BYTES), StandardCharsets.UTF_8);
        } catch (IOException error) {
            throw new UncheckedIOException(error); // WebFetchTool turns this into ERROR: ...
        }
    }
}
