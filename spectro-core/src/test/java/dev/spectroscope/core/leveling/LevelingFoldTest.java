package dev.spectroscope.core.leveling;

import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import dev.spectroscope.core.events.RunEvent;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The fold is the whole truth claim of the wave: a criterion ticks because the
 * evidence says so, never because someone asserted it. It is pure — no I/O, no
 * clock of its own — so every rule below is a table, and the awkward cases
 * (replays, sentinels, hand ticks, joins) are pinned rather than argued about.
 */
class LevelingFoldTest {

    private static final Ladder LADDER = Ladder.bundled();
    private static final String S1 = "20260726-aaa";
    private static final String S2 = "20260726-bbb";

    private static LevelingState fresh() {
        return LevelingState.fresh(LevelingState.Mode.LADDER);
    }

    private static RunEvent end(String reason) {
        return new RunEvent.RunEnd("run-1", reason, 1000L);
    }

    private static RunEvent toolCall(String agent) {
        return new RunEvent.ToolCall(agent, "call-1", "read_file", JsonNodeFactory.instance.objectNode(), 900L);
    }

    // ── the stream side ────────────────────────────────────────────────────

    @Test
    void aFinishedRunMarksFirstRunComplete() {
        LevelingState after = LevelingFold.observe(LADDER, fresh(), S1, 7, end("end_turn"));
        LevelingState.Mark mark = after.marks().get("first-run-complete");
        assertNotNull(mark);
        assertEquals(S1, mark.sessionId());
        assertEquals(7, mark.eventIndex().intValue());
        assertEquals(1000L, mark.ts());
        assertEquals(LevelingState.Origin.OBSERVED, mark.origin());
    }

    @Test
    void aFinishedRunAlsoProvesTheProviderWasReady() {
        // provider-ready is the rung below, and a run that came back is the strongest
        // possible report that a provider answered. Without this, a home that went
        // straight to work would sit in the dark frame forever with a completed run
        // on the record, which is the ladder calling its own operator a liar.
        LevelingState after = LevelingFold.observe(LADDER, fresh(), S1, 3, end("end_turn"));
        assertNotNull(after.marks().get("provider-ready"));
        assertEquals(LevelingState.Origin.OBSERVED, after.marks().get("provider-ready").origin());
        assertEquals(1, after.level(LADDER), "the run carried the home out of the dark frame");
    }

    @Test
    void aFailedRunProvesNothingAboutTheProvider() {
        LevelingState after = LevelingFold.observe(LADDER, fresh(), S1, 3, end("error"));
        assertNull(after.marks().get("provider-ready"));
    }

    @Test
    void anAbortedOrFailedRunMarksNothing() {
        for (String reason : new String[] {"aborted", "error"}) {
            LevelingState after = LevelingFold.observe(LADDER, fresh(), S1, 3, end(reason));
            assertNull(after.marks().get("first-run-complete"), reason + " is not a completed run");
        }
    }

    @Test
    void streamSentinelsAreNotRuns() {
        // EventStream.END and MergedEventStream.END_OF_STREAM are RunEnd records used as
        // in-band terminators. If they ever reach a port they must not fake first light.
        for (String reason : new String[] {"__sentinel__", "__end__"}) {
            LevelingState after = LevelingFold.observe(LADDER, fresh(), S1, 0, end(reason));
            assertNull(after.marks().get("first-run-complete"), reason + " is a sentinel, not a run");
        }
    }

    @Test
    void theFirstEvidenceWinsSoReplaysCannotDoubleCredit() {
        LevelingState once = LevelingFold.observe(LADDER, fresh(), S1, 7, end("end_turn"));
        LevelingState twice = LevelingFold.observe(LADDER, once, S2, 99, end("end_turn"));
        assertEquals(S1, twice.marks().get("first-run-complete").sessionId(), "the first run stays the receipt");
        assertEquals(once.history().size(), twice.history().size(), "a re-mark is not a second level-up");
    }

    @Test
    void anUnknownStopReasonIsNotTreatedAsSuccess() {
        LevelingState after = LevelingFold.observe(LADDER, fresh(), S1, 1, end("teleported"));
        assertNull(after.marks().get("first-run-complete"), "only known good stop reasons count");
    }

    // ── the beacon side ────────────────────────────────────────────────────

    @Test
    void aBeaconMarksItsCriterion() {
        LevelingState after = LevelingFold.visit(LADDER, fresh(), "replay", S1, 2000L);
        LevelingState.Mark mark = after.marks().get("replay-scrubbed");
        assertNotNull(mark);
        assertEquals(LevelingState.Origin.OBSERVED, mark.origin());
        assertEquals(2000L, mark.ts());
    }

