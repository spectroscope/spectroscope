package dev.spectroscope.core.events;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 473, round three: a session names the files beside it in its
 * {@code run_start}, as three optional fields (llmWire, browserWire,
 * children), so an import on another machine knows which wire belongs to the
 * session. No new line and no new event type: a reader that does not know the
 * fields reads the line it always read.
 */
class RunStartWireReferenceTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static RunEvent.RunStart plain() {
        return new RunEvent.RunStart("r1", "main", null, "hello", "ollama", "m", null, null, null, 5L);
    }

    @Test
    void aRunStartWithoutAReferenceWritesTheLineItAlwaysWrote() throws Exception {
        JsonNode node = JSON.readTree(JSON.writeValueAsString(plain()));
        assertFalse(node.has("llmWire"));
        assertFalse(node.has("browserWire"));
        assertFalse(node.has("children"), "no reference means no children field at all");
        assertNull(plain().children());
    }

    @Test
    void theReferenceRidesOnTheRunStartAndRoundTrips() throws Exception {
        RunEvent.RunStart stamped = plain().withWires("s1.llm.jsonl", null, List.of());
        assertEquals("hello", stamped.prompt(), "every other field is kept");
        assertEquals(5L, stamped.ts(), "the line keeps its own moment");

        String line = JSON.writeValueAsString(stamped);
        JsonNode node = JSON.readTree(line);
        assertEquals("run_start", node.path("type").asText());
        assertEquals("s1.llm.jsonl", node.path("llmWire").asText());
        // A browser wire that was never written is not named.
        assertFalse(node.has("browserWire"));
        // An empty child list is a fact ("this session names its files, and
        // has no child session files"), so it is written.
        assertTrue(node.path("children").isArray());
        assertEquals(0, node.path("children").size());
        assertEquals(stamped, JSON.readValue(line, RunEvent.class));
    }

    @Test
    void childrenKeepTheirOrderAndALineFromBeforeTheFieldsReadsAsNoReference() throws Exception {
        RunEvent.RunStart stamped = plain().withWires("s1.llm.jsonl", "s1.browser.jsonl", List.of("c2", "c1"));
        RunEvent back = JSON.readValue(JSON.writeValueAsString(stamped), RunEvent.class);
        assertEquals(List.of("c2", "c1"), ((RunEvent.RunStart) back).children());

        RunEvent old = JSON.readValue(
                "{\"type\":\"run_start\",\"runId\":\"r\",\"agentId\":\"main\",\"prompt\":\"p\",\"ts\":1}",
                RunEvent.class);
        RunEvent.RunStart start = (RunEvent.RunStart) old;
        assertNull(start.llmWire());
        assertNull(start.browserWire());
        assertNull(start.children());
    }
}
