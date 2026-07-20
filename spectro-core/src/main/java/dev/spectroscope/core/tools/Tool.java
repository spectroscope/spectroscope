package dev.spectroscope.core.tools;

import com.fasterxml.jackson.databind.JsonNode;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.events.RunEvent;

import java.nio.file.Path;
import java.util.function.Consumer;

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
     * What the loop hands a tool for one call. Grown additively in tools that
     * produce artifacts publish domain events through {@code emit} (the loop injects its
     * own event sink plus the ids of the call) — the two-arg constructor keeps every
     * earlier tool and test compiling unchanged.
     *
     * @param cwd     the sandbox root every path tool resolves against
     * @param signal  the run's cancel signal — long-running tools should honor it
     * @param agentId the calling agent, stamped into emitted events
     * @param callId  the tool_call id, correlating emitted events with this call
     * @param emit    sink into the run's event stream for additive domain events
     */
    record ToolContext(Path cwd, CancelSignal signal,
                       String agentId, String callId,          // from additive
                       Consumer<RunEvent> emit,                // from additive
                       Consumer<Attachment> attach) {          // view_image/view_file, additive

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