    @Test
    void anUnknownSurfaceChangesNothing() {
        LevelingState before = fresh();
        assertSame(before, LevelingFold.visit(LADDER, before, "teapot", S1, 1L));
    }

    // ── the join: a beacon that needs the stream to agree ──────────────────

    @Test
    void traceOpenedNeedsASessionThatActuallyRanATool() {
        LevelingState bare = LevelingFold.visit(LADDER, fresh(), "trace", S1, 1L);
        assertNull(bare.marks().get("trace-opened"), "a trace of nothing proves nothing");

        LevelingState withTool = LevelingFold.observe(LADDER, fresh(), S1, 2, toolCall("main"));
        LevelingState joined = LevelingFold.visit(LADDER, withTool, "trace", S1, 5L);
        assertNotNull(joined.marks().get("trace-opened"));
        assertEquals(S1, joined.marks().get("trace-opened").sessionId());
    }

    @Test
    void aBeaconThatArrivesBeforeTheProofIsRedeemedLater() {
        // Watching a run live is the normal case: the trace tab is open before the
        // agent calls its first tool. If the beacon were dropped for arriving early,
        // the most attentive user would be the one the ladder never credits.
        LevelingState watching = LevelingFold.visit(LADDER, fresh(), "trace", S1, 1L);
        assertNull(watching.marks().get("trace-opened"), "nothing to see yet");

        LevelingState acted = LevelingFold.observe(LADDER, watching, S1, 3, toolCall("main"));
        assertNotNull(acted.marks().get("trace-opened"), "the tool call redeems the earlier look");
        assertEquals(S1, acted.marks().get("trace-opened").sessionId());
    }

    @Test
    void anEarlyBeaconOnlyRedeemsForItsOwnSession() {
        LevelingState watching = LevelingFold.visit(LADDER, fresh(), "trace", S1, 1L);
        LevelingState elsewhere = LevelingFold.observe(LADDER, watching, S2, 3, toolCall("main"));
        assertNull(elsewhere.marks().get("trace-opened"), "S2's tool call is not S1's evidence");
    }

    @Test
    void theJoinIsPerSessionNotGlobal() {
        LevelingState withTool = LevelingFold.observe(LADDER, fresh(), S1, 2, toolCall("main"));
        LevelingState other = LevelingFold.visit(LADDER, withTool, "trace", S2, 5L);
        assertNull(other.marks().get("trace-opened"), "S2 has no tool call of its own");
    }

    @Test
    void fanoutNeedsTwoAgentsInThatSession() {
        LevelingState one = LevelingFold.observe(LADDER, fresh(), S1, 1,
                new RunEvent.RunStart("run-1", "main", null, "go", null, null, null, 1L));
        LevelingState stillOne = LevelingFold.visit(LADDER, one, "spectrum", S1, 9L);
        assertNull(stillOne.marks().get("fanout-watched"), "one agent is not a fan-out");

        LevelingState two = LevelingFold.observe(LADDER, one, S1, 2,
                new RunEvent.AgentSpawn("worker", "main", "review", 2L));
        LevelingState marked = LevelingFold.visit(LADDER, two, "spectrum", S1, 9L);
        assertNotNull(marked.marks().get("fanout-watched"));
    }

    // ── hand ticks stay honest ─────────────────────────────────────────────

    @Test
    void aFaceThatCountedTwoAgentsSettlesTheFanoutItself() {
        // A scenario runs wholly in the browser and never reaches a tracing port,
        // so the server has no facts for it — but watching a scripted fan-out is
        // exactly the act the criterion names, and the concept says it counts.
        LevelingState watched = LevelingFold.visit(LADDER, fresh(), "spectrum", "scenario:fanout", 5L, 3);
        assertNotNull(watched.marks().get("fanout-watched"));
    }

    @Test
    void oneAgentOnScreenIsStillNotAFanout() {
        LevelingState single = LevelingFold.visit(LADDER, fresh(), "spectrum", "scenario:solo", 5L, 1);
        assertNull(single.marks().get("fanout-watched"));
    }

    @Test
    void aHandTickIsMarkedAsManual() {
        LevelingState after = LevelingFold.tick(LADDER, fresh(), "lens-used", 42L);
        LevelingState.Mark mark = after.marks().get("lens-used");
        assertNotNull(mark);
        assertEquals(LevelingState.Origin.MANUAL, mark.origin());
        assertNull(mark.sessionId(), "a hand tick has no session to point at");
    }

