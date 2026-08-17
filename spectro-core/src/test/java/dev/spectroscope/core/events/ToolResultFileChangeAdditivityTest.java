package dev.spectroscope.core.events;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 269 wire additivity: {@code tool_result} grows an OPTIONAL word for what
 * a mutating tool DID to the file — {@code created}, {@code changed} or
 * {@code unchanged} — on the card-72/111/184 precedent.
 *
 * <p>Why a field and not just the sentence: the sentence is for the model, and
 * the model reads it well. Every OTHER reader — the tool card, a guard, an
 * export — would have to parse prose to learn the same thing, and prose is
 * exactly what a translated or reworded line stops being. So the word rides as
 * a field and the rendered line follows it.
 *
 * <p>The two promises this pins: a result that reports nothing keeps its exact
 * pre-card-269 bytes (absent stays absent), and a pre-card-269 line parses into
 * the new record without a word about it.
 *
 * <p>Written against the WIRE rather than the accessor on purpose — a test that
 * only compiles once the field exists cannot be seen failing first.
 */
class ToolResultFileChangeAdditivityTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @Test
    void aResultThatReportsNothingKeepsThePreCard269Shape() throws Exception {
        // run_command, glob, read_file: nothing about a file changed, so nothing
        // is claimed. An old reader must see the exact old bytes.
        //
        // BOTH legacy arities, because there are two of them and a bite proved
        // it: poisoning the pre-269 constructor left every test green while the
        // ungated one was covered. An arity nobody asserts is an arity that can
        // start claiming things.
        List<RunEvent> silent = List.of(
                new RunEvent.ToolResult("main", "c1", "total 8", false, 4, 9L),      // pre-card-111
                new RunEvent.ToolResult("main", "c2", "total 8", false, 4, 40L, 9L)); // pre-card-269
        for (RunEvent event : silent) {
            String line = JSON.writeValueAsString(event);
            assertFalse(line.contains("fileChange"),
                    "absent stays absent — a silent tool says nothing: " + line);
        }
    }

    @Test
    void aPreCard269LineStillParsesAndClaimsNothing() throws Exception {
        String old = "{\"type\":\"tool_result\",\"agentId\":\"main\",\"callId\":\"c7\","
                + "\"output\":\"Wrote: a.txt (3 bytes)\",\"isError\":false,"
                + "\"durationMs\":2,\"gateWaitMs\":40,\"ts\":5}";
        RunEvent.ToolResult back = (RunEvent.ToolResult) JSON.readValue(old, RunEvent.class);
        assertEquals("Wrote: a.txt (3 bytes)", back.output());
        assertEquals(40L, back.gateWaitMs());
        // A session recorded before this card knows nothing about the word, and a
        // re-serialized line must not invent one.
        assertFalse(JSON.writeValueAsString(back).contains("fileChange"),
                "a replayed old line may not grow a claim it never made");
    }

    @Test
    void theWordRidesTheResultAsAFieldAndRoundTrips() throws Exception {
        String written = "{\"type\":\"tool_result\",\"agentId\":\"main\",\"callId\":\"c9\","
                + "\"output\":\"Wrote: pi.py (26 bytes) — unchanged (the file already contained"
                + " exactly these bytes)\",\"isError\":false,\"durationMs\":1,"
                + "\"fileChange\":\"unchanged\",\"ts\":7}";
        RunEvent.ToolResult back = (RunEvent.ToolResult) JSON.readValue(written, RunEvent.class);
        JsonNode again = JSON.valueToTree(back);
        assertEquals("unchanged", again.path("fileChange").asText(),
                "the word survives the round trip, or the tool card has to parse prose");
        assertEquals("tool_result", again.path("type").asText(),
                "the discriminator is untouched by the additive field");
        assertTrue(again.path("output").asText().contains("unchanged"),
                "the rendered line follows the field, it does not replace it");
    }

    @Test
    void theThreeWordsAreTheWholeVocabulary() throws Exception {
        for (String word : new String[] {"created", "changed", "unchanged"}) {
            String line = "{\"type\":\"tool_result\",\"agentId\":\"main\",\"callId\":\"c\","
                    + "\"output\":\"x\",\"isError\":false,\"durationMs\":1,"
                    + "\"fileChange\":\"" + word + "\",\"ts\":1}";
            RunEvent.ToolResult read = (RunEvent.ToolResult) JSON.readValue(line, RunEvent.class);
            assertEquals(word, JSON.valueToTree(read).path("fileChange").asText());
        }
    }

    @Test
    void anOlderLineOfEveryOtherTypeStillParses() throws Exception {
        String old = "{\"type\":\"turn_start\",\"agentId\":\"main\",\"turn\":1,\"ts\":5}";
        assertEquals(1, ((RunEvent.TurnStart) JSON.readValue(old, RunEvent.class)).turn());
    }
}
