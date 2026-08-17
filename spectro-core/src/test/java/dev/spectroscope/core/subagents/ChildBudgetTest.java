package dev.spectroscope.core.subagents;

import dev.spectroscope.core.provider.ExchangeLatency;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 270, criterion 1: the per-child budget is DERIVED, and it is derived from
 * the numbers the card carries rather than from a fresh guess.
 *
 * <p>The measurement these tests are written against, so the next reader does
 * not have to go looking: backend lmstudio /
 * {@code deepseek-v4-flash-0731@iq1_m}, baseline session of
 * {@code konzept/ORCHESTRATION.md} §7 — 18 exchanges, median <b>92.2 s</b>,
 * maximum <b>1,560.9 s</b>, and 7 of the 15 chat exchanges longer than the
 * 120,000 ms literal that was supposed to bound a child's WHOLE run.</p>
 */
class ChildBudgetTest {

    /** The owner's measured median, in the unit the code works in. */
    private static final long MEASURED_P50_MS = 92_200L;

    /** The literal this card removed. */
    private static final long OLD_LITERAL_MS = 120_000L;

    private static ExchangeLatency measuring(long... durationsMs) {
        ExchangeLatency latency = new ExchangeLatency();
        for (long duration : durationsMs) {
            latency.observe(duration);
        }
        return latency;
    }

    @Test
    void onTheOwnersOwnBackendTheBudgetClearsTheLiteralItReplaces() {
        ExchangeLatency latency = measuring(
                MEASURED_P50_MS, MEASURED_P50_MS, MEASURED_P50_MS, MEASURED_P50_MS, MEASURED_P50_MS);
        ChildBudget budget = ChildBudget.derivedFrom(latency);

        assertEquals(MEASURED_P50_MS, budget.observedP50Ms().orElseThrow());
        // 3 x 92.2 s = 276.6 s, so the 300 s floor governs — the worked example
        // in ChildBudget's own javadoc, asserted rather than asserted-about.
        assertEquals(ChildBudget.FLOOR_MS, budget.runBudgetMs());
        assertTrue(budget.runBudgetMs() > OLD_LITERAL_MS,
                "the whole point: " + budget.runBudgetMs() + " must beat " + OLD_LITERAL_MS);
        // The queue grace adds the wait behind the other three children of a
        // four-wide wave: 300 s + 3 x 92.2 s = 576.6 s.
        assertEquals(ChildBudget.FLOOR_MS + 3 * MEASURED_P50_MS, budget.firstTokenGraceMs());
    }

    @Test
    void onASlowBackendThePFiftyTermGovernsInsteadOfTheFloor() {
        ChildBudget budget = ChildBudget.derivedFrom(measuring(200_000, 200_000, 200_000));

        assertEquals(600_000L, budget.runBudgetMs(), "3 x 200 s, above the 300 s floor");
        assertEquals(600_000L + 3 * 200_000L, budget.firstTokenGraceMs());
    }

    @Test
    void onAFastHostedBackendTheFloorGovernsAndAChildStillGetsFiveMinutes() {
        ChildBudget budget = ChildBudget.derivedFrom(measuring(1_800, 2_100, 1_500));

        assertEquals(ChildBudget.FLOOR_MS, budget.runBudgetMs());
        assertEquals(ChildBudget.FLOOR_MS + 3 * 1_800L, budget.firstTokenGraceMs());
    }

    @Test
    void aPathologicalBackendIsCappedByBothCeilings() {
        // One 40-minute exchange repeated: 3 x that is two hours, and both caps
        // bite. The run ceiling is above the largest exchange ever measured here
        // (1,560.9 s), so a real one still fits inside it.
        ChildBudget budget = ChildBudget.derivedFrom(
                measuring(2_400_000, 2_400_000, 2_400_000));

        assertEquals(ChildBudget.CEILING_MS, budget.runBudgetMs());
        assertEquals(ChildBudget.GRACE_CEILING_MS, budget.firstTokenGraceMs());
    }

    /**
     * The clocks are SEQUENTIAL, and the ceilings therefore compose.
     *
     * <p>This replaces a test that used to be called "a pathological backend
     * cannot hand one child an hour of its parent's turn". The name was the
     * claim, and the claim was wrong: the grace is armed at the spawn and
     * DISARMED by the first token, at which instant the run budget is armed for
     * its full length. A child that speaks one millisecond before its grace
     * expires holds its requester for both clocks — 45 min + 30 min = 75 min,
     * not 30. Whoever reads the ceiling next should read the composed number
     * from the code rather than add two constants in their head.</p>
     */
    @Test
    void theClocksAreSequentialSoTheWorstCaseIsBothCeilingsNotOne() {
        ChildBudget budget = ChildBudget.derivedFrom(
                measuring(2_400_000, 2_400_000, 2_400_000));

        assertEquals(ChildBudget.GRACE_CEILING_MS + ChildBudget.CEILING_MS,
                budget.worstCaseMs(),
                "grace runs first, then the whole run budget on top of it");
        assertEquals(75, budget.worstCaseMs() / 60_000,
                "the real worst case one child can hold its requester for, in minutes");
        assertTrue(budget.worstCaseMs() > ChildBudget.CEILING_MS,
                "the run ceiling alone is not the answer — that was the false claim");
    }

