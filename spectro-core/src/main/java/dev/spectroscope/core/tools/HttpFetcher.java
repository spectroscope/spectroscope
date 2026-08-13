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
     * ONE hop — the single point where web_fetch touches the network, and it is
     * one request, never a chain. A fetcher that followed redirects itself would
     * carry the agent to an address {@link dev.spectroscope.core.net.NetFence}
     * never saw: the fence judges the URL, the transport walks somewhere else,
     * and the private world is one {@code 302} away. So a redirect comes back
     * here as DATA — status plus {@link Fetched#location} — and
     * {@link WebFetchTool} decides whether to take it, after asking the fence.
     * Transport failures may throw RuntimeExceptions; the tool maps both those
     * and non-2xx statuses onto "ERROR: " strings.
     *
     * @param url an absolute http/https URL — the tool has already fenced this hop
     * @return the response reduced to status, content type, body and Location
     */
    Fetched fetch(String url);

    /** One HTTP response, reduced to what web_fetch needs.
     *
     *  @param status      the HTTP status code, uninterpreted — the tool decides what counts as an error
     *  @param contentType the Content-Type header, or "" when absent
     *  @param body        the body text, possibly capped by the fetcher; may be empty
     *  @param location    the {@code Location} header of a redirect, exactly as the server
     *                     sent it (absolute or relative), or null when there was none */
    record Fetched(int status, String contentType, String body, String location) {

        /** A response that redirects nowhere — the shape every non-3xx answer has.
         *
         *  @param status      the HTTP status code
         *  @param contentType the Content-Type header, or "" when absent
         *  @param body        the body text */
        public Fetched(int status, String contentType, String body) {
            this(status, contentType, body, null);
        }
    }
}
