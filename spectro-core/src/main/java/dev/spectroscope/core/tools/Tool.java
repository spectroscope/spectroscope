package dev.spectroscope.core.tools;

import com.fasterxml.jackson.databind.JsonNode;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.events.RunEvent;

import java.nio.file.Path;
import java.util.function.Consumer;
import java.util.function.LongConsumer;

/** A registrable capability the agent can call. Never throws: failures return as a String prefixed "ERROR: ". */
public interface Tool {
    /** Unique wire name the model addresses the tool by. */
    String name();
    /** The model-facing manual — the only text the model has to decide when to call. */
    String description();
    /** JSON Schema of the input object, advertised to the provider verbatim. */
    JsonNode inputSchema();      // JSON Schema
    /** True when calls must pass the permission gate first — side effects on untrusted input. */
    boolean needsPermission();
    /**
     * Runs one call. Never throws — failures come back as a String prefixed
     * "ERROR: ", which the loop turns into a tool_result with isError = true.
     *
     * @param input   the model-supplied arguments matching {@link #inputSchema()} — untrusted
     * @param context per-call environment: sandbox root, cancel signal, ids and emit sink
     * @return the tool result fed back to the model on the next turn
     */
    String execute(JsonNode input, ToolContext context);

    /**
     * Whether a second call is how the model gets this kind of result again
     * (card 467). It promises neither the same answer nor a call without
     * effects: a file may have changed, a page may have moved on, and a
     * command runs again. A child agent's report, a person's answer or a
     * generated image is different, because a second call asks someone else
     * for new work, and false keeps such results whole.
     *
     * <p>The loop leaves an old, large result of a tool that answers true out
     * of the request as a one-line stub. What the stub says a second call does
     * comes from the tool's tier in {@code tool-tiers.json}, the map the
     * permission gate reads: a {@code read} tool is called again to read the
     * thing as it is now, and any other tool, an unrated MCP tool included, is
     * said to run again with its effects.</p>
     *
     * @return true unless a second call cannot stand in for the earlier result
     */
    default boolean resultRepeatable() {
        return true;
    }

    /**
     * Card 493: what a run read when it started that a tool may put into its
     * own description. The loop builds it once per run, so a description that
     * depends on it stays the same for every request of the run and the
     * provider's cached prefix stays valid.
     *
     * @param readSharePercent the run's read share in per cent, 0 or less for
     *                         the shipped one
     */
    record RunFacts(int readSharePercent) {
    }

    /**
     * Card 493: the description this tool carries in the requests of one run.
     * Every tool but {@code read_file} carries {@link #description()}.
     *
     * @param run what the run read when it started
     * @return the description
     */
    default String descriptionForRun(RunFacts run) {
        return description();
    }

