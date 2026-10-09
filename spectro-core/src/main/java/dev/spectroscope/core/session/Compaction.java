package dev.spectroscope.core.session;

import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.config.governing.Governs;
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

    /** How many of the most recent messages survive a compaction untouched.
     *  Nothing passes another value — {@code maybeCompact} reads this constant
     *  directly — and no argument for the four is recorded here. */
    @Governs(kind = Governs.Kind.UNEXAMINED, unit = Governs.Unit.COUNT)
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
        return maybeCompact(provider, messages, lastInputTokens, threshold, agentId, signal, tap,
                dev.spectroscope.core.Agent.DEFAULT_MAX_TOKENS);
    }

    /**
     * The canonical form, with the summarizer's own completion budget stated
     * rather than assumed (card 263, review pass).
     *
     * <p>That budget used to be a literal 32,000 here, which was harmless only
     * because compaction never fired on a small model: the threshold was a flat
     * 100,000. Deriving the threshold from the window is what made the path
     * reachable — on a model loaded at 8,192 the trip is at 6,144, and this one
     * call would have asked for four times the whole window. Compaction never
     * throws, so the visible result would have been an {@code ErrorEvent} every
     * other turn instead of a crash. {@link CompactionThreshold#summaryBudget}
     * sizes it against the reserve the threshold kept back.</p>
     *
     * @param provider          the SAME provider the run uses (model lives in it)
     * @param messages          the current history
     * @param lastInputTokens   input tokens of the last turn (from the usage event)
     * @param threshold         compaction threshold in input tokens
     * @param agentId           the agentId for the compaction event ("main")
     * @param signal            cooperative cancel (may be null)
     * @param tap               where the summarizer call records its exchange; null records nothing
     * @param summaryMaxTokens  what the summarizer's own completion may spend
     * @return a Result exactly as the tap-free signature describes it
     */
    public static Result maybeCompact(LlmProvider provider, List<ProviderMessage> messages,
                                      int lastInputTokens, int threshold, String agentId,
                                      CancelSignal signal, LlmWireTap tap, int summaryMaxTokens) {
        return maybeCompact(provider, messages, null, lastInputTokens, threshold,
                Integer.MAX_VALUE, agentId, signal, tap, summaryMaxTokens);
    }

    /**
     * The form the agent loop calls when tool-result elision is on (card 467).
     *
     * <p>The trigger reads the usage of the last request, and with elision on
     * that request carried stubs where old results stood. The full history can
     * then be much larger than the window when the trigger fires, and handing
     * all of it to the summarizer would fail on the backend every turn. So the
     * summarizer reads the request view, and the stubbed results are put back
     * in full, newest first, while the input stays within
     * {@code summaryInputTokens} (estimated at chars/4, the context gauge's
     * rule). A history that fits whole is read whole. If the backend still
     * refuses the fitted history, the summarizer is asked once more with the
     * request view as it is, which is no larger than the request the backend
     * accepted on the turn before.</p>
     *
     * <p>Only the summarizer's input changes. The history this returns keeps
     * the full recent messages, and the old ones become the summary.</p>
     *
     * @param provider           the SAME provider the run uses (model lives in it)
     * @param messages           the current history, in full
     * @param requestView        the same history as the request carries it, one
     *                           message per message of {@code messages}; null, or
     *                           a list of another length, means the full history
     * @param lastInputTokens    input tokens of the last turn (from the usage event)
     * @param threshold          compaction threshold in input tokens
     * @param summaryInputTokens the most the summarizer's input may hold, in
     *                           estimated tokens; the agent passes the threshold
     *                           derived for the turn, which leaves the window's
     *                           reserve for the summary itself
     * @param agentId            the agentId for the compaction event ("main")
     * @param signal             cooperative cancel (may be null)
     * @param tap                where the summarizer call records its exchange; null records nothing
     * @param summaryMaxTokens   what the summarizer's own completion may spend
     * @return a Result exactly as the tap-free signature describes it
     */
    public static Result maybeCompact(LlmProvider provider, List<ProviderMessage> messages,
                                      List<ProviderMessage> requestView, int lastInputTokens,
                                      int threshold, int summaryInputTokens, String agentId,
                                      CancelSignal signal, LlmWireTap tap, int summaryMaxTokens) {
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

        List<ProviderMessage> oldView = requestView != null && requestView.size() == messages.size()
                ? requestView.subList(0, old.size())
                : old;
        List<ProviderMessage> fitted = fitted(old, oldView, summaryInputTokens);
        try {
            String summary;
            try {
                summary = summarize(provider, fitted, signal, tap, summaryMaxTokens);
            } catch (RuntimeException refused) {
                if (fitted.equals(oldView) || (signal != null && signal.isCancelled())) {
                    throw refused;
                }
                summary = summarize(provider, oldView, signal, tap, summaryMaxTokens);
            }
            if (summary.isBlank()) {
                return new Result(messages, null);
            }

            List<ProviderMessage> compacted = new ArrayList<>();
            compacted.add(new ProviderMessage(ProviderMessage.Role.USER,
                    List.of(new TextContent("[Summary of the conversation so far]\n\n"
                            + summary.strip()))));
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
     * One summarizer call over the old part of the history.
     *
     * @param provider         the run's provider
     * @param old              the messages to summarize
     * @param signal           cooperative cancel (may be null)
     * @param tap              the wire binding, or null
     * @param summaryMaxTokens the completion budget
     * @return the summary text, possibly blank
     */
    private static String summarize(LlmProvider provider, List<ProviderMessage> old,
                                    CancelSignal signal, LlmWireTap tap, int summaryMaxTokens) {
        List<ProviderMessage> summaryInput = new ArrayList<>(old);
        summaryInput.add(new ProviderMessage(ProviderMessage.Role.USER,
                List.of(new TextContent(SUMMARY_PROMPT))));

        StringBuilder summary = new StringBuilder();
        // Card 252: the summarizer is a SECOND door to the same provider, and
        // it opens on the same history, so it asks the same fence the turn
        // loop asks. Handing an image to a model that cannot see it is what
        // wedged the owner's session; doing it from here would only have moved
        // the wedge later, to the turn that first crosses the threshold. The
        // fence copies: `messages` and everything this method RETURNS keep
        // their images, so the record and the kept window are untouched.
        ProviderRequest request = new ProviderRequest(
                SUMMARY_SYSTEM,
                VisionFence.fence(provider,
                        SessionStore.mergeAdjacentRoles(summaryInput)).messages(),
                List.of(),          // summary call ALWAYS without tools
                summaryMaxTokens,   // sized against the window; no sampling parameters
                ProviderRequest.Reasoning.DEFAULT,
                null,           // no effort request either
                signal,
                tap);           // the summarizer call is on the wire record too
        for (ProviderEvent event : provider.stream(request)) {
            if (event instanceof PTextDelta delta) {
                summary.append(delta.text());
            }
        }
        return summary.toString();
    }

    /**
     * The old messages as the summarizer reads them: the request view, with
     * each piece the view changed put back in full, newest first, while the
     * estimate stays within the budget. Equal to {@code old} when all of it fits.
     *
     * @param old     the old messages in full
     * @param oldView the same messages as the request carried them
     * @param budget  the most the summarizer's input may hold, in estimated tokens
     * @return the messages to summarize
     */
    private static List<ProviderMessage> fitted(List<ProviderMessage> old,
                                                List<ProviderMessage> oldView, int budget) {
        if (oldView == old) {
            return old;
        }
        long tokens = (SUMMARY_SYSTEM.length() + SUMMARY_PROMPT.length() + chars(oldView)) / 4;
        List<List<ProviderContent>> content = new ArrayList<>();
        for (ProviderMessage message : oldView) {
            content.add(new ArrayList<>(message.content()));
        }
        for (int m = old.size() - 1; m >= 0; m--) {
            List<ProviderContent> full = old.get(m).content();
            List<ProviderContent> seen = content.get(m);
            for (int c = full.size() - 1; c >= 0; c--) {
                if (c >= seen.size() || full.get(c).equals(seen.get(c))) {
                    continue;
                }
                long more = (chars(full.get(c)) - chars(seen.get(c))) / 4;
                if (tokens + more <= budget) {
                    seen.set(c, full.get(c));
                    tokens += more;
                }
            }
        }
        List<ProviderMessage> out = new ArrayList<>(oldView.size());
        for (int m = 0; m < oldView.size(); m++) {
            out.add(new ProviderMessage(oldView.get(m).role(), List.copyOf(content.get(m))));
        }
        return out.equals(old) ? old : List.copyOf(out);
    }

    /** The chars of a message list, counted the way the context gauge counts them. */
    private static long chars(List<ProviderMessage> messages) {
        long total = 0;
        for (ProviderMessage message : messages) {
            for (ProviderContent content : message.content()) {
                total += chars(content);
            }
        }
        return total;
    }

    /** The chars one content block adds to an estimate. */
    private static long chars(ProviderContent content) {
        return switch (content) {
            case TextContent text -> text.text().length();
            case LlmProvider.ImageContent image -> image.dataBase64().length();
            case LlmProvider.DocumentContent document -> document.dataBase64().length();
            case LlmProvider.ToolCallContent call -> call.name().length()
                    + (call.input() == null ? 0 : call.input().toString().length());
            case ToolResultContent result -> result.output().length();
        };
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