    @Test
    void aHandTickCountsForTheLevelExactlyLikeAnObservedOne() {
        LevelingState after = LevelingFold.tick(LADDER, fresh(), "provider-ready", 1L);
        assertEquals(1, after.level(LADDER), "manual evidence still moves the ladder");
    }

    @Test
    void anObservedMarkNeverDegradesToManual() {
        LevelingState observed = LevelingFold.visit(LADDER, fresh(), "lens", S1, 1L);
        LevelingState ticked = LevelingFold.tick(LADDER, observed, "lens-used", 2L);
        assertEquals(LevelingState.Origin.OBSERVED, ticked.marks().get("lens-used").origin());
    }

    @Test
    void anUnknownCriterionCannotBeTicked() {
        LevelingState before = fresh();
        assertSame(before, LevelingFold.tick(LADDER, before, "become-admin", 1L));
    }

    // ── levels and history ─────────────────────────────────────────────────

    @Test
    void theLadderClimbsOnlyWhenEveryCriterionOfTheRungIsMet() {
        LevelingState s = LevelingFold.tick(LADDER, fresh(), "provider-ready", 1L);
        assertEquals(1, s.level(LADDER));
        s = LevelingFold.tick(LADDER, s, "first-run-complete", 2L);
        assertEquals(1, s.level(LADDER), "first light needs both of its criteria");
        s = LevelingFold.tick(LADDER, s, "session-reopened", 3L);
        assertEquals(2, s.level(LADDER));
    }

    @Test
    void everyLevelUpLandsInTheHistoryOnce() {
        LevelingState s = LevelingFold.tick(LADDER, fresh(), "provider-ready", 10L);
        assertEquals(1, s.history().size());
        assertEquals(1, s.history().get(0).level());
        assertEquals(10L, s.history().get(0).ts());
        s = LevelingFold.tick(LADDER, s, "provider-ready", 11L);
        assertEquals(1, s.history().size(), "re-ticking does not re-celebrate");
    }

    @Test
    void masteryCriteriaCompleteTheBadgeButMoveNobody() {
        LevelingState s = fresh();
        for (String id : new String[] {"explain-run", "session-imported", "starter-scaffolded"}) {
            s = LevelingFold.tick(LADDER, s, id, 1L);
        }
        assertEquals(0, s.level(LADDER), "mastery gates nothing and lifts nothing");
        assertEquals(3, s.marks().size());
    }

    // ── the off switch ─────────────────────────────────────────────────────

    @Test
    void modeOffObservesNothingAtAll() {
        LevelingState off = LevelingState.fresh(LevelingState.Mode.OFF);
        assertSame(off, LevelingFold.observe(LADDER, off, S1, 1, end("end_turn")));
        assertSame(off, LevelingFold.visit(LADDER, off, "replay", S1, 1L));
        assertSame(off, LevelingFold.tick(LADDER, off, "lens-used", 1L));
    }

    @Test
    void checklistModeStillTracks() {
        LevelingState list = LevelingState.fresh(LevelingState.Mode.CHECKLIST);
        LevelingState after = LevelingFold.observe(LADDER, list, S1, 1, end("end_turn"));
        assertNotNull(after.marks().get("first-run-complete"), "checklist celebrates, it just never locks");
    }

    // ── bounded memory ─────────────────────────────────────────────────────

    @Test
    void sessionFactsStayBounded() {
        LevelingState s = fresh();
        for (int i = 0; i < 500; i++) {
            s = LevelingFold.observe(LADDER, s, "session-" + i, 1, toolCall("main"));
        }
        assertTrue(s.facts().size() <= LevelingFold.MAX_TRACKED_SESSIONS,
                "the fold remembers recent sessions, not every session ever");
        assertFalse(s.facts().isEmpty());
    }

    @Test
    void factsAreDroppedOnceNoJoinNeedsThem() {
        LevelingState s = LevelingFold.observe(LADDER, fresh(), S1, 1, toolCall("main"));
        s = LevelingFold.visit(LADDER, s, "trace", S1, 2L);
        s = LevelingFold.observe(LADDER, s, S1, 2, new RunEvent.AgentSpawn("w", "main", "t", 3L));
        s = LevelingFold.visit(LADDER, s, "spectrum", S1, 4L);
        assertTrue(s.facts().isEmpty(), "both joins are settled, the bookkeeping is dead weight");
    }
}
