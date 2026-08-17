package dev.spectroscope.core.session;

import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.provider.LlmProvider.PTextDelta;
import dev.spectroscope.core.provider.LlmProvider.ProviderContent;
import dev.spectroscope.core.provider.LlmProvider.ProviderEvent;
import dev.spectroscope.core.provider.LlmProvider.ProviderMessage;
import dev.spectroscope.core.provider.LlmProvider.ProviderRequest;
import dev.spectroscope.core.provider.LlmProvider.TextContent;
import dev.spectroscope.core.provider.LlmProvider.ToolResultContent;
import dev.spectroscope.core.provider.VisionFence;
import dev.spectroscope.core.wire.LlmWireTap;

import java.util.ArrayList;
import java.util.List;

/**
 * Context compaction: when the last turn's input tokens cross the threshold,
 * summarize the older history with a dedicated LLM call (same provider, same
 * model, NO tools) and replace the old turns with the summary. The replacement
 * happens IN MEMORY only — the JSONL file is never rewritten (JSONL-FORMAT.md).
 * Never throws: on failure the messages are returned unchanged and the event is
 * an ErrorEvent.
 *
 * <p>The summarizer's request goes through {@link VisionFence#fence} like any
 * other (card 252): a model that cannot see never receives an image, not even
 * from here. This is a second door to the same provider, and it was the one left
 * open when the fence was first built only into the turn loop.</p>
 */
public final class Compaction {

    private static final String SUMMARY_SYSTEM = "You are a precise note-taker. Answer in English.";

    private static final String SUMMARY_PROMPT =
            "Summarize the conversation so far so that work can continue seamlessly. "
                    + "State explicitly: open tasks, decisions made, important file paths and values, "
                    + "and the current state. Answer with the summary only.";

    private static final int DEFAULT_KEEP_MESSAGES = 4;

    /**
     * Result of a compaction attempt: the (possibly new) history plus an optional event.
     *
     * @param messages the history to continue with — compacted, or the input unchanged
     * @param event    a Compaction event on success, an ErrorEvent on failure, null
     *                 when nothing happened
     */
    public record Result(List<ProviderMessage> messages, RunEvent event) {}

    /** Static utility — never instantiated. */
    private Compaction() {}

    /**
     * The whole compaction decision for one turn: a cheap no-op below the threshold,
     * a summarizing LLM call (old turns → one summary message) above it.
     *
     * @param provider        the SAME provider the run uses (model lives in it)
     * @param messages        the current history
     * @param lastInputTokens input tokens of the last turn (from the usage event)
     * @param threshold       compaction threshold in input tokens
     * @param agentId         the agentId for the compaction event ("main")
     * @param signal          cooperative cancel (may be null)
     * @return a Result: unchanged messages + null event below the threshold;
     *         compacted messages + a Compaction event on success; unchanged
     *         messages + an ErrorEvent on failure
     */
    public static Result maybeCompact(LlmProvider provider, List<ProviderMessage> messages,
                                      int lastInputTokens, int threshold, String agentId,
                                      CancelSignal signal) {
        return maybeCompact(provider, messages, lastInputTokens, threshold, agentId, signal, null);
    }

    /**
     * The tap-aware variant (card 184): the summarizer's own model call rides
     * the llm-wire record when the caller binds a tap for it (kind
     * "compaction"). The tap-free signature above keeps delegating here.
     *
     * @param provider        the SAME provider the run uses (model lives in it)
     * @param messages        the current history
     * @param lastInputTokens input tokens of the last turn (from the usage event)
     * @param threshold       compaction threshold in input tokens
     * @param agentId         the agentId for the compaction event ("main")
     * @param signal          cooperative cancel (may be null)
     * @param tap             where the summarizer call records its real exchange;
     *                        null records nothing
     * @return a Result exactly as the tap-free signature describes it
     */
    public static Result maybeCompact(LlmProvider provider, List<ProviderMessage> messages,
                                      int lastInputTokens, int threshold, String agentId,
                                      CancelSignal signal, LlmWireTap tap) {
        int keep = DEFAULT_KEEP_MESSAGES;
        if (lastInputTokens < threshold) {
            return new Result(messages, null);
        }
        if (messages.size() <= keep + 2) {
            return new Result(messages, null);
        }

        List<ProviderMessage> old = new ArrayList<>(messages.subList(0, messages.size() - keep));
        List<ProviderMessage> recent = new ArrayList<>(messages.subList(messages.size() - keep, messages.size()));

        // Repair the cut: recent must not start with tool_results whose tool_calls
        // are in old — otherwise the API rejects the history.
        while (!recent.isEmpty()
                && recent.getFirst().role() == ProviderMessage.Role.USER
                && containsToolResult(recent.getFirst())) {
            old.add(recent.removeFirst());
        }
        if (recent.isEmpty()) {
            return new Result(messages, null);
        }

        try {
            List<ProviderMessage> summaryInput = new ArrayList<>(old);
            summaryInput.add(new ProviderMessage(ProviderMessage.Role.USER,
                    List.of(new TextContent(SUMMARY_PROMPT))));

            StringBuilder summary = new StringBuilder();
            // Card 252: the summarizer is a SECOND door to the same provider, and
            // it opens on the same history — so it asks the same fence the turn
            // loop asks. Handing an image to a model that cannot see it is what
            // wedged the owner's session; doing it from here would only have moved
            // the wedge later, to the turn that first crosses the threshold. The
            // fence copies: `messages` and everything this method RETURNS keep
            // their images, so the record and the kept window are untouched.
            ProviderRequest request = new ProviderRequest(
                    SUMMARY_SYSTEM,
                    VisionFence.fence(provider,
                            SessionStore.mergeAdjacentRoles(summaryInput)).messages(),
                    List.of(),      // summary call ALWAYS without tools
                    32000,          // generous maxTokens; no sampling parameters
                    ProviderRequest.Reasoning.DEFAULT,
                    null,           // no effort request either
                    signal,
                    tap);           // the summarizer call is on the wire record too
            for (ProviderEvent event : provider.stream(request)) {
                if (event instanceof PTextDelta delta) {
                    summary.append(delta.text());
                }
            }
            if (summary.toString().isBlank()) {
                return new Result(messages, null);
            }

            List<ProviderMessage> compacted = new ArrayList<>();
            compacted.add(new ProviderMessage(ProviderMessage.Role.USER,
                    List.of(new TextContent("[Summary of the conversation so far]\n\n"
                            + summary.toString().strip()))));
            compacted.addAll(recent);

            RunEvent event = new RunEvent.Compaction(agentId, old.size(), summary.length(), now());
            return new Result(SessionStore.mergeAdjacentRoles(compacted), event);
        } catch (RuntimeException failure) {
            String message = "Compaction failed: "
                    + (failure.getMessage() != null ? failure.getMessage() : failure.toString());
            return new Result(messages, new RunEvent.ErrorEvent(agentId, message, now()));
        }
    }

    /**
     * Whether a message carries any tool result — such messages must not open the
     * kept-recent window, or their matching calls would be summarized away.
     *
     * @param message the history entry to inspect
     * @return true when at least one content piece is a tool result
     */
    private static boolean containsToolResult(ProviderMessage message) {
        return message.content().stream().anyMatch(ToolResultContent.class::isInstance);
    }

    /**
     * Timestamp source for the emitted events.
     *
     * @return the current wall clock in epoch milliseconds
     */
    private static long now() {
        return System.currentTimeMillis();
    }
}
