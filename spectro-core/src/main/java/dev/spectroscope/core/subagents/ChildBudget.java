package dev.spectroscope.core.subagents;

import dev.spectroscope.core.config.governing.Governs;
import dev.spectroscope.core.provider.ExchangeLatency;

import java.util.OptionalLong;

/**
 * What a child agent may spend, DERIVED from the backend it runs on rather than
 * typed into a constant (card 270, cut 1 of {@code konzept/ORCHESTRATION.md}).
 *
 * <h2>Why the constant had to go</h2>
 *
 * <p>{@code CHILD_TIMEOUT_MS = 120_000} was one literal doing two different
 * jobs, and it was wrong at both. Measured on the owner's own backend
 * (lmstudio / {@code deepseek-v4-flash-0731@iq1_m}) over the baseline session in
 * {@code konzept/ORCHESTRATION.md} §7: 18 exchanges, median <b>92.2 s</b>,
 * maximum <b>1,560.9 s</b>, and <b>7 of the 15 chat exchanges longer than the
 * whole budget a child got for its entire run</b>. A child would have been
 * killed mid-thought about half the time, and the parent would have paid for the
 * tokens.</p>
 *
 * <h2>The two clocks, and why there are two</h2>
 *
 * <p>The old literal ran from the spawn, so it could not tell a WEDGED child
 * from a WAITING one. Four children are submitted to the provider at once
 * ({@code SubagentManager.runChildrenInParallel}) and nothing between them and
 * the backend queues or limits, so on a single loaded local model the third and
 * fourth spend real time in a queue the timeout cannot see. Hence:</p>
 *
 * <ul>
 *   <li>the <b>run budget</b> ({@link #runBudgetMs()}) starts at the child's
 *       FIRST TOKEN and answers "is it still getting anywhere";</li>
 *   <li>the <b>queue grace</b> ({@link #firstTokenGraceMs()}) starts at the
 *       spawn and answers only "did this backend ever start on my child".</li>
 * </ul>
 *
 * <h2>The derivation, with its inputs</h2>
 *
 * <pre>
 *   p50            = median of the last {@link ExchangeLatency#WINDOW} measured
 *                    exchanges of THIS session (parent's and children's alike)
 *   floor          = the operator's {@code subagentBudgetSeconds} in
 *                    milliseconds (card 372), shipped at two hours
 *   implied p50    = {@link #IMPLIED_P50_MS}, standing in for p50 in the
 *                    queue allowance while nothing has been measured
 *   runBudget      = floor
 *                        while nothing has been measured
 *                  = max(floor, min({@link #CEILING_MS}, {@link #P50_MULTIPLE} × p50))
 *                        once something has been measured
 *   queueAllowance = ({@link SubagentManager#MAX_PARALLEL_CHILDREN} - 1) × p50
 *   grace          = min({@link #GRACE_CEILING_MS}, runBudget + queueAllowance)
 *   worst case     = grace + runBudget          — the clocks run in SEQUENCE
 * </pre>
 *
 * <p><b>The ceiling caps the measured term, never the floor.</b> It is a limit on
 * what a measurement may claim, and an operator who types 3,600 s means 3,600 s.
 * Card 372 moved the {@code min} inside the {@code max} for exactly that reason:
 * the old {@code min(CEILING, max(floor, ...))} would have turned a typed hour
 * into half of one without saying so.</p>
 *
 * <p>Worked, on the shipped floor of 7,200,000 ms and the numbers above: p50 =
 * 92,200 ms, so the measured term is min(1,800,000, 276,600) = 276,600 ms and
 * the floor governs, runBudget = <b>7,200,000 ms</b>. The queue allowance is
 * 3 × 92,200 = 276,600 ms, so grace = min(2,700,000, 7,476,600) =
 * <b>2,700,000 ms</b>, its own ceiling. Worst case 9,900,000 ms, <b>165 min</b>.
 * A backend slow enough to matter is priced above the floor only when the
 * operator has lowered it: at a 60 s floor and a p50 of 200 s a child gets
 * 600 s.</p>
 *
 * <p><b>The two clocks are sequential, so their bounds compose.</b> The grace
 * is disarmed by the first token and the run budget armed at that same instant,
 * so a child that speaks just before its grace expires and then wedges costs
 * {@code grace + runBudget}. At the grace ceiling and the shipped floor that is
 * 45 + 120 = <b>165 min</b>, and neither {@link #CEILING_MS} nor
 * {@link #GRACE_CEILING_MS} is the number a reader wants. {@link #worstCaseMs()}
 * is, and it computes it rather than restating it.</p>
 *
 * <p><b>An explicit override wins outright</b> ({@link #fixed}): a face or a test
 * that names a number gets that number, and the grace is derived from the
 * override's own implied p50 rather than from the measurement — an override is a
 * statement about this run, not a new estimate of the backend.</p>
 *
 * <p>{@link #P50_MULTIPLE} and the ceilings are the values
 * {@code konzept/ORCHESTRATION.md} §7 proposed. The concept files them as an
 * open OWNER decision (§9, item 5), so they are named here, in one place, with
 * their measurement beside them, rather than spread over the code. The floor is
 * no longer one of them: card 372 handed it to the operator under the key
 * {@code subagentBudgetSeconds}. Its shipped value,
 * {@link dev.spectroscope.core.config.SpectroConfig#DEFAULT_SUBAGENT_BUDGET_SECONDS},
 * is still the floor the one-argument {@link #derivedFrom(ExchangeLatency)}
 * uses, the floor {@link #fixed(long)} carries beside its override, and the
 * floor {@code SubagentConfig}'s canonical constructor applies when the key is
 * null. The deprecated {@link #FLOOR_MS} restates it in milliseconds for code
 * compiled against the release that published it.</p>
 */
