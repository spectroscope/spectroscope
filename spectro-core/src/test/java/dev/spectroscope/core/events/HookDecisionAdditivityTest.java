package dev.spectroscope.core.events;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 195: what a hook did becomes a line of the session.
 *
 * <p>The same argument cards 184 and 204 made for their own lines, with a
 * sharper edge. A {@code pre_tool_use} hook can stop a tool call outright, and
 * until this event the only record of that was the {@code ERROR:} string handed
 * to the model — which carries a reason and names no hook. A hook the deadline
 * killed left no record whatever: {@code HookRunner} fails open, so the call
 * simply proceeded, and the run said the same thing it says when every guard
 * agreed.
 *
 * <p>Additive on the card-72/184/204 precedent: nothing about an existing line
 * moves, and a reader that has never heard of this type must survive it.
 */
class HookDecisionAdditivityTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private RunEvent.HookDecision blocked() {
        return new RunEvent.HookDecision("main", "toolu_01", "run_command", "pre_tool_use",
                "run_*", "guard.sh", 10L, "blocked", "no writes outside the workspace", 99L);
    }

    @Test
    void itRoundTripsThroughTheWire() throws Exception {
        String line = JSON.writeValueAsString(blocked());
        RunEvent.HookDecision back = (RunEvent.HookDecision) JSON.readValue(line, RunEvent.class);
        assertEquals(blocked(), back, "the record is the contract; a lossy field is a lost fact");
        assertTrue(line.contains("\"type\":\"hook_decision\""), line);
    }

    @Test
    void theCallIdIsWhatJoinsTheDecisionToTheCallItRefused() throws Exception {
        // Without it the row is a floating assertion that SOMETHING was blocked.
        // With it, the trace can put the refusal beside the tool_call it stopped
        // and the ERROR tool_result the model got instead.
        assertTrue(JSON.writeValueAsString(blocked()).contains("\"callId\":\"toolu_01\""));
    }

    @Test
    void aTimedOutHookCarriesNoReasonRatherThanAnEmptyOne() throws Exception {
        RunEvent.HookDecision timedOut = new RunEvent.HookDecision("main", "toolu_02", "write_file",
                "post_tool_use", "*", "notify.sh", 4L, "timed-out", null, 100L);
        String line = JSON.writeValueAsString(timedOut);
        // A killed process stated nothing. An empty string here would read as a
        // hook that answered and had nothing to say, which is a different fact.
        assertFalse(line.contains("reason"), line);
        assertNull(((RunEvent.HookDecision) JSON.readValue(line, RunEvent.class)).reason());
        assertTrue(line.contains("\"verdict\":\"timed-out\""), line);
    }

    @Test
    void anOlderLineOfEveryOtherTypeStillParses() throws Exception {
        String old = "{\"type\":\"turn_start\",\"agentId\":\"main\",\"turn\":1,\"ts\":5}";
        assertEquals(1, ((RunEvent.TurnStart) JSON.readValue(old, RunEvent.class)).turn());
    }

    @Test
    void aReaderSurvivesFieldsItDoesNotKnow() throws Exception {
        String fromTheFuture = "{\"type\":\"hook_decision\",\"agentId\":\"main\","
                + "\"callId\":\"toolu_9\",\"toolName\":\"run_command\",\"event\":\"pre_tool_use\","
                + "\"matcher\":\"*\",\"command\":\"guard.sh\",\"timeoutSeconds\":10,"
                + "\"verdict\":\"blocked\",\"ts\":1,\"somethingNobodyHasBuiltYet\":true}";
        RunEvent.HookDecision read =
                (RunEvent.HookDecision) JSON.readValue(fromTheFuture, RunEvent.class);
        assertEquals("guard.sh", read.command());
        assertEquals("blocked", read.verdict());
    }
}
