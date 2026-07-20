package dev.spectroscope.cli.trace;

import dev.spectroscope.core.provider.LlmProvider;

import java.util.Iterator;
import java.util.List;
import java.util.Locale;

/**
 * A decorator around any {@link LlmProvider} that mirrors the wire protocol onto
 * stderr: the full outgoing request before the call ({@code ⇢}), then every provider
 * event as it streams back ({@code ⇠}) — all in cyan, one direction per line.
 *
 * <p>This is the CLI-side wire view. The core stays free of console I/O, so the
 * decorator lives in spectro-cli and wraps the provider where the CLI builds it; the
 * agent loop never notices. Everything prints to {@code System.err}, so
 * {@code run --json | jq} pipelines keep a clean stdout. {@code --verbose} is an
 * explicit opt-in, hence color is unconditional (no TTY detection).</p>
 *
 * <p>The wrapper delegates everything and intercepts only the iterator; if the
 * delegated stream is {@link AutoCloseable}, closing the wrapper closes it.
 * Cancellation needs no forwarding — it rides inside the request's CancelSignal.
 * The traced types carry no API keys; keep it that way.</p>
 */
public final class TracingProvider implements LlmProvider {

    private static final String CYAN = "\u001B[36m";
    private static final String RESET = "\u001B[0m";

    private final LlmProvider delegate;
    private final String label;

    /**
     * Wraps {@code delegate} so every request and response event is echoed to stderr.
     *
     * @param delegate the real provider doing the work — behavior is untouched, only observed
     * @param label names the provider in the request header, e.g. {@code "ollama · qwen3"}.
     */
    public TracingProvider(LlmProvider delegate, String label) {
        this.delegate = delegate;
        this.label = label;
    }

    /**
     * Prints the full outgoing request first, then delegates and hands back a stream
     * whose iterator echoes every event the moment it passes through.
     *
     * @param request the assembled provider request (system, history, tools)
     * @return the delegate's stream, wrapped so consumption traces each event
     */
    @Override
    public Iterable<ProviderEvent> stream(ProviderRequest request) {
        printRequest(request);
        return new TracedStream(delegate.stream(request));
    }

    // ------------------------------------------------------------- ⇢ request

    /**
     * The {@code ⇢} side: one header line (label, message count, tool names), the
     * clipped system prompt, then one line per message content block.
     *
     * @param request the outgoing request to mirror onto stderr
     */
    private void printRequest(ProviderRequest request) {
        List<String> toolNames = request.tools() == null ? List.of()
                : request.tools().stream().map(ToolSpec::name).toList();
        StringBuilder out = new StringBuilder("⇢ request · ").append(label)
                .append(" · ").append(request.messages().size()).append(" messages")
                .append(" · tools: [").append(String.join(", ", toolNames)).append("]");
        if (request.system() != null && !request.system().isBlank()) {
            out.append("\n  system (").append(request.system().length()).append(" chars): ")
                    .append(clip(request.system(), 200));
        }
        for (ProviderMessage message : request.messages()) {
            String role = message.role().name().toLowerCase(Locale.ROOT);
            for (ProviderContent content : message.content()) {
                out.append("\n  [").append(role).append("] ").append(describe(content));
            }
        }
        trace(out.toString());
    }

    /**
     * One request content block as a single readable line — text and tool inputs
     * clipped, tool results and images reduced to their size and status.
     *
     * @param content the message block to summarize
     * @return the one-line summary, without direction marker (the caller indents it)
     */
    private static String describe(ProviderContent content) {
        return switch (content) {
            case TextContent text -> "text: " + clip(text.text(), 160);
            case ToolCallContent call ->
                    "tool_call " + call.name() + " " + clip(String.valueOf(call.input()), 160);
            case ToolResultContent result -> "tool_result " + result.callId()
                    + " (" + (result.isError() ? "error" : "ok")
                    + ", " + result.output().length() + " chars)";
            case ImageContent image ->
                    "image " + image.mediaType() + " (" + image.dataBase64().length() + " chars base64)";
            case LlmProvider.DocumentContent document -> "document " + document.name()
                    + " (" + document.mediaType() + ", "
                    + document.dataBase64().length() + " chars base64)";
        };
    }

    // ------------------------------------------------------------ ⇠ response

    /**
     * One streamed provider event as a single {@code ⇠} line — deltas clipped,
     * usage as token counts, the stop event with its reason.
     *
     * @param event the provider event passing through the traced iterator
     * @return the one-line summary, direction marker included
     */
    private static String describe(ProviderEvent event) {
        return switch (event) {
            case PTextDelta delta -> "⇠ text_delta \"" + clip(delta.text(), 120) + "\"";
            case PThinkingDelta t -> "⇠ thinking \"" + clip(t.text(), 120) + "\"";
            case PToolCall call ->
                    "⇠ tool_call " + call.name() + " " + clip(String.valueOf(call.input()), 160);
            case PUsage usage -> "⇠ usage " + usage.inputTokens() + " in / "
                    + usage.outputTokens() + " out";
            case PStop stop -> "⇠ stop " + stop.reason().name().toLowerCase(Locale.ROOT);
        };
    }

    /** Delegates everything; only the iterator is intercepted to echo passing events. */
    private static final class TracedStream implements Iterable<ProviderEvent>, AutoCloseable {

        private final Iterable<ProviderEvent> inner;

        /** @param inner the delegate provider's untraced event stream */
        private TracedStream(Iterable<ProviderEvent> inner) {
            this.inner = inner;
        }

        /**
         * The interception point: a pass-through iterator that echoes each event to
         * stderr as the agent loop consumes it — tracing follows real consumption order.
         *
         * @return the wrapping iterator; the inner stream is only advanced through it
         */
        @Override
        public Iterator<ProviderEvent> iterator() {
            Iterator<ProviderEvent> events = inner.iterator();
            return new Iterator<>() {
                /** Pure delegation — tracing never changes the stream's extent. */
                @Override
                public boolean hasNext() {
                    return events.hasNext();
                }

                /** Pulls the next event, echoes it, hands it on unchanged. */
                @Override
                public ProviderEvent next() {
                    ProviderEvent event = events.next();
                    trace(describe(event));
                    return event;
                }
            };
        }

        /** Forwards close to the inner stream when it is {@link AutoCloseable} — no leak through the wrapper. */
        @Override
        public void close() throws Exception {
            if (inner instanceof AutoCloseable closeable) {
                closeable.close();
            }
        }
    }

    // -------------------------------------------------------------- plumbing

    /**
     * Cyan, line by line, on stderr — stdout stays free for the actual output.
     *
     * @param block the possibly multi-line text to print; each line is colored separately
     */
    private static void trace(String block) {
        block.lines().forEach(line -> System.err.println(CYAN + line + RESET));
    }

    /**
     * Newlines become visible escapes, overlength is cut with an ellipsis.
     *
     * @param text the raw content to flatten for a one-line trace
     * @param max  the character budget before the ellipsis cut
     * @return the flattened, possibly shortened text — always a single line
     */
    private static String clip(String text, int max) {
        String flat = text.replace("\r", "\\r").replace("\n", "\\n");
        return flat.length() <= max ? flat : flat.substring(0, max) + "…";
    }
}
