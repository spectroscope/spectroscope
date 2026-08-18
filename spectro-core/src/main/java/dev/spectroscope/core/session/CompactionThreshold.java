package dev.spectroscope.core.session;

import dev.spectroscope.core.Agent;

import java.util.Locale;

/**
 * Where the compaction trigger's number comes from (card 263) — the pure half,
 * with no provider and no network in it.
 *
 * <p>The defect this replaces: the harness compacted at a literal 100,000
 * whatever the backend offered. Measured on the owner's own LM Studio, the
 * loaded instance served 204,288 tokens while the session summarized itself
 * away at 100,000 — 40 % of the window the operator had paid for in RAM and
 * load time. The same constant is wrong in the other direction for a model
 * loaded at 8,192: nothing ever compacted, and the server truncated silently.</p>
 *
 * <h2>The reserve, and why it is a quarter</h2>
 *
 * <p>Three quarters of the window belong to the conversation; the last quarter
 * is kept back. What has to fit in that quarter is not the next answer alone.
 * At the moment the threshold trips, the very next provider call is
 * {@link Compaction}'s summarizer, which re-sends essentially the same history
 * AND asks for a completion on top of it. So the reserve has to hold at least
 * one {@link Agent#DEFAULT_MAX_TOKENS} completion budget, plus the drift of a
 * chars/4 estimate against a real tokenizer.</p>
 *
 * <p>A quarter does that across the windows this house actually meets. 131,072
 * is the smallest in common use (three of the sixteen models installed on the
 * owner's backend report exactly that ceiling); a quarter of it is 32,768,
 * just over the 32,000-token default budget. A tenth would leave 13,107 there
 * — and the request the trip exists to prevent would be the one that bursts.
 * The fraction is deliberately NOT a function of the configured
 * {@code maxTokens}: a threshold that moved when someone changed a completion
 * cap would make the ring's caption a moving target, and the compaction
 * summarizer does not spend the run's budget anyway.</p>
 *
 * <p><b>An explicit setting always wins.</b> {@code compactionThreshold} in the
 * settings hierarchy is the lever, and a number the operator typed is knowledge
 * the harness does not have. Only an UNSET threshold is derived.</p>
 */
public final class CompactionThreshold {

    /**
     * The threshold used when nothing can be learned — today's constant, kept
     * exactly. Anthropic has no capability endpoint, the OpenAI wire has none,
     * and a backend that is down teaches nothing either; all of them land here.
     * The web gauge names the same figure ({@code contextRingMath.ts}), for the
     * same reason and in the same words.
     */
    public static final int FALLBACK_THRESHOLD = 100_000;

    /** The share of the window the conversation may fill before compaction. */
    private static final int CONVERSATION_SHARE = 3;

    /** …out of this many. See the class note for why the reserve is a quarter. */
    private static final int WINDOW_SHARE = 4;

    /** Which fact produced the threshold — carried on {@code context_info} so
     *  the gauge's caption and the harness's behaviour cannot disagree again. */
    public enum Source {
        /** An explicit {@code compactionThreshold} in the settings hierarchy. */
        OVERRIDE,
        /** The window the backend says the LOADED instance actually serves. */
        WINDOW,
        /** Nothing was learned — {@link #FALLBACK_THRESHOLD}. */
        FALLBACK;

        /** @return the lowercase name this source rides the wire under */
        public String wireName() {
            return name().toLowerCase(Locale.ROOT);
        }
    }

    /**
     * The derived threshold and the fact behind it.
     *
     * @param tokens the input-token level at which compaction runs
     * @param source which fact produced it
     */
    public record Derived(int tokens, Source source) {}

    /** Static utility — never instantiated. */
    private CompactionThreshold() {}

    /**
     * The whole decision, in the order the card fixes it: an explicit setting,
     * else the backend's stated window minus its reserve, else the constant.
     *
     * @param override       the configured {@code compactionThreshold}, or null
     *                       when the settings hierarchy leaves it unset. A value
     *                       of zero or less is treated as unset, not obeyed:
     *                       {@link Compaction#maybeCompact} returns early only
     *                       while {@code lastInputTokens < threshold}, so a zero
     *                       would compact on the empty first turn and every turn
     *                       after it
     * @param reportedWindow what {@code LlmProvider.contextWindow()} answered —
     *                       the tokens the instance serving the next request can
     *                       hold, or 0 when nothing is known. Anything below 1 is
     *                       read as "nothing known", never as a tiny window
     * @return the threshold to compact at, and which fact produced it
     */
    public static Derived derive(Integer override, int reportedWindow) {
        if (override != null && override > 0) {
            return new Derived(override, Source.OVERRIDE);
        }
        if (reportedWindow > 0) {
            // In long: a window above ~715 million would overflow the
            // multiplication, and max_context_length is already 1,048,576 today.
            long share = (long) reportedWindow * CONVERSATION_SHARE / WINDOW_SHARE;
            return new Derived((int) Math.max(1L, share), Source.WINDOW);
        }
        return new Derived(FALLBACK_THRESHOLD, Source.FALLBACK);
    }
}