    /**
     * What the loop hands a tool for one call. Grown additively in tools that
     * produce artifacts publish domain events through {@code emit} (the loop injects its
     * own event sink plus the ids of the call) — the two-arg constructor keeps every
     * earlier tool and test compiling unchanged.
     *
     * @param cwd        the sandbox root every path tool resolves against
     * @param signal     the run's cancel signal — long-running tools should honor it
     * @param agentId    the calling agent, stamped into emitted events
     * @param callId     the tool_call id, correlating emitted events with this call
     * @param emit       sink into the run's event stream for additive domain events
     * @param attach     sink for images/documents the model should SEE
     * @param waitReport sink for milliseconds spent PARKED ON A PERSON, which the
     *                   loop then subtracts from this call's {@code durationMs}
     *                   (card 265). A tool that never reports one is timed exactly
     *                   as before, so every existing tool's number is untouched.
     *
     *                   <p>Card 111 split the gate's two clocks because a slow
     *                   operator must never paint the tool as slow. A question
     *                   parks INSIDE {@code execute}, one layer below the gate, so
     *                   the loop cannot see that wait and cannot subtract it
     *                   unless the tool says so — hence a sink rather than a
     *                   return value, and hence the loop providing it. Generic on
     *                   purpose: any later tool that waits on a person gets
     *                   honest numbers for free.</p>
     * @param reachOutside card 453: true when the file tools may resolve a path
     *                   outside {@code cwd} for this call (the {@code extended}
     *                   permission mode). False keeps the working-directory fence.
     * @param contextWindow card 456: the window in tokens the loop hands the
     *                   tool for this turn, which bounds a whole-file read: the
     *                   window behind the compaction threshold (card 263), or
     *                   the threshold itself when no window is known. 0 or less
     *                   means nothing is known, and {@link ReadBudget} then
     *                   judges against the compaction fallback.
     * @param readSharePercent card 493: the share of that window, in per cent,
     *                   one whole-file read may take, as the run read it when it
     *                   started. 0 or less means the run names none, and the
     *                   shipped {@link ReadBudget#WINDOW_SHARE_PERCENT} applies.
     */
    record ToolContext(Path cwd, CancelSignal signal,
                       String agentId, String callId,          // from additive
                       Consumer<RunEvent> emit,                // from additive
                       Consumer<Attachment> attach,            // view_image/view_file, additive
                       Consumer<FileChange> report,            // card 269, additive
                       LongConsumer waitReport,                // human wait, additive (card 265)
                       boolean reachOutside,                   // extended mode, additive (card 453)
                       int contextWindow,                      // read bound, additive (card 456)
                       int readSharePercent) {                 // read share, additive (card 493)

        /**
         * The shape before card 493: the run names no read share, so a
         * whole-file read is judged at the shipped share,
         * {@link ReadBudget#WINDOW_SHARE_PERCENT}.
         *
         * @param cwd           the sandbox root every path tool resolves against
         * @param signal        the run's cancel signal
         * @param agentId       the calling agent
         * @param callId        the tool_call id
         * @param emit          sink into the run's event stream
         * @param attach        sink for images/documents the model should SEE
         * @param report        sink for what a mutating file tool did to its file
         * @param waitReport    sink for milliseconds spent parked on a person
         * @param reachOutside  true when the file tools may leave {@code cwd}
         * @param contextWindow the window in tokens that bounds a whole-file read
         */
        public ToolContext(Path cwd, CancelSignal signal, String agentId, String callId,
                           Consumer<RunEvent> emit, Consumer<Attachment> attach,
                           Consumer<FileChange> report, LongConsumer waitReport,
                           boolean reachOutside, int contextWindow) {
            this(cwd, signal, agentId, callId, emit, attach, report, waitReport, reachOutside,
                    contextWindow, 0);
        }

        /**
         * The shape before card 456: no window known, so a whole-file read is
         * judged against the compaction fallback.
         *
         * @param cwd          the sandbox root every path tool resolves against
         * @param signal       the run's cancel signal
         * @param agentId      the calling agent
         * @param callId       the tool_call id
         * @param emit         sink into the run's event stream
         * @param attach       sink for images/documents the model should SEE
         * @param report       sink for what a mutating file tool did to its file
         * @param waitReport   sink for milliseconds spent parked on a person
         * @param reachOutside true when the file tools may leave {@code cwd}
         */
        public ToolContext(Path cwd, CancelSignal signal, String agentId, String callId,
                           Consumer<RunEvent> emit, Consumer<Attachment> attach,
                           Consumer<FileChange> report, LongConsumer waitReport,
                           boolean reachOutside) {
            this(cwd, signal, agentId, callId, emit, attach, report, waitReport, reachOutside, 0);
        }

        /**
         * The shape before card 453: the working-directory fence stays closed.
         *
         * @param cwd        the sandbox root every path tool resolves against
         * @param signal     the run's cancel signal
         * @param agentId    the calling agent
         * @param callId     the tool_call id
         * @param emit       sink into the run's event stream
         * @param attach     sink for images/documents the model should SEE
         * @param report     sink for what a mutating file tool did to its file
         * @param waitReport sink for milliseconds spent parked on a person
         */
        public ToolContext(Path cwd, CancelSignal signal, String agentId, String callId,
                           Consumer<RunEvent> emit, Consumer<Attachment> attach,
                           Consumer<FileChange> report, LongConsumer waitReport) {
            this(cwd, signal, agentId, callId, emit, attach, report, waitReport, false);
        }

        /**
         * The pre-bonus-4 shape: agentId "main", no callId, a no-op emit sink.
         *
         * @param cwd    the sandbox root every path tool resolves against
         * @param signal the run's cancel signal
         */
        public ToolContext(Path cwd, CancelSignal signal) {
            this(cwd, signal, "main", null, event -> { });
        }

        /**
         * The bonus-4 shape (no image sink) — every earlier tool, test and the
         * subagent wiring keep compiling; attached images are dropped silently.
         *
         * @param cwd     the sandbox root every path tool resolves against
         * @param signal  the run's cancel signal
         * @param agentId the calling agent, stamped into emitted events
         * @param callId  the tool_call id, correlating emitted events with this call
         * @param emit    sink into the run's event stream for additive domain events
         */
        public ToolContext(Path cwd, CancelSignal signal,
                           String agentId, String callId, Consumer<RunEvent> emit) {
            this(cwd, signal, agentId, callId, emit, attachment -> { });
        }

        /**
         * The shape that predates BOTH sinks (card 269's change, card 265's human
         * wait) — every earlier tool and test keeps compiling, and a report it
         * can never make is a no-op in either direction.
         *
         * @param cwd     the sandbox root every path tool resolves against
         * @param signal  the run's cancel signal
         * @param agentId the calling agent, stamped into emitted events
         * @param callId  the tool_call id, correlating emitted events with this call
         * @param emit    sink into the run's event stream for additive domain events
         * @param attach  sink for images and documents the model should SEE
         */
        public ToolContext(Path cwd, CancelSignal signal, String agentId, String callId,
                           Consumer<RunEvent> emit, Consumer<Attachment> attach) {
            this(cwd, signal, agentId, callId, emit, attach, change -> { }, millis -> { });
        }
    }

