package dev.spectroscope.core.session;

import dev.spectroscope.core.Agent;

import java.util.Locale;
import java.util.function.IntSupplier;

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

    /** The smallest completion a summary can plausibly be written in. A window
     *  so small that its reserve is under this has bigger problems than the
     *  summarizer; asking for zero tokens would just fail the call. */
    private static final int MIN_SUMMARY_TOKENS = 512;

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
        if (isSet(override)) {
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

    /**
     * The same decision, but the backend is only ASKED when its answer can still
     * change the outcome.
     *
     * <p>Why this form exists at all: {@code derive(override, provider
     * .contextWindow())} evaluates its argument before the call, so a session
     * that already had an explicit threshold still paid the capability probe on
     * every run and threw the answer away. Measured with the shipped classes on
     * this machine, that discarded call costs 330 ms against
     * {@code api.openai.com} and 2,001 ms against a host that black-holes the
     * connection — and it is spent BEFORE {@code run_start} is emitted, so it is
     * dead air in the UI rather than a visible wait.</p>
     *
     * <p>The zero-is-unset rule is not repeated here on purpose: it lives once,
     * in {@link #isSet}, so the probe cannot be skipped by a value the
     * derivation then refuses.</p>
     *
     * @param override       the configured {@code compactionThreshold}, exactly as
     *                       {@link #derive(Integer, int)} reads it
     * @param reportedWindow how to ask the provider — called at most once, and
     *                       not at all when the override already decides
     * @return the threshold to compact at, and which fact produced it
     */
    public static Derived derive(Integer override, IntSupplier reportedWindow) {
        if (isSet(override)) {
            return new Derived(override, Source.OVERRIDE);
        }
        return derive(null, reportedWindow.getAsInt());
    }

    /**
     * What the compaction summarizer may spend on its own completion.
     *
     * <p>The summarizer asked for a flat {@link Agent#DEFAULT_MAX_TOKENS}
     * whatever the window. That was harmless while the threshold was a literal
     * 100,000 — on a small model compaction simply never fired — and this card
     * is what makes the path reachable: a model loaded at 8,192 now compacts at
     * 6,144, and the one call the reserve exists to hold would ask for four
     * times the entire window. Compaction never throws, so the visible outcome
     * would have been an {@code ErrorEvent} roughly every other turn, in exactly
     * the configuration AC 4 was written for.</p>
     *
     * <p>The budget IS the reserve: the threshold is three quarters of the
     * window, so a third of the threshold is the quarter kept back. It is only
     * ever clamped DOWN — a run whose window is unknown, or whose threshold the
     * operator typed, keeps the full budget, because neither says anything about
     * how much room is left.</p>
     *
     * @param derived what {@link #derive(Integer, int)} decided for this run
     * @return the {@code maxTokens} for the summarizer's request
     */
    public static int summaryBudget(Derived derived) {
        if (derived.source() != Source.WINDOW) {
            return Agent.DEFAULT_MAX_TOKENS;
        }
        long reserve = derived.tokens() / (long) CONVERSATION_SHARE;
        return (int) Math.min(Agent.DEFAULT_MAX_TOKENS,
                Math.max(MIN_SUMMARY_TOKENS, reserve));
    }

    /**
     * Whether a configured threshold is a number the harness may obey.
     *
     * @param override the configured value, possibly null
     * @return true only for a positive setting; zero and below read as unset
     */
    private static boolean isSet(Integer override) {
        return override != null && override > 0;
    }
}
