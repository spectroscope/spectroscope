package dev.spectroscope.core.tools;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.config.governing.Governs;
import dev.spectroscope.core.net.NetFence;
import dev.spectroscope.core.tools.Tool.ToolContext;
import dev.spectroscope.core.web.HtmlText;


/**
 * The {@code web_fetch} tool: a URL in, the page's readable text out. Network
 * egress is a side effect on untrusted (model-supplied) input, so it is
 * permission-gated exactly like run_command. The HTTP call goes through an
 * injected {@link HttpFetcher} seam (a RestClient impl in production, a fake in
 * tests). HTML is reduced to text by the shared hand-rolled {@link HtmlText}
 * strip — no jsoup, so the core gains no new dependency.
 *
 * <p>Card 199 put a {@link NetFence} in front of the fetch. The URL is model
 * output, and the model reads whatever page it was last shown, so file URLs,
 * RFC-1918, the 100.64/10 tailnet and (without an explicit opt-in) loopback are
 * refused before a request leaves. The refusal names the address and the rule
 * and carries nothing else — not the path, not the query string, not the
 * userinfo, any of which a model-assembled URL may carry a token in.
 *
 * <p><b>Every hop, not just the first.</b> The first build asked the fence once
 * and let the transport do the walking, and {@code HttpURLConnection} follows
 * same-protocol redirects by itself: measured on 2026-08-13, a loopback page
 * answering {@code 302} carried the agent onto the LAN and onto the tailnet and
 * returned both secrets. So the chain is walked HERE — the fetcher follows
 * nothing, {@link #MAX_REDIRECTS} bounds the walk, and every address in it is
 * put to the fence before a request is made. What is left, and cannot be closed
 * from this side, is a name that resolves one way for the fence and another way
 * for the connection; the fence and the connector share the platform resolver,
 * so that takes a DNS answer that changes between two lookups.
 */
public final class WebFetchTool implements Tool {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** The shared tool-output clamp, read from {@link ToolOutput} rather than
     *  kept as a second copy of the same number. */
    @Governs(kind = Governs.Kind.ALIAS, unit = Governs.Unit.CHARACTERS)
    private static final int MAX_OUTPUT_CHARS = ToolOutput.MAX_OUTPUT_CHARS;

    /** How many redirects one call may take before it gives up. Every one of
     *  them is fenced, so the budget is about loops and latency, not safety. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.COUNT)
    public static final int MAX_REDIRECTS = 5;

    private final HttpFetcher fetcher;
    private final java.util.function.Supplier<NetFence> fence;

    /**
     * Builds the tool over the injected network seam, fenced at the default:
     * loopback and the private ranges refused.
     *
     * @param fetcher {@link DefaultHttpFetcher} in production, an in-memory fake in tests
     */
    public WebFetchTool(HttpFetcher fetcher) {
        this(fetcher, NetFence.withSystemDns(false));
    }

    /**
     * The fully wired tool over a fixed fence — the shape every test wants.
     *
     * @param fetcher {@link DefaultHttpFetcher} in production, an in-memory fake in tests
     * @param fence   where this tool may go — built from {@code allowLocalhost} in the settings
     */
    public WebFetchTool(HttpFetcher fetcher, NetFence fence) {
        this(fetcher, () -> fence);
    }

    /**
     * The wiring a long-lived session needs: the fence is asked PER CALL.
     *
     * <p>Card 222. A registry is built once per session and the settings under
     * it are not frozen — an operator can grant {@code allowLocalhost} while the
     * session is open, and before this constructor existed the grant reached
     * nothing until they started a new chat. The comment at the call site
     * claimed otherwise, which is the part that cost a day.</p>
     *
     * @param fetcher {@link DefaultHttpFetcher} in production, an in-memory fake in tests
     * @param fence   yields the fence to apply to THIS call
     */
    public WebFetchTool(HttpFetcher fetcher, java.util.function.Supplier<NetFence> fence) {
        this.fetcher = fetcher;
        this.fence = fence;
    }