    /**
     * What a mutating file tool DID, as one word the loop records on the
     * {@code tool_result} (card 269).
     *
     * <p>The measured need: a model in a loop wrote the same bytes 31 times and
     * asked, in its own words, whether anything had moved — then spent a whole
     * turn on a {@code read_file} to learn what the write already knew. The tool
     * result is the one channel every model reads on every turn, with no prompt
     * discipline required, which is why the answer belongs here rather than in a
     * watcher beside the run.
     *
     * <p>{@code null} — the absence of any of these — is a real and common
     * answer: it means the tool changed no file, or could not tell. Absence is
     * never a synonym for {@link #UNCHANGED}.
     */
    enum FileChange {
        /** The path did not exist before this call. */
        CREATED,
        /** The path existed and its bytes are now different. */
        CHANGED,
        /** The path existed and holds byte-for-byte what it already held. */
        UNCHANGED;

        /**
         * The lowercase word that travels on the wire and keys the UI.
         *
         * @return {@code created}, {@code changed} or {@code unchanged}
         */
        public String wireName() {
            return name().toLowerCase(java.util.Locale.ROOT);
        }
    }

    /**
     * Something a tool hands to the loop for the model to SEE — the loop
     * appends it to the tool-results user message as provider content. The
     * bytes live in provider history only: they never enter the JSONL, and a
     * resume cannot re-attach them.
     */
    sealed interface Attachment permits AttachedImage, AttachedDocument {}

    /**
     * An image for the model (view_image, bonus-1 vision path).
     *
     * @param mediaType  the IANA type (image/png, image/jpeg, image/webp, image/gif)
     * @param dataBase64 the raw bytes, base64 without any data: prefix
     */
    record AttachedImage(String mediaType, String dataBase64) implements Attachment {}

    /**
     * A document for the model (view_file, file_upload) — PDF today.
     *
     * @param mediaType  the IANA type, e.g. application/pdf
     * @param dataBase64 the raw bytes, base64 without any data: prefix
     * @param name       the file name, surfaced to providers that carry one
     */
    record AttachedDocument(String mediaType, String dataBase64, String name)
            implements Attachment {}
}
