package dev.spectroscope.core.events;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;

/**
 * Card 521: the window a run had is a fact of the run, so {@code run_start}
 * records it next to {@code provider} and {@code model}. Two optional fields,
 * {@code contextWindow} and {@code windowSource}; a window that is not known
 * is left off the line, as {@code context_info} leaves it off (card 366).
 */
class RunStartWindowTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static RunEvent.RunStart plain() {
        return new RunEvent.RunStart("r1", "main", null, "hello", "ollama", "glm-5.3:cloud",
                null, null, "/tmp/work", 5L);
    }

    @Test
    void aRunStartCarriesTheWindowAndItsSourceNextToTheModel() throws Exception {
        RunEvent.RunStart start = plain().withWindow(1_048_576, "model");

        String line = JSON.writeValueAsString(start);
        JsonNode node = JSON.readTree(line);
        assertEquals("glm-5.3:cloud", node.path("model").asText());
        assertEquals(1_048_576, node.path("contextWindow").asInt());
        assertEquals("model", node.path("windowSource").asText());
        assertEquals(start, JSON.readValue(line, RunEvent.class), "the line round-trips");
    }

    @Test
    void anUnknownWindowIsLeftOffTheLineAndItsSourceStays() throws Exception {
        RunEvent.RunStart start = plain().withWindow(0, "fallback");

        JsonNode node = JSON.readTree(JSON.writeValueAsString(start));
        assertFalse(node.has("contextWindow"), "a zero is not a window and is not written");
        assertEquals("fallback", node.path("windowSource").asText());
        assertNull(start.contextWindow());
    }

    @Test
    void aLineFromBeforeTheFieldsReadsAsNoWindow() throws Exception {
        RunEvent.RunStart old = (RunEvent.RunStart) JSON.readValue(
                "{\"type\":\"run_start\",\"runId\":\"r\",\"agentId\":\"main\",\"prompt\":\"p\","
                        + "\"provider\":\"ollama\",\"model\":\"m\",\"ts\":1}",
                RunEvent.class);
        assertNull(old.contextWindow());
        assertNull(old.windowSource());

        JsonNode node = JSON.readTree(JSON.writeValueAsString(plain()));
        assertFalse(node.has("contextWindow"), "a run_start built without a window writes the line it always wrote");
        assertFalse(node.has("windowSource"));
    }

    @Test
    void theWireReferenceKeepsTheWindow() {
        RunEvent.RunStart start = plain().withWindow(250_368, "window");

        RunEvent.RunStart referenced = start.withWires("s1.llm.jsonl", null, List.of());
        assertEquals(250_368, referenced.contextWindow());
        assertEquals("window", referenced.windowSource());
        assertEquals("/tmp/work", referenced.workspace(), "every other field is kept");
    }
}
