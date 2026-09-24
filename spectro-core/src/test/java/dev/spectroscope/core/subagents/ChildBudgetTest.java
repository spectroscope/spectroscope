package dev.spectroscope.core.subagents;

import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.provider.ExchangeLatency;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
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
 *
 * <p>Card 372 moved the floor out of the code and under the settings key
 * {@code subagentBudgetSeconds}, shipped at two hours. The floor is now an
 * input, so the numbers below are the shipped floor and the floors these cases
 * type, and the run ceiling caps the measured term only.</p>
 */
class ChildBudgetTest {

    /** The owner's measured median, in the unit the code works in. */
    private static final long MEASURED_P50_MS = 92_200L;

    /** The floor a child gets when the operator has typed no number. */
    private static final long SHIPPED_FLOOR_MS = SpectroConfig.DEFAULT_SUBAGENT_BUDGET_SECONDS * 1000L;

    private static ExchangeLatency measuring(long... durationsMs) {
        ExchangeLatency latency = new ExchangeLatency();
        for (long duration : durationsMs) {
            latency.observe(duration);
        }
        return latency;
    }

    @Test
    void onTheOwnersBackendTheShippedFloorGoverns() {
        ChildBudget budget = ChildBudget.derivedFrom(measuring(MEASURED_P50_MS, MEASURED_P50_MS));
        assertEquals(SHIPPED_FLOOR_MS, budget.runBudgetMs(), "2 h beats 3 x 92 s");
        assertEquals(ChildBudget.GRACE_CEILING_MS, budget.firstTokenGraceMs(),
                "the grace is the run budget plus the queue allowance, capped at 45 min");
    }

    @Test
    void aLowFloorLetsTheMeasuredTermGovernOnASlowBackend() {
        ChildBudget budget = ChildBudget.derivedFrom(measuring(200_000, 200_000, 200_000), 60_000L);
        assertEquals(600_000L, budget.runBudgetMs(), "3 x 200 s, above a 60 s floor");
        assertEquals(600_000L + 3 * 200_000L, budget.firstTokenGraceMs());
    }

    @Test
    void theFloorAnOperatorTypedIsNeverCappedByTheCeiling() {
        ChildBudget budget = ChildBudget.derivedFrom(measuring(1_800, 2_100, 1_500), 3_600_000L);
        assertEquals(3_600_000L, budget.runBudgetMs(),
                "before card 372 min(CEILING, ...) turned a typed 3600 s into 1800 s");
    }

    @Test
    void theMeasuredTermIsStillCappedAtTheCeiling() {
        ChildBudget budget = ChildBudget.derivedFrom(measuring(2_400_000, 2_400_000, 2_400_000), 60_000L);
        assertEquals(ChildBudget.CEILING_MS, budget.runBudgetMs(),
                "3 x 40 min is capped at 30 min; the cap is for the measurement, not the operator");
    }

    @Test
    void theWorstCaseIsTheGraceCeilingPlusTheFloor() {
        ChildBudget budget = ChildBudget.derivedFrom(measuring(2_400_000, 2_400_000, 2_400_000));
        assertEquals(ChildBudget.GRACE_CEILING_MS + SHIPPED_FLOOR_MS, budget.worstCaseMs());
        assertEquals(165, budget.worstCaseMs() / 60_000,
                "45 min of grace and then 120 min of run budget, in sequence");
    }

    @Test
    void withNothingMeasuredTheFloorGovernsAndTheImpliedPFiftyPricesTheQueue() {
        ChildBudget budget = ChildBudget.derivedFrom(new ExchangeLatency());
        assertTrue(budget.observedP50Ms().isEmpty());
        assertEquals(SHIPPED_FLOOR_MS, budget.runBudgetMs());
        assertEquals(Math.min(ChildBudget.GRACE_CEILING_MS, SHIPPED_FLOOR_MS + 3 * ChildBudget.IMPLIED_P50_MS),
                budget.firstTokenGraceMs());
    }

    @Test
    void anUnmeasuredBackendGetsTheFloorAndTheSentenceSaysSo() {
        ChildBudget budget = ChildBudget.derivedFrom(new ExchangeLatency(), 60_000L);

        assertEquals(60_000L, budget.runBudgetMs(),
                "nothing has been measured, so the floor is the whole answer");
        assertTrue(budget.derivation()
                        .contains("60 s floor (subagentBudgetSeconds), nothing measured"),
                budget.derivation());
    }