public final class ChildBudget {

    /** The p50 assumed while nothing has been measured on this backend: 100 s,
     *  the median the original 300 s floor stood on (300 s / 3). The operator's
     *  floor does not move it: an unmeasured backend is priced by what backends
     *  have measured, not by how patient the operator is. It prices the queue
     *  allowance only; the run budget of an unmeasured backend is the floor. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.MILLISECONDS)
    public static final long IMPLIED_P50_MS = 100_000L;

    /** The shipped floor of a child's run budget in milliseconds. An earlier
     *  release published this name, so it is kept, deprecated, for code
     *  compiled against it. The floor is now the operator's
     *  {@code subagentBudgetSeconds}, and this constant restates its shipped
     *  default,
     *  {@link dev.spectroscope.core.config.SpectroConfig#DEFAULT_SUBAGENT_BUDGET_SECONDS},
     *  so it no longer says which floor a given budget runs on.
     *  @deprecated read {@link #floorMs()} on the budget in hand */
    @Deprecated
    @Governs(kind = Governs.Kind.ALIAS, unit = Governs.Unit.MILLISECONDS)
    public static final long FLOOR_MS =
            dev.spectroscope.core.config.SpectroConfig.DEFAULT_SUBAGENT_BUDGET_SECONDS * 1000L;