    /** Wire name: {@code web_fetch}. */
    @Override
    public String name() {
        return "web_fetch";
    }

    /** The model-facing one-liner — announces the HTML strip, the truncation and the permission gate. */
    @Override
    public String description() {
        return "Fetches a web page over http/https and returns its readable text "
                + "(HTML stripped, truncated). Network egress — guarded by permission.";
    }

    /** One required string: {@code url}. */
    @Override
    public JsonNode inputSchema() {
        ObjectNode schema = JSON.createObjectNode();
        schema.put("type", "object");
        ObjectNode properties = JSON.createObjectNode();
        properties.set("url", JSON.createObjectNode().put("type", "string"));
        schema.set("properties", properties);
        schema.set("required", JSON.createArrayNode().add("url"));
        return schema;
    }

    /** Untrusted input reaching the network — the human stays in the loop. */
    @Override
    public boolean needsPermission() {
        return true;
    }

    /** Fences and fetches hop by hop, then reduces the page to clipped readable text — every failure path is an "ERROR: " string. */
    @Override
    public String execute(JsonNode input, ToolContext context) {
        String url = input.path("url").asText().strip();
        if (url.isBlank()) {
            return "ERROR: web_fetch needs a non-empty url.";
        }

        // The whole downstream sits in one guard (the GenerateImageTool pattern):
        // a throwing seam AND a null-returning seam both surface as an ERROR string.
        try {
            // ONE fence for the whole redirect chain of ONE call: asked here, so
            // a mid-session settings change reaches the next call, and not
            // re-asked per hop, so a chain cannot be judged by two different
            // rules halfway through.
            NetFence callFence = fence.get();
            String hop = url;
            for (int taken = 0; ; taken++) {
                NetFence.Refusal refusal = callFence.refuse(hop);
                if (refusal != null) {
                    return "ERROR: web_fetch " + refusal.sentence();
                }
                HttpFetcher.Fetched fetched = fetcher.fetch(hop);
                if (fetched == null) {
                    return "ERROR: web_fetch failed: the fetcher answered nothing.";
                }
                String next = redirectFrom(hop, fetched);
                if (next == null) {
                    if (fetched.status() < 200 || fetched.status() >= 300) {
                        // Named by the URL the MODEL asked for, never by the one a
                        // server sent us to: a Location may carry a token, and this
                        // sentence goes back into the transcript.
                        return "ERROR: web_fetch got HTTP " + fetched.status() + " for "
                                + url + ".";
                    }
                    String text = HtmlText.strip(fetched.body() == null ? "" : fetched.body());
                    text = ToolOutput.clip(text, MAX_OUTPUT_CHARS);
                    return text.isBlank() ? "(no readable text)" : text;
                }
                if (taken >= MAX_REDIRECTS) {
                    return "ERROR: web_fetch gave up after " + MAX_REDIRECTS + " redirects.";
                }
                hop = next;
            }
        } catch (RuntimeException failure) {
            return "ERROR: web_fetch failed: " + failure.getMessage();
        }
    }

    /**
     * Where this response sends us next, resolved against the hop it came from.
     *
     * @param from    the URL this response was fetched from — the base a relative
     *                {@code Location} is resolved against
     * @param fetched the response
     * @return the absolute next URL, or null when this response ends the chain
     *         (not a redirect, or a redirect with no readable Location — a 3xx
     *         nobody can follow is reported as the HTTP status it is)
     */
    private static String redirectFrom(String from, HttpFetcher.Fetched fetched) {
        int status = fetched.status();
        if (status != 301 && status != 302 && status != 303 && status != 307 && status != 308) {
            return null;
        }
        String location = fetched.location();
        if (location == null || location.isBlank()) {
            return null;
        }
        try {
            return new java.net.URI(from).resolve(location.strip()).toString();
        } catch (java.net.URISyntaxException | IllegalArgumentException unreadable) {
            // The server's own header, so it does not go into the sentence.
            throw new IllegalStateException("the server sent a redirect this tool cannot read");
        }
    }
}