    @Test
    void theImpliedPFiftyPricesTheQueueOfAnUnmeasuredBackend() {
        ChildBudget budget = ChildBudget.derivedFrom(new ExchangeLatency(), 60_000L);

        assertEquals(60_000L, budget.runBudgetMs());
        // 60 s of run budget plus three implied medians of 100 s, well under the
        // 45 min grace ceiling. Written out, because a grace computed FROM the
        // constant would stay green whatever the constant becomes.
        assertEquals(360_000L, budget.firstTokenGraceMs());
    }

    @Test
    void aDerivedBudgetTakesTheFloorItIsHandedDown() {
        ChildBudget budget = ChildBudget.derivedFrom(measuring(1_800, 2_100, 1_500))
                .withFloorMs(3_600_000L);

        assertEquals(3_600_000L, budget.runBudgetMs(),
                "the floor the face handed down, not the shipped one");
        assertEquals(3_600_000L, budget.floorMs());
    }

    @Test
    void theWorstCaseComposesWhereNeitherClockSitsAtABound() {
        // The ordinary regime: a 300 s floor on the owner's own backend. Both
        // clocks are below their ceilings, so the composition is visible rather
        // than hidden behind a cap.
        ChildBudget budget = ChildBudget.derivedFrom(measuring(MEASURED_P50_MS, MEASURED_P50_MS),
                300_000L);

        assertEquals(300_000L, budget.runBudgetMs(), "3 x 92.2 s = 276.6 s, under the floor");
        assertEquals(576_600L, budget.firstTokenGraceMs(), "300 s plus three medians of 92.2 s");
        assertEquals(876_600L, budget.worstCaseMs(), "the grace first, then the whole run budget");
    }

    @Test
    void anExplicitOverrideWinsOverAnyFloor() {
        ChildBudget budget = ChildBudget.fixed(45_000L).withFloorMs(SHIPPED_FLOOR_MS);
        assertEquals(45_000L, budget.runBudgetMs());
        assertTrue(budget.isOverridden());
    }

    @Test
    void aNonPositiveFloorIsRefused() {
        assertThrows(IllegalArgumentException.class,
                () -> ChildBudget.derivedFrom(new ExchangeLatency(), 0L));
    }

    @Test
    void aNonPositiveFloorIsRefusedByTheBranchTheFacesTake() {
        // Both receivers, because they refuse on different lines. A derived
        // budget refuses inside derivedFrom, which the case above already
        // covers; an OVERRIDDEN one used to return itself before any check ran,
        // so only withFloorMs' own guard can refuse it. One case for both would
        // stay green with that guard deleted.
        IllegalArgumentException derived = assertThrows(IllegalArgumentException.class,
                () -> ChildBudget.derivedFrom(new ExchangeLatency()).withFloorMs(0L));
        IllegalArgumentException overridden = assertThrows(IllegalArgumentException.class,
                () -> ChildBudget.fixed(45_000L).withFloorMs(0L));

        assertTrue(derived.getMessage().contains("subagentBudgetSeconds"), derived.getMessage());
        assertTrue(overridden.getMessage().contains("subagentBudgetSeconds"),
                overridden.getMessage());
    }

    @Test
    void theDerivationNamesTheKeyThatMovesTheFloor() {
        ChildBudget budget = ChildBudget.derivedFrom(measuring(MEASURED_P50_MS, MEASURED_P50_MS));
        assertTrue(budget.derivation().contains("subagentBudgetSeconds"), budget.derivation());
        assertTrue(budget.derivation().contains("7200 s floor"), budget.derivation());
    }

    @Test
    void anExplicitOverrideWinsOverEveryMeasurement() {
        ExchangeLatency latency = measuring(200_000, 200_000, 200_000);
        ChildBudget derived = ChildBudget.derivedFrom(latency, 60_000L);
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
        assertEquals("derived: max(7200 s floor (subagentBudgetSeconds), "
                        + "min(1800 s ceiling, 3 × 92 s measured p50 over 3 exchanges))",
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
        assertEquals("derived: max(7200 s floor (subagentBudgetSeconds), "
                        + "min(1800 s ceiling, 3 × 92 s measured p50 over 16 exchanges))",
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
