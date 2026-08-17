package dev.spectroscope.core.subagents;

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
 *   implied p50    = {@link #FLOOR_MS} / {@link #P50_MULTIPLE}  — used while nothing
 *                    has been measured yet, so the floor stays self-consistent
 *   runBudget      = min({@link #CEILING_MS}, max({@link #FLOOR_MS}, {@link #P50_MULTIPLE} × p50))
 *   queueAllowance = ({@link SubagentManager#MAX_PARALLEL_CHILDREN} - 1) × p50
 *   grace          = min({@link #GRACE_CEILING_MS}, runBudget + queueAllowance)
 *   worst case     = grace + runBudget          — the clocks run in SEQUENCE
 * </pre>
 *
 * <p>Worked, on the numbers above: p50 = 92,200 ms, so 3 × p50 = 276,600 ms and
 * the floor governs — runBudget = <b>300,000 ms</b>, two and a half times the
 * literal it replaces and still under the observed maximum exchange. The queue
 * allowance is 3 × 92,200 = 276,600 ms, so grace = <b>576,600 ms</b>. On a
 * hosted backend with a p50 of two seconds the floor governs both and a child
 * gets the same 300 s; the p50 term only bites on slow backends, which is where
 * the defect was. At p50 = 200 s the budget is 600 s.</p>
 *
 * <p><b>The two clocks are sequential, so their ceilings compose.</b> The grace
 * is disarmed by the first token and the run budget armed at that same instant,
 * so a child that speaks just before its grace expires and then wedges costs
 * {@code grace + runBudget}. At both ceilings that is 45 + 30 = <b>75 min</b>,
 * and neither {@link #CEILING_MS} nor {@link #GRACE_CEILING_MS} is the number a
 * reader wants — {@link #worstCaseMs()} is, and it computes it rather than
 * restating it.</p>
 *
 * <p><b>An explicit override wins outright</b> ({@link #fixed}): a face or a test
 * that names a number gets that number, and the grace is derived from the
 * override's own implied p50 rather than from the measurement — an override is a
 * statement about this run, not a new estimate of the backend.</p>
 *
 * <p>{@link #FLOOR_MS}, {@link #P50_MULTIPLE} and the ceilings are the values
 * {@code konzept/ORCHESTRATION.md} §7 proposed. The concept files them as an
 * open OWNER decision (§9, item 5), so they are named here, in one place, with
 * their measurement beside them, rather than spread over the code.</p>
 */
public final class ChildBudget {

    /**
     * The smallest run budget any child gets, whatever the backend says: 300 s.
     * Two and a half times the literal it replaces, and above the 276.6 s that
     * 3 × the owner's measured p50 works out to — so on that backend the floor
     * is what actually governs.
     */
    public static final long FLOOR_MS = 300_000L;

    /** How many median exchanges a child may spend once it has started
     *  producing: three. A child that has had three median turns and is still
     *  going is not waiting, it is lost. */
    public static final int P50_MULTIPLE = 3;

    /**
     * The hard stop on a derived run budget: 30 min. Above the largest exchange
     * ever measured here (1,560.9 s = 26.0 min, HTTP 200), so a single real
     * exchange still fits inside it.
     *
     * <p><b>This bounds ONE of the two clocks, not the child.</b> The two run in
     * sequence — see {@link #worstCaseMs()} for what a child can actually hold
     * its requester for, which is more than this number.</p>
     */
    public static final long CEILING_MS = 1_800_000L;

    /** The hard stop on the queue grace: 45 min — the run ceiling plus one
     *  full wave of the same. Like {@link #CEILING_MS} it bounds its own clock
     *  only; {@link #worstCaseMs()} composes them. */
    public static final long GRACE_CEILING_MS = 2_700_000L;

    /** {@code run_end} stop reason of a child whose run budget ran out AFTER it
     *  had started producing. A new VALUE on an existing field: the RunEvent
     *  shape is untouched, and {@code LevelingFold}'s completed-run set is an
     *  allow-list, so a budget-exhausted child correctly reads as unfinished. */
    public static final String STOP_BUDGET_EXHAUSTED = "child_budget_exhausted";

    /** {@code run_end} stop reason of a child the backend never started on. */
    public static final String STOP_NO_FIRST_TOKEN = "child_no_first_token";

    private final ExchangeLatency latency;
    private final Long overrideMs;

    private ChildBudget(ExchangeLatency latency, Long overrideMs) {
        this.latency = latency;
        this.overrideMs = overrideMs;
    }

    /**
     * The production shape: derived from what this session has measured.
     *
     * @param latency the session's shared window — the parent's own exchanges
     *                and its children's both land in it
     * @return a budget that re-derives itself on every read
     */
    public static ChildBudget derivedFrom(ExchangeLatency latency) {
        return new ChildBudget(latency == null ? new ExchangeLatency() : latency, null);
    }

    /**
     * The explicit override, which wins over any measurement.
     *
     * @param runBudgetMs the run budget in milliseconds, counted from the
     *                    child's first token
     * @return a budget that ignores the backend and reports this number
     */
    public static ChildBudget fixed(long runBudgetMs) {
        return new ChildBudget(new ExchangeLatency(), runBudgetMs);
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
     * @return milliseconds; the override when one is set, else
     *         {@code min(CEILING, max(FLOOR, P50_MULTIPLE × p50))}
     */
    public long runBudgetMs() {
        if (overrideMs != null) {
            return overrideMs;
        }
        long p50 = p50OrImplied();
        return Math.min(CEILING_MS, Math.max(FLOOR_MS, P50_MULTIPLE * p50));
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
     * {@code grace + runBudget}. At both ceilings that is 45 + 30 = <b>75
     * min</b>, not the 30 that {@link #CEILING_MS} alone suggests — a reader who
     * takes the run ceiling for the child's cost is out by a factor of two and a
     * half.</p>
     *
     * <p>Nothing in the harness enforces this composed number; it is a fact
     * about the two clocks, exposed so it can be read and pinned instead of
     * recomputed in someone's head. Whether 75 min is an acceptable worst case
     * for one {@code spawn_agents} call is an open owner question, filed with
     * the other budget constants.</p>
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
     * <p>The sample size is {@link ExchangeLatency#sampleSize()}, never
     * {@link ExchangeLatency#observed()}: the median is taken over the ring, so
     * on a long session the raw counter names hundreds of exchanges that were
     * deliberately forgotten. A sentence written to justify a number must not
     * overstate the evidence behind it.</p>
     *
     * @return e.g. {@code "derived: max(300 s floor, 3 × 92 s measured p50 over
     *         9 exchanges)"}
     */
    public String derivation() {
        if (overrideMs != null) {
            return "explicit override: " + overrideMs / 1000 + " s";
        }
        OptionalLong measured = latency.p50Ms();
        if (measured.isEmpty()) {
            return "derived: " + FLOOR_MS / 1000 + " s floor (nothing measured on this backend yet)";
        }
        return "derived: max(" + FLOOR_MS / 1000 + " s floor, " + P50_MULTIPLE + " × "
                + measured.orElseThrow() / 1000 + " s measured p50 over "
                + latency.sampleSize() + " exchanges)";
    }

    /**
     * The p50 the queue allowance is built on.
     *
     * <p>Three sources, and the order is the point. An OVERRIDE implies its own
     * p50 ({@code override / P50_MULTIPLE}): a face or a test that says "a child
     * gets 45 s" means a small run, and inheriting the floor's implied 100 s
     * queue allowance there would make the grace a hundred times the budget — the
     * first version of this method did exactly that, and a 300 ms test budget
     * came out with a 300-second grace. Otherwise the MEASUREMENT, which is the
     * whole idea. Failing both, the p50 the floor stands on, so an unmeasured
     * backend is priced consistently with the floor rather than with a zero
     * allowance — a zero would make grace == budget and put the clock back where
     * the literal had it.</p>
     */
    private long p50OrImplied() {
        if (overrideMs != null) {
            return Math.max(1, overrideMs / P50_MULTIPLE);
        }
        return latency.p50Ms().orElse(FLOOR_MS / P50_MULTIPLE);
    }
}
