package dev.spectroscope.core.session;

import com.fasterxml.jackson.databind.JsonNode;
import dev.spectroscope.core.config.governing.Governs;
import dev.spectroscope.core.permission.ToolTier;
import dev.spectroscope.core.permission.ToolTierMap;
import dev.spectroscope.core.provider.LlmProvider.ProviderContent;
import dev.spectroscope.core.provider.LlmProvider.ProviderMessage;
import dev.spectroscope.core.provider.LlmProvider.ToolCallContent;
import dev.spectroscope.core.provider.LlmProvider.ToolResultContent;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.function.Predicate;

/**
 * Card 467: an old, large tool result leaves the outgoing request as a one-line
 * stub, and the history keeps every byte of it.
 *
 * <p>The same shape as {@link dev.spectroscope.core.provider.VisionFence}: the
 * caller hands the history in and gets a COPY out. The agent's own message
 * list, the session file, the trace and the Lab never see a stub; only the
 * {@code ProviderRequest} does, and with it the llm wire, which records what
 * was sent.</p>
 *
 * <p><b>Which results.</b> A tool result is left out when more than
 * {@link #KEEP_TURNS} assistant turns have followed it, it is longer than
 * {@link #MIN_RESULT_CHARS}, and the tool that produced it can give the same
 * thing back when called again. A child agent's report and a person's answer
 * cannot, so the caller says which tools can (the agent asks its registry).</p>
 *
 * <p><b>What the stub says a second call does.</b> A tool the shipped tier map
 * rates {@code read} only looks, so its stub tells the model to call it again
 * to read the thing as it is now. Every other tool, an MCP tool nobody rated
 * included, acts when it is called, and its stub says that a second call runs
 * it again, with its effects, and may return something different. The map is
 * the one the permission gate reads, so the two cannot disagree.</p>
 *
 * <p><b>In batches.</b> Anthropic caches the request up to its last stable
 * message, and any change to an earlier message throws that cache away from
 * the change onwards. Stubbing each result on the turn it becomes old would
 * change the prefix on nearly every turn. So the set of stubbed results grows
 * only when the results waiting to be stubbed would save at least
 * {@link #BATCH_CHARS} together; between two batches every request sends the
 * earlier messages exactly as the request before it did.</p>
 *
 * <p>The bookkeeping lives with the agent, like its history. A stubbed
 * position is remembered by message index, content index and call id, and an
 * entry is forgotten as soon as its position no longer holds that call or is
 * no longer old, which is what a history replaced by compaction looks like.</p>
 */
public final class ToolResultElision {

