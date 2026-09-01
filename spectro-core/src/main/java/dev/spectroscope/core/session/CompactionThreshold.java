package dev.spectroscope.core.session;

import dev.spectroscope.core.Agent;
import dev.spectroscope.core.config.governing.Governs;

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
 * <h2>The four facts, in the order they beat each other</h2>
 *
 * <p>An explicit setting, then the window the backend says the LOADED instance
 * serves, then the window the model's vendor PUBLISHES ({@link ModelWindows}),
 * then the constant. The middle two are not the same knowledge and their order
 * is the point: a server can serve less than a model can hold — a gateway with
 * 32,768 tokens of KV cache in front of a million-token model is a real shape —
 * and it can never serve more. So a measured instance outranks a published
 * ceiling, and the ceiling outranks knowing nothing.</p>
 *
 * <p>Card 366 added the third rung. Before it, {@code LlmProvider
 * .contextWindow()} answered 0 for every hosted model — anthropic has no
 * capability endpoint and the OpenAI wire has none either — and a run on a
 * 1,000,000-token model compacted at 100,000, a tenth of the window the
 * operator was paying for. The interface said such a provider "cannot ask", and
 * that word was carrying "cannot know": a hosted model has nothing to ask
 * BECAUSE its window is a published, fixed property of the model id.</p>
 *
 * <h2>The reserve, and why it is 30 %</h2>
 *
 * <p>70 % of the window belongs to the conversation; the last 30 % is kept back.
 * What has to fit in that reserve is not the next answer alone. At the moment
 * the threshold trips, the very next provider call is {@link Compaction}'s
 * summarizer, which re-sends essentially the same history AND asks for a
 * completion on top of it. So the reserve has to hold at least one
 * {@link Agent#DEFAULT_MAX_TOKENS} completion budget, plus the drift of a
 * chars/4 estimate against a real tokenizer.</p>
 *
 * <p><b>The share was three quarters until card 366, and the argument was
 * re-checked rather than carried over under a new number.</b> It survives:
 * 131,072 is the smallest window in common use (three of the sixteen models
 * installed on the owner's backend report exactly that ceiling), 70 % of it is
 * 91,750, and the reserve left is <b>39,322</b> — still over the 32,000-token
 * default budget, with 7,322 tokens of headroom instead of the quarter's 768.
 * A tenth would leave 13,107 there, and the request the trip exists to prevent
 * would be the one that bursts. The fraction is deliberately NOT a function of
 * the configured {@code maxTokens}: a threshold that moved when someone changed
 * a completion cap would make the ring's caption a moving target, and the
 * compaction summarizer does not spend the run's budget anyway.</p>
 *
 * <p>The number itself is the owner's, from the census in card 365. The
 * arithmetic above is what makes it safe to obey, and it is pinned in
 * {@code CompactionThresholdTest} rather than only asserted here — a number a
 * comment remembers is the third place a stale claim lives.</p>
 *
 * <p><b>An explicit setting always wins.</b> {@code compactionThreshold} in the
 * settings hierarchy is the lever, and a number the operator typed is knowledge
 * the harness does not have. Only an UNSET threshold is derived.</p>
 */
public final class CompactionThreshold {

    /**
     * The threshold used when nothing can be learned — today's constant, kept
     * exactly. A custom or unrecognised backend that states no loaded window and
     * publishes no ceiling lands here; since card 366 that no longer includes
     * anthropic, openai or gemini, whose windows {@link ModelWindows} knows.
     * The web gauge names the same figure ({@code contextRingMath.ts}), for the
     * same reason and in the same words.
     */
    @Governs(kind = Governs.Kind.SETTABLE, unit = Governs.Unit.TOKENS, key = "compactionThreshold")
    public static final int FALLBACK_THRESHOLD = 100_000;

    /** The share of the window the conversation may fill before compaction. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.RATIO)
    private static final int CONVERSATION_SHARE = 7;

    /** …out of this many. See the class note for why the reserve is 30 %. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.RATIO)
    private static final int WINDOW_SHARE = 10;

    /** The smallest completion a summary can plausibly be written in. A window
     *  so small that its reserve is under this has bigger problems than the
     *  summarizer; asking for zero tokens would just fail the call. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.TOKENS)
    private static final int MIN_SUMMARY_TOKENS = 512;

    /** Which fact produced the threshold — carried on {@code context_info} so
     *  the gauge's caption and the harness's behaviour cannot disagree again. */
    public enum Source {
        /** An explicit {@code compactionThreshold} in the settings hierarchy. */
        OVERRIDE,
        /** The window the backend says the LOADED instance actually serves. */
        WINDOW,
        /** The window the model's vendor PUBLISHES — {@link ModelWindows}. */
        MODEL,
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
     * @param window the window the threshold was measured against, or 0 when
     *               none is known. It is NOT redundant with {@code source}: an
     *               OVERRIDE still names a window when one is known, which is
     *               what lets the gauge say "of a 250k window" under a
     *               threshold the operator typed. A local backend under an
     *               explicit threshold reports 0 here on purpose — the probe is
     *               not paid for when the override already decides (card 263),
     *               so nothing about the loaded instance was learned
     */
    public record Derived(int tokens, Source source, int window) {

        /** A derivation that states no window — the pre-366 shape.
         *  @param tokens the input-token level at which compaction runs
         *  @param source which fact produced it */
        public Derived(int tokens, Source source) {
            this(tokens, source, 0);
        }
    }

    /** Static utility — never instantiated. */
    private CompactionThreshold() {}

    /**
     * The whole decision, in the order the cards fix it: an explicit setting,
     * else the backend's stated window minus its reserve, else the model's
     * published window minus its reserve, else the constant.
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
     * @param model          the model id the run is addressed to, for
     *                       {@link ModelWindows}; null or unknown means this
     *                       rung teaches nothing
     * @return the threshold to compact at, the fact that produced it, and the
     *         window behind that fact
     */
    public static Derived derive(Integer override, int reportedWindow, String model) {
        int published = ModelWindows.windowFor(model);
        // The best window KNOWN, whichever rung the threshold ends up on: an
        // override decides the number, and the gauge still gets to name what
        // that number sits inside.
        int known = reportedWindow > 0 ? reportedWindow : published;
        if (isSet(override)) {
            return new Derived(override, Source.OVERRIDE, known);
        }
        if (reportedWindow > 0) {
            return new Derived(share(reportedWindow), Source.WINDOW, reportedWindow);
        }
        if (published > 0) {
            return new Derived(share(published), Source.MODEL, published);
        }
        return new Derived(FALLBACK_THRESHOLD, Source.FALLBACK, 0);
    }

    /**
     * The same decision for a run whose provider names no model.
     *
     * @param override       the configured {@code compactionThreshold}, or null
     * @param reportedWindow the backend's stated window, or 0
     * @return the threshold to compact at, and which fact produced it
     */
    public static Derived derive(Integer override, int reportedWindow) {
        return derive(override, reportedWindow, null);
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
     * <p>The published window does NOT shortcut the probe: it is the rung BELOW
     * the loaded instance, so a run on a model this house knows still asks the
     * backend first, and still asks it exactly once.</p>
     *
     * <p>The zero-is-unset rule is not repeated here on purpose: it lives once,
     * in {@link #isSet}, so the probe cannot be skipped by a value the
     * derivation then refuses.</p>
     *
     * @param override       the configured {@code compactionThreshold}, exactly as
     *                       {@link #derive(Integer, int, String)} reads it
     * @param reportedWindow how to ask the provider — called at most once, and
     *                       not at all when the override already decides
     * @param model          the model id the run is addressed to
     * @return the threshold to compact at, and which fact produced it
     */
    public static Derived derive(Integer override, IntSupplier reportedWindow, String model) {
        if (isSet(override)) {
            return new Derived(override, Source.OVERRIDE, ModelWindows.windowFor(model));
        }
        return derive(null, reportedWindow.getAsInt(), model);
    }

    /**
     * The lazy decision for a run whose provider names no model.
     *
     * @param override       the configured {@code compactionThreshold}, or null
     * @param reportedWindow how to ask the provider — called at most once
     * @return the threshold to compact at, and which fact produced it
     */
    public static Derived derive(Integer override, IntSupplier reportedWindow) {
        return derive(override, reportedWindow, null);
    }

    /**
     * What the compaction summarizer may spend on its own completion.
     *
     * <p>The summarizer asked for a flat {@link Agent#DEFAULT_MAX_TOKENS}
     * whatever the window. That was harmless while the threshold was a literal
     * 100,000 — on a small model compaction simply never fired — and card 263 is
     * what makes the path reachable: a model loaded at 8,192 now compacts at
     * 5,734, and the one call the reserve exists to hold would ask for four
     * times the entire window. Compaction never throws, so the visible outcome
     * would have been an {@code ErrorEvent} roughly every other turn.</p>
     *
     * <p><b>The budget IS the reserve, and since card 366 it is the MEASURED
     * reserve</b> — the window minus the threshold, not the share expressed a
     * second time. Three quarters made the two identical (a third of the
     * threshold is the last quarter); 30 over 70 does not, and a budget derived
     * from the fraction again would have drifted from the room actually left. It
     * is only ever clamped DOWN, and only where a window is known: a run whose
     * window is unknown, or whose threshold the operator typed, keeps the full
     * budget, because neither says anything about how much room is left.</p>
     *
     * @param derived what {@link #derive(Integer, int, String)} decided for this run
     * @return the {@code maxTokens} for the summarizer's request
     */
    public static int summaryBudget(Derived derived) {
        boolean fromWindow = derived.source() == Source.WINDOW || derived.source() == Source.MODEL;
        if (!fromWindow || derived.window() <= 0) {
            return Agent.DEFAULT_MAX_TOKENS;
        }
        long reserve = (long) derived.window() - derived.tokens();
        return (int) Math.min(Agent.DEFAULT_MAX_TOKENS,
                Math.max(MIN_SUMMARY_TOKENS, reserve));
    }

    /**
     * The conversation's share of a window, never rounding down to nothing.
     *
     * @param window the window in tokens, already known to be positive
     * @return the level compaction runs at
     */
    private static int share(int window) {
        // In long: a window above ~306 million would overflow the
        // multiplication, and max_context_length is already 1,048,576 today.
        long share = (long) window * CONVERSATION_SHARE / WINDOW_SHARE;
        return (int) Math.max(1L, share);
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