    /** How many median exchanges a child may spend once it has started
     *  producing: three. A child that has had three median turns and is still
     *  going is not waiting, it is lost. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.RATIO)
    public static final int P50_MULTIPLE = 3;

    /**
     * The hard stop on a DERIVED run budget: 30 min. Above the largest exchange
     * ever measured here (1,560.9 s = 26.0 min, HTTP 200), so a single real
     * exchange still fits inside it.
     *
     * <p><b>It bounds the measured term only.</b> A floor the operator typed
     * passes it untouched (card 372); this number says how far a measurement
     * may carry a child, not how long an operator may let one run.</p>
     *
     * <p><b>And it bounds ONE of the two clocks, not the child.</b> The two run
     * in sequence, so what a child can actually hold its requester for is
     * {@link #worstCaseMs()} and not this constant. At the shipped floor that
     * composed number is far above this one, 9,900,000 ms against 1,800,000.
     * Under a floor the operator has lowered it can sit well below it: at a
     * 60 s floor with nothing measured the worst case is 420,000 ms. Either
     * way, read it there rather than here.</p>
     */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.MILLISECONDS)
    public static final long CEILING_MS = 1_800_000L;

    /** The hard stop on the queue grace: 45 min — the run ceiling plus one
     *  full wave of the same. Like {@link #CEILING_MS} it bounds its own clock
     *  only; {@link #worstCaseMs()} composes them. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.MILLISECONDS)
    public static final long GRACE_CEILING_MS = 2_700_000L;

    /** {@code run_end} stop reason of a child whose run budget ran out AFTER it
     *  had started producing. A new VALUE on an existing field: the RunEvent
     *  shape is untouched, and {@code LevelingFold}'s completed-run set is an
     *  allow-list, so a budget-exhausted child correctly reads as unfinished. */
    public static final String STOP_BUDGET_EXHAUSTED = "child_budget_exhausted";

    /** {@code run_end} stop reason of a child the backend never started on. */
    public static final String STOP_NO_FIRST_TOKEN = "child_no_first_token";

    /** {@code run_end} stop reason of a child whose spend passed its token
     *  budget, {@code subagentBudgetTokens} (card 394). A value of its own, so
     *  a session file tells a child that ran out of tokens apart from one that
     *  ran out of time. Not a clock of this class: {@code SubagentManager}
     *  checks it against the child's running usage sum. */
    public static final String STOP_TOKEN_BUDGET_EXHAUSTED = "child_token_budget_exhausted";

    private final ExchangeLatency latency;
    private final Long overrideMs;
    private final long floorMs;

    private ChildBudget(ExchangeLatency latency, Long overrideMs, long floorMs) {
        this.latency = latency;
        this.overrideMs = overrideMs;
        this.floorMs = floorMs;
    }

    /**
     * The production shape with the shipped floor,
     * {@link dev.spectroscope.core.config.SpectroConfig#DEFAULT_SUBAGENT_BUDGET_SECONDS}.
     *
     * @param latency the session's shared window — the parent's own exchanges
     *                and its children's both land in it
     * @return a budget that re-derives itself on every read
     */
    public static ChildBudget derivedFrom(ExchangeLatency latency) {
        return derivedFrom(latency,
                dev.spectroscope.core.config.SpectroConfig.DEFAULT_SUBAGENT_BUDGET_SECONDS * 1000L);
    }

    /**
     * The production shape with the operator's floor (card 372).
     *
     * @param latency the session's shared window
     * @param floorMs the smallest run budget, from {@code subagentBudgetSeconds}
     * @return a budget that re-derives itself on every read
     * @throws IllegalArgumentException when the floor is not positive
     */
    public static ChildBudget derivedFrom(ExchangeLatency latency, long floorMs) {
        requirePositiveFloor(floorMs);
        return new ChildBudget(latency == null ? new ExchangeLatency() : latency, null, floorMs);
    }

    /**
     * The one refusal both entry points speak with, so a floor of zero is
     * refused in the same words wherever it arrives.
     *
     * <p>It names the settings key rather than the parameter. Since card 386 a
     * settings value below 1 does not get here: {@code SettingFloors} has the
     * settings writer refuse it on save and the config loader skip it on read.
     * What can still reach this check is code that builds a
     * {@code SubagentConfig} with its own number, which multiplies
     * {@code subagentBudgetSeconds} by a thousand and hands the result over.
     * The key is the name that code's author finds in the config reference;
     * a "floorMs" is not in it.</p>
     *
     * @param floorMs the floor to check, in milliseconds
     * @throws IllegalArgumentException when it is not positive
     */
    private static void requirePositiveFloor(long floorMs) {
        if (floorMs <= 0) {
            // Reported in seconds, the unit the key is typed in. A floor that is
            // not a whole number of seconds cannot come from the key.
            throw new IllegalArgumentException(
                    "subagentBudgetSeconds must be positive, got " + floorMs / 1000 + " s");
        }
    }

    /**
     * The explicit override, which wins over any measurement.
     *
     * @param runBudgetMs the run budget in milliseconds, counted from the
     *                    child's first token
     * @return a budget that ignores the backend and reports this number
     */
    public static ChildBudget fixed(long runBudgetMs) {
        return new ChildBudget(new ExchangeLatency(), runBudgetMs,
                dev.spectroscope.core.config.SpectroConfig.DEFAULT_SUBAGENT_BUDGET_SECONDS * 1000L);
    }

    /**
     * The same window under the operator's floor. An explicit override is a
     * statement about this run and keeps winning, so it returns itself.
     *
     * <p>The floor is checked BEFORE the override is consulted, so this method
     * refuses exactly what {@link #derivedFrom(ExchangeLatency, long)} refuses.
     * It is the branch both shipped faces take, and an override used to swallow
     * a zero here and hand back a budget whose floor nobody had agreed to.</p>
     *
     * @param floorMs the floor from {@code subagentBudgetSeconds}
     * @return this budget when overridden, else a derived one with that floor
     * @throws IllegalArgumentException when the floor is not positive
     */
    public ChildBudget withFloorMs(long floorMs) {
        requirePositiveFloor(floorMs);
        return overrideMs != null ? this : derivedFrom(latency, floorMs);
    }

    /** The floor a measurement has to clear before it governs.
     *  @return the floor in force, in milliseconds */
    public long floorMs() {
        return floorMs;
    }

    /** The window this budget observes, so children can feed the same one their
     *  parent does.
     *  @return the shared latency window; never null */
    public ExchangeLatency latency() {
        return latency;
    }

    /** What the backend has actually shown, for the sentence a timed-out child
     *  hands back.
     *  @return the measured median exchange, or empty when nothing was measured */
    public OptionalLong observedP50Ms() {
        return latency.p50Ms();
    }

    /** True when a face or a test named the number outright.
     *  @return whether an explicit override is in force */
    public boolean isOverridden() {
        return overrideMs != null;
    }

    /**
     * The budget a child may spend once it has produced its first token.
     *
     * <p>There is no measured term until something has been measured. A session
     * that has seen no exchange yet hands the child the floor and nothing else,
     * so a child on a 60 s floor gets 60 s rather than the 300 s that
     * {@link #IMPLIED_P50_MS} would have implied. The implied median prices the
     * queue allowance, which has no other number to stand on; the run budget
     * does, and it is the operator's.</p>
     *
     * @return milliseconds; the override when one is set, the floor while
     *         nothing has been measured, else
     *         {@code max(floor, min(CEILING, P50_MULTIPLE × p50))}
     */
    public long runBudgetMs() {
        if (overrideMs != null) {
            return overrideMs;
        }
        OptionalLong measured = latency.p50Ms();
        if (measured.isEmpty()) {
            return floorMs;
        }
        return Math.max(floorMs, Math.min(CEILING_MS, P50_MULTIPLE * measured.orElseThrow()));
    }

    /**
     * How long a child may take to produce anything at all, counted from the
     * spawn — the run budget plus the wait behind the other children of a wave.
     *
     * @return milliseconds, capped at {@link #GRACE_CEILING_MS}
     */
    public long firstTokenGraceMs() {
        long queueAllowance = (SubagentManager.MAX_PARALLEL_CHILDREN - 1L) * p50OrImplied();
        return Math.min(GRACE_CEILING_MS, runBudgetMs() + queueAllowance);
    }

    /**
     * The longest one child can hold the requester that spawned it — the two
     * clocks ADDED, because they run in sequence rather than in parallel.
     *
     * <p>{@code SubagentManager.executeChild} arms the grace at the spawn and
     * disarms it at the child's first token, arming the run budget for its full
     * length at that same instant. So a child that stays mute until one
     * millisecond before its grace expires, and then wedges, spends
     * {@code grace + runBudget}. At the grace ceiling and the shipped floor
     * that is 45 + 120 = <b>165 min</b>, not the 30 that {@link #CEILING_MS}
     * alone suggests. A reader who takes the run ceiling for the child's cost
     * is out by more than a factor of five.</p>
     *
     * <p>Nothing in the harness enforces this composed number; it is a fact
     * about the two clocks, exposed so it can be read and pinned instead of
     * recomputed in someone's head. The floor under it is the operator's
     * ({@code subagentBudgetSeconds}), so whoever raises that number raises
     * this one with it.</p>
     *
     * @return milliseconds a child can cost at worst, grace plus run budget
     */
    public long worstCaseMs() {
        return firstTokenGraceMs() + runBudgetMs();
    }

    /**
     * The derivation in one line, for the sentence a child that ran out hands
     * its requester. A budget that cannot say where its number came from is the
     * literal again, wearing a method.
     *
     * <p>It names the key as well as the number, because the floor is now
     * something the reader can change: a child that says only "7200 s floor"
     * leaves its requester hunting for where that came from.</p>
     *
     * <p>The sample size is {@link ExchangeLatency#sampleSize()}, never
     * {@link ExchangeLatency#observed()}: the median is taken over the ring, so
     * on a long session the raw counter names hundreds of exchanges that were
     * deliberately forgotten. A sentence written to justify a number must not
     * overstate the evidence behind it.</p>
     *
     * @return e.g. {@code "derived: max(7200 s floor (subagentBudgetSeconds),
     *         min(1800 s ceiling, 3 × 92 s measured p50 over 9 exchanges))"}
     */
    public String derivation() {
        if (overrideMs != null) {
            return "explicit override: " + overrideMs / 1000 + " s";
        }
        String floor = floorMs / 1000 + " s floor (subagentBudgetSeconds)";
        OptionalLong measured = latency.p50Ms();
        if (measured.isEmpty()) {
            return "derived: " + floor + ", nothing measured on this backend yet";
        }
        return "derived: max(" + floor + ", min(" + CEILING_MS / 1000 + " s ceiling, "
                + P50_MULTIPLE + " × " + measured.orElseThrow() / 1000 + " s measured p50 over "
                + latency.sampleSize() + " exchanges))";
    }

    /**
     * The p50 the queue allowance is built on.
     *
     * <p>Three sources, and the order is the point. An OVERRIDE implies its own
     * p50 ({@code override / P50_MULTIPLE}): a face or a test that says "a child
     * gets 45 s" means a small run, and inheriting a 100 s queue allowance there
     * would make the grace a hundred times the budget. The first version of this
     * method did exactly that, and a 300 ms test budget came out with a
     * 300-second grace. Otherwise the MEASUREMENT, which is the whole idea.
     * Failing both, {@link #IMPLIED_P50_MS}, so an unmeasured backend's queue is
     * priced by what backends have shown rather than with a zero allowance. A
     * zero would make grace == budget and put the clock back where the literal
     * had it. The operator's floor is deliberately not used here: it says how
     * long a child may work, not how long this backend takes to answer. Since
     * card 372 this feeds {@link #firstTokenGraceMs()} alone; the run budget of
     * an unmeasured backend is the floor itself.</p>
     */
    private long p50OrImplied() {
        if (overrideMs != null) {
            return Math.max(1, overrideMs / P50_MULTIPLE);
        }
        return latency.p50Ms().orElse(IMPLIED_P50_MS);
    }
}
