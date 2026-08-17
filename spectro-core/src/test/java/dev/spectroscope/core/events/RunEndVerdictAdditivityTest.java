package dev.spectroscope.core.events;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.PlanVerdict;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 264 puts a fifth value on {@code run_end.stopReason} and NOT a fifth
 * field: the record keeps the three keys it has had since v0.1.0, so a
 * {@code run_end} line written by this build is byte-identical in shape to one
 * written by any earlier one, and a session file recorded before this card
 * replays with no verdict and no crash.
 *
 * <p>Additive the way {@code @JsonIgnoreProperties(ignoreUnknown = true)}
 * (RunEvent.java:35) intends: an old reader that has never heard of
 * {@code unfinished} reads it as the string it is, and every reader that
 * switches on the value falls through to its "not a clean finish" branch —
 * which is the honest default and the whole point of the card.</p>
 */
class RunEndVerdictAdditivityTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @Test
    void theVerdictRidesTheFieldThatAlwaysExisted() throws Exception {
        String line = JSON.writeValueAsString(
                new RunEvent.RunEnd("r1", PlanVerdict.UNFINISHED_STOP_REASON, 42L));
        assertEquals("{\"type\":\"run_end\",\"runId\":\"r1\",\"stopReason\":\"unfinished\",\"ts\":42}",
                line, "three keys, in the order the wire has always had them");
        RunEvent.RunEnd back = (RunEvent.RunEnd) JSON.readValue(line, RunEvent.class);
        assertEquals("unfinished", back.stopReason());
    }

    @Test
    void aLineWrittenBeforeThisCardStillParsesUnchanged() throws Exception {
        String old = "{\"type\":\"run_end\",\"runId\":\"r0\",\"stopReason\":\"end_turn\",\"ts\":7}";
        RunEvent.RunEnd back = (RunEvent.RunEnd) JSON.readValue(old, RunEvent.class);
        assertEquals("end_turn", back.stopReason());
        assertEquals(7L, back.ts());
        assertEquals(old, JSON.writeValueAsString(back), "re-serializes byte-identically");
    }

    @Test
    void aFutureStopReasonIsStillJustAString() throws Exception {
        // The field was never an enum on the wire, which is exactly why the
        // verdict could travel on it. A value from a later build must reach a
        // reader intact rather than blow up the whole line.
        String fromTheFuture =
                "{\"type\":\"run_end\",\"runId\":\"r2\",\"stopReason\":\"continued\",\"ts\":9}";
        assertEquals("continued",
                ((RunEvent.RunEnd) JSON.readValue(fromTheFuture, RunEvent.class)).stopReason());
    }

    @Test
    void thePlanLineTheVerdictReadsIsUnchangedToo() throws Exception {
        // The ledger itself gains nothing from this card: the verdict is a
        // READER of the plan event, so the plan wire stays where card 141 left it.
        String line = JSON.writeValueAsString(new RunEvent.Plan("main",
                java.util.List.of(new RunEvent.PlanStep("write the test", "pending")), 3L));
        assertTrue(line.contains("\"type\":\"plan\""), line);
        assertEquals("{\"type\":\"plan\",\"agentId\":\"main\",\"steps\":"
                + "[{\"text\":\"write the test\",\"status\":\"pending\"}],\"ts\":3}", line);
    }
}
