package dev.spectroscope.core.tools;

/**
 * The network seam for {@link WebFetchTool} — the port-style analog of
 * image/ImageProvider. Production wiring supplies a RestClient-backed
 * {@code DefaultHttpFetcher}; tests inject an in-memory fake, so the tool is
 * key-free AND network-free. Functional (one method): a lambda can implement it.
 */
@FunctionalInterface
public interface HttpFetcher {

    /**
     * One blocking GET — the single point where web_fetch touches the network.
     * Transport failures may throw RuntimeExceptions; the tool maps both those
     * and non-2xx statuses onto "ERROR: " strings.
     *
     * @param url an absolute http/https URL — the tool has already vetted the scheme
     * @return the response reduced to status, content type and body
     */
    Fetched fetch(String url);

    /** One HTTP response, reduced to what web_fetch needs.
     *
     *  @param status      the HTTP status code, uninterpreted — the tool decides what counts as an error
     *  @param contentType the Content-Type header, or "" when absent
     *  @param body        the body text, possibly capped by the fetcher; may be empty */
    record Fetched(int status, String contentType, String body) {}
}
