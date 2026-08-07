package dev.spectroscope.core.wire;

import java.util.Map;

/**
 * The seam a provider records its REAL exchange through: what was posted to the
 * model backend and what came back, verbatim. The session JSONL is the app's own
 * protocol; this tap feeds the second file — the backend-to-LLM record
 * (card 184). A provider that gets no tap records nothing and behaves
 * byte-identically to before.
 *
 * <p>Fidelity is part of the record, never implied, and each label is a
 * separately MEASURED promise: {@code "bytes"} — the recorded string IS what
 * went over the socket (our own HTTP providers post the exact string they hand
 * the tap); {@code "sdk-json"} — the SDK owned the socket and the recorded
 * request body is byte-equal to what it posts (loopback-proven);
 * {@code "sdk-events"} — the stream reconstructed from the SDK's typed events,
 * content-equal per event, field order not guaranteed, keep-alives absent;
 * {@code "encoded"} — the recording's own base64 of real input bytes that
 * never rode a socket as a string (the stt audio).</p>
 */
public interface LlmWireTap {

    /**
     * Announces one outgoing request. The recorder persists it immediately —
     * a crash mid-stream must still leave the request on record.
     *
     * @param request the outgoing call, body verbatim
     * @return the handle the provider feeds the response into
     */
    Exchange begin(WireRequest request);

    /** One open request awaiting its response. */
    interface Exchange {

        /**
         * One received stream line, exactly as read off the connection
         * (SSE {@code data:} payloads, keep-alives, NDJSON lines). On an
         * aborted exchange the record holds the lines CONSUMED before the
         * teardown; bytes the server had sent but nothing had read are
         * deliberately dropped — draining them would resurrect the slow-cancel
         * bug (card 78).
         *
         * @param rawLine the line verbatim, without the trailing newline
         */
        void line(String rawLine);

        /**
         * Closes the exchange — normal end, HTTP error, or abort. Buffered
         * stream lines and the outcome become the {@code llm_response} record.
         *
         * @param outcome status, single-body payload (non-streaming responses),
         *                abort flag and error text
         */
        void end(WireOutcome outcome);
    }

    /**
     * One outgoing model call. What the call is FOR ({@code chat},
     * {@code compaction}, {@code image}, {@code stt}) is the call site's
     * knowledge, not the provider's — it rides on the recorder binding.
     *
     * @param provider  the backend label as the session knows it (e.g. "anthropic")
     * @param model     the model id the request names
     * @param transport who owns the socket: {@code http} (our own client) or
     *                  {@code sdk} (a vendor SDK)
     * @param method    the HTTP method, "POST" throughout today
     * @param url       the full request URL
     * @param headers   the request headers as set — the recorder redacts
     *                  credential VALUES, names stay
     * @param fidelity  {@code bytes} when the body string is what went over the
     *                  socket, {@code sdk-json} when it is the SDK's serialization
     * @param body      the request body, verbatim
     * @param ts        epoch millis at send time
     */
    record WireRequest(String provider, String model, String transport,
                       String method, String url, Map<String, String> headers,
                       String fidelity, String body, long ts) {}

    /**
     * The closing half of an exchange.
     *
     * @param status   the HTTP status, or null when the connection never answered
     * @param fidelity {@code bytes} for lines read off our own connection,
     *                 {@code sdk-events} for SDK-reconstructed stream lines
     * @param body     a single-body response (image generation, error details);
     *                 null for line-streamed responses
     * @param aborted  true when a cancel tore the stream down mid-generation
     * @param error    the failure in one line, null on a clean close
     * @param ts       epoch millis at close time — durations are computed from
     *                 the request's own stamp
     */
    record WireOutcome(Integer status, String fidelity, String body,
                       boolean aborted, String error, long ts) {}
}