    @Test
    void theWorstCaseOfAnOrdinaryChildIsTheGraceItWaitedPlusItsBudget() {
        // Not just the pathological case: the composition holds wherever the
        // ceilings do not bite. On the owner's own backend that is 576.6 s of
        // grace plus 300 s of run budget.
        ChildBudget budget = ChildBudget.derivedFrom(measuring(MEASURED_P50_MS, MEASURED_P50_MS));

        assertEquals(budget.firstTokenGraceMs() + budget.runBudgetMs(), budget.worstCaseMs());
        assertEquals(ChildBudget.FLOOR_MS + 3 * MEASURED_P50_MS + ChildBudget.FLOOR_MS,
                budget.worstCaseMs());
    }

    @Test
    void withNothingMeasuredTheFloorGovernsAndTheGraceStaysSelfConsistent() {
        ChildBudget budget = ChildBudget.derivedFrom(new ExchangeLatency());

        assertTrue(budget.observedP50Ms().isEmpty());
        assertEquals(ChildBudget.FLOOR_MS, budget.runBudgetMs());
        // The implied p50 is the one the floor stands on (300 s / 3 = 100 s), so
        // an unmeasured backend is priced consistently rather than with a zero
        // queue allowance — which would have made the grace equal the budget and
        // put the clock back where the literal had it.
        assertEquals(ChildBudget.FLOOR_MS + 3 * (ChildBudget.FLOOR_MS / 3),
                budget.firstTokenGraceMs());
        assertTrue(budget.derivation().contains("nothing measured"), budget.derivation());
    }

    @Test
    void anExplicitOverrideWinsOverEveryMeasurement() {
        ExchangeLatency latency = measuring(200_000, 200_000, 200_000);
        ChildBudget derived = ChildBudget.derivedFrom(latency);
        assertEquals(600_000L, derived.runBudgetMs(), "test premise: measurement would say 600 s");

        ChildBudget override = ChildBudget.fixed(45_000);
        assertTrue(override.isOverridden());
        assertEquals(45_000L, override.runBudgetMs());
        assertTrue(override.derivation().contains("explicit override"), override.derivation());
    }

    @Test
    void theDerivationSaysWhereItsNumberCameFrom() {
        ChildBudget budget = ChildBudget.derivedFrom(measuring(92_200, 92_200, 92_200));

        // A budget that cannot say this is the literal again, wearing a method —
        // and this string is what a child that ran out hands its requester.
        assertEquals("derived: max(300 s floor, 3 × 92 s measured p50 over 3 exchanges)",
                budget.derivation());
    }

    /**
     * The sentence a timed-out child hands its requester must name the sample
     * size the median was ACTUALLY taken over.
     *
     * <p>{@code p50Ms()} sorts at most {@link ExchangeLatency#WINDOW} entries,
     * because that is all the ring holds. {@code observed()} counts every
     * exchange the session ever had. Interpolating the second while reporting
     * the first is a claim about evidence that does not exist — on a long
     * session the child would say "median over 340 exchanges" when 16 were
     * weighed, and the 324 it names are exactly the ones the window forgot on
     * purpose.</p>
     */
    @Test
    void theDerivationNamesTheSampleSizeItWeighedNotEveryExchangeEverSeen() {
        ExchangeLatency latency = new ExchangeLatency();
        for (int i = 0; i < ExchangeLatency.WINDOW + 7; i++) {
            latency.observe(MEASURED_P50_MS);
        }

        assertEquals(ExchangeLatency.WINDOW + 7, latency.observed(),
                "test premise: more exchanges happened than the window can hold");
        assertEquals(ExchangeLatency.WINDOW, latency.sampleSize(),
                "and the median can only have been taken over what the ring still holds");
        assertEquals("derived: max(300 s floor, 3 × 92 s measured p50 over 16 exchanges)",
                ChildBudget.derivedFrom(latency).derivation(),
                "the sentence must not claim 23 samples it did not weigh");
    }

    @Test
    void belowTheWindowTheSampleSizeIsSimplyEveryExchange() {
        ExchangeLatency latency = measuring(92_200, 92_200, 92_200);

        assertEquals(3, latency.observed());
        assertEquals(3, latency.sampleSize(), "nothing has been forgotten yet");
    }

    @Test
    void theMedianIsTakenOverTheRecentWindowSoASwappedBackendIsRepriced() {
        ExchangeLatency latency = new ExchangeLatency();
        for (int i = 0; i < ExchangeLatency.WINDOW; i++) {
            latency.observe(200_000);            // the slow local model
        }
        assertEquals(200_000L, latency.p50Ms().orElseThrow());

        for (int i = 0; i < ExchangeLatency.WINDOW; i++) {
            latency.observe(2_000);              // the operator switched to a hosted one
        }
        assertEquals(2_000L, latency.p50Ms().orElseThrow(),
                "a window that remembered the old backend would price a child on a "
                        + "machine this session is not talking to any more");
    }

    @Test
    void anAbortedOrZeroExchangeIsNotAMeasurement() {
        ExchangeLatency latency = measuring(0, -1, 5_000);

        assertEquals(1, latency.observed());
        assertEquals(5_000L, latency.p50Ms().orElseThrow());
    }
}