    /**
     * How many assistant turns a tool result stays in the request in full
     * after the turn that produced it.
     *
     * <p>Picked from a census of the 368 local session files on 2026-10-09
     * ({@code ToolResultElisionCensus}, table in {@code kanban/evidence/467/review/}):
     * 1,387 requests of the main agent replayed with a batch of 8,000 chars,
     * each recorded compaction applied where it happened (5, all in one
     * session). Share of request chars saved, pooled over every request,
     * K = 4, 6, 8 at N = 2,000: 25.7 %, 24.8 %, 24.0 %. Without the one session
     * of 525 requests that dominates the pool: 4.9 %, 4.5 %, 4.2 %. The
     * smallest K of the grid saves the most in both views, and no larger K was
     * within 0.2 points of it, so 4 ships.</p>
     *
     * <p>The whole grid, share of chars saved pooled over every request, for
     * N = 1,000 / 2,000 / 4,000: K = 4: 29.4 / 25.7 / 17.3 %. K = 6:
     * 28.4 / 24.8 / 16.6 %. K = 8: 27.5 / 24.0 / 15.9 %. The same grid without
     * the dominant session: K = 4: 5.0 / 4.9 / 2.3 %. K = 6: 4.6 / 4.5 / 2.0 %.
     * K = 8: 4.3 / 4.2 / 1.8 %. Mean request off: 99,940 chars; on at the
     * shipped pair: 74,233. The compaction points are those of runs without
     * elision, and a run with elision compacts later.</p>
     */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.TURNS)
    public static final int KEEP_TURNS = 4;

    /**
     * The size at or under which a tool result always stays.
     *
     * <p>Picked from the same census as {@link #KEEP_TURNS}. Share of request
     * chars saved at K = 4, N = 1,000, 2,000, 4,000: 29.4 %, 25.7 %, 17.3 %
     * pooled, and 5.0 %, 4.9 %, 2.3 % without the session that dominates the
     * pool; batches (each one a cache prefix thrown away) 50, 45 and 31 over
     * 1,387 requests. The rule: the largest saving without the dominant
     * session, unless a larger N is within 0.2 points of it. 2,000 is 0.1 below
     * 1,000 there, so 2,000 ships and keeps every result under two thousand
     * chars whole.</p>
     */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.CHARACTERS)
    public static final int MIN_RESULT_CHARS = 2_000;

    /**
     * The smallest saving that changes the request: results waiting to be
     * stubbed are stubbed together once they would save this many chars, never
     * one by one. Card 467 sets the floor at 8,000 so an Anthropic cached
     * prefix survives between batches.
     */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.CHARACTERS)
    public static final int BATCH_CHARS = 8_000;

    /**
     * The longest path or command word a stub repeats. The argument is already
     * in the history in full, inside the call the model made; the stub only has
     * to let the model recognise which call it was.
     */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.CHARACTERS)
    public static final int MAX_ARGUMENT_CHARS = 40;

    /** One stubbed place in the history. */
    private record Position(int message, int content) {
    }

    private final boolean enabled;
    private final Predicate<String> repeatable;
    private final int keepTurns;
    private final int minResultChars;
    private final int batchChars;

    /** Stubbed positions and the call id each one held when it was stubbed. */
    private final Map<Position, String> elided = new HashMap<>();

    /**
     * The shipped rule: {@link #KEEP_TURNS}, {@link #MIN_RESULT_CHARS} and
     * {@link #BATCH_CHARS}.
     *
     * @param enabled    false hands every history through untouched
     * @param repeatable answers, for a tool name, whether calling that tool
     *                   again gives the model back what its earlier result said;
     *                   a result of any other tool is never stubbed
     */
    public ToolResultElision(boolean enabled, Predicate<String> repeatable) {
        this(enabled, repeatable, KEEP_TURNS, MIN_RESULT_CHARS, BATCH_CHARS);
    }

    /**
     * The rule with its numbers spelled out, for the tests and the census that
     * picked the shipped ones.
     *
     * @param enabled        false hands every history through untouched
     * @param repeatable     which tools can give their result back
     * @param keepTurns      assistant turns a result stays in full
     * @param minResultChars the size at or under which a result always stays
     * @param batchChars     the saving that has to be waiting before the
     *                       request changes
     */
    ToolResultElision(boolean enabled, Predicate<String> repeatable,
                      int keepTurns, int minResultChars, int batchChars) {
        this.enabled = enabled;
        this.repeatable = repeatable == null ? name -> false : repeatable;
        this.keepTurns = keepTurns;
        this.minResultChars = minResultChars;
        this.batchChars = batchChars;
    }

    /**
     * Whether a settings value turns the elision on. Unset means the shipped
     * value, on; only {@code "off"} turns it off.
     *
     * @param setting the {@code toolResultElision} value, or null when unset
     * @return true unless the value is {@code "off"}
     */
    public static boolean enabled(String setting) {
        return !"off".equals(setting);
    }

    /**
     * Whether a second call to a tool only reads, by the tier the permission
     * gate uses: {@code read} in the shipped {@code tool-tiers.json}.
     *
     * @param toolName the tool as the model addresses it
     * @return true for a read-tier tool; false for every other, unrated ones included
     */
    static boolean readsOnly(String toolName) {
        return ToolTierMap.shipped().resolve(toolName).tier() == ToolTier.READ;
    }

    /**
     * The history to put in the next request.
     *
     * @param history the agent's own history; never mutated
     * @return the same list when nothing is stubbed, otherwise a copy in which
     *         every stubbed tool result carries its one-line stub
     */
    public synchronized List<ProviderMessage> requestView(List<ProviderMessage> history) {
        if (!enabled) {
            return history;
        }
        int[] assistantsAfter = assistantsAfter(history);
        // An entry stays only while its place still holds that call AND is still
        // old. In a growing history both stay true once they are true, so this
        // never takes a stub back and never moves a cached prefix. In a history
        // that was replaced (compaction, or a run after /compact) it drops what
        // no longer applies, even where a backend reuses a call id like "c1".
        elided.entrySet().removeIf(entry -> !holds(history, entry.getKey(), entry.getValue())
                || assistantsAfter[entry.getKey().message()] <= keepTurns);
        Map<Position, String> waiting = new LinkedHashMap<>();
        long waitingSaving = 0;
        Map<String, ToolCallContent> calls = new HashMap<>();
        for (int m = 0; m < history.size(); m++) {
            ProviderMessage message = history.get(m);
            if (message.role() == ProviderMessage.Role.ASSISTANT) {
                calls = callsOf(message);
                continue;
            }
            if (assistantsAfter[m] <= keepTurns) {
                continue;
            }
            for (int c = 0; c < message.content().size(); c++) {
                if (!(message.content().get(c) instanceof ToolResultContent result)) {
                    continue;
                }
                Position at = new Position(m, c);
                if (elided.containsKey(at) || result.output().length() <= minResultChars) {
                    continue;
                }
                ToolCallContent call = calls.get(result.callId());
                if (call == null || !repeatable.test(call.name())) {
                    continue;
                }
                int saving = result.output().length()
                        - stub(call, result.output().length(), readsOnly(call.name())).length();
                if (saving > 0) {
                    waiting.put(at, result.callId());
                    waitingSaving += saving;
                }
            }
        }
        if (waitingSaving >= batchChars) {
            elided.putAll(waiting);
        }
        if (elided.isEmpty()) {
            return history;
        }
        return stubbed(history);
    }

    /**
     * The one line that stands where a result stood.
     *
     * <p>It names the tool, the path or the first word of the command, and the
     * size, and nothing else from the call: an input such as
     * {@code write_file}'s {@code content} is file content and stays out, and
     * so do a command's arguments, a heredoc body and leading
     * {@code NAME=value} assignments. Its last sentence says what a second
     * call does, which depends on whether the tool only reads.</p>
     *
     * @param call      the call the result answered
     * @param chars     the result's length in chars
     * @param readsOnly true when a second call only reads
     * @return the stub, one line
     */
    static String stub(ToolCallContent call, int chars, boolean readsOnly) {
        String argument = "";
        JsonNode input = call.input();
        if (input != null && input.path("path").isTextual()) {
            argument = " for path \"" + oneLine(input.path("path").asText()) + "\"";
        } else if (input != null && input.path("command").isTextual()) {
            String word = firstWord(input.path("command").asText());
            if (!word.isEmpty()) {
                argument = " for command \"" + oneLine(word) + "\"";
            }
        }
        String again = readsOnly
                ? "Call " + call.name() + " again to read it as it is now."
                : "Calling " + call.name() + " again runs it again, with its effects,"
                        + " and may return a different result.";
        return String.format(Locale.ROOT,
                "[spectroscope: the %s result%s was %,d chars and is left out of this request"
                        + " to save context. %s]",
                call.name(), argument, chars, again);
    }

    /** The command's first word, skipping leading {@code NAME=value} assignments. */
    private static String firstWord(String command) {
        for (String word : command.strip().split("[\\s\\p{Cntrl}]+")) {
            if (!word.isEmpty() && !word.matches("[A-Za-z_][A-Za-z0-9_]*=.*")) {
                return word;
            }
        }
        return "";
    }

    /** Whitespace and control characters fold to single spaces; long text is cut. */
    private static String oneLine(String text) {
        String flat = text.replaceAll("[\\s\\p{Cntrl}]+", " ").strip().replace("\"", "'");
        return flat.length() <= MAX_ARGUMENT_CHARS
                ? flat
                : flat.substring(0, MAX_ARGUMENT_CHARS) + "...";
    }

    /** For each message, how many assistant messages come after it. */
    private static int[] assistantsAfter(List<ProviderMessage> history) {
        int[] after = new int[history.size()];
        int seen = 0;
        for (int m = history.size() - 1; m >= 0; m--) {
            after[m] = seen;
            if (history.get(m).role() == ProviderMessage.Role.ASSISTANT) {
                seen++;
            }
        }
        return after;
    }

    /** The calls one assistant message made, by id. */
    private static Map<String, ToolCallContent> callsOf(ProviderMessage message) {
        Map<String, ToolCallContent> calls = new HashMap<>();
        for (ProviderContent content : message.content()) {
            if (content instanceof ToolCallContent call) {
                calls.put(call.callId(), call);
            }
        }
        return calls;
    }

    /** Whether a remembered position still holds the result it was stubbed for. */
    private static boolean holds(List<ProviderMessage> history, Position at, String callId) {
        if (at.message() >= history.size()) {
            return false;
        }
        List<ProviderContent> content = history.get(at.message()).content();
        return at.content() < content.size()
                && content.get(at.content()) instanceof ToolResultContent result
                && result.callId().equals(callId);
    }

    /** The copy with every stubbed position replaced. */
    private List<ProviderMessage> stubbed(List<ProviderMessage> history) {
        List<ProviderMessage> out = new ArrayList<>(history.size());
        Map<String, ToolCallContent> calls = new HashMap<>();
        for (int m = 0; m < history.size(); m++) {
            ProviderMessage message = history.get(m);
            if (message.role() == ProviderMessage.Role.ASSISTANT) {
                calls = callsOf(message);
                out.add(message);
                continue;
            }
            List<ProviderContent> content = null;
            for (int c = 0; c < message.content().size(); c++) {
                ProviderContent piece = message.content().get(c);
                if (elided.containsKey(new Position(m, c))
                        && piece instanceof ToolResultContent result
                        && calls.get(result.callId()) != null) {
                    if (content == null) {
                        content = new ArrayList<>(message.content());
                    }
                    ToolCallContent call = calls.get(result.callId());
                    content.set(c, new ToolResultContent(result.callId(),
                            stub(call, result.output().length(), readsOnly(call.name())),
                            result.isError()));
                }
            }
            out.add(content == null ? message
                    : new ProviderMessage(message.role(), List.copyOf(content)));
        }
        return List.copyOf(out);
    }
}
