package dev.spectroscope.core.events;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;

/**
 * Card 72 wire additivity: {@code run_start} grows an OPTIONAL trigger stamp
 * ("what woke this run"), following the provider/model precedent. The protocol
 * rules make two promises testable: a trigger-less run_start keeps its exact
 * pre-card-72 shape (absent stays absent on the wire), and a pre-card-72 line
 * still parses into the new record.
 */
class RunStartTriggerAdditivityTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @Test
    void aTriggerlessRunStartKeepsThePreCard72Shape() throws Exception {
        RunEvent event = new RunEvent.RunStart("r1", "main", null, "count files",
                "anthropic", "claude-opus-4-8", null, 1L); // pre-card-72 arity
        String line = JSON.writeValueAsString(event);
        assertFalse(line.contains("trigger"),
                "absent stays absent — an old reader sees the exact old bytes: " + line);
    }

    @Test
    void anOldRunStartLineStillParses() throws Exception {
        String old = "{\"type\":\"run_start\",\"runId\":\"r1\",\"agentId\":\"main\","
                + "\"prompt\":\"scan\",\"provider\":\"ollama\",\"ts\":5}";
        RunEvent.RunStart start = (RunEvent.RunStart) JSON.readValue(old, RunEvent.class);
        assertNull(start.trigger(), "a pre-card-72 line has no trigger — null, never a crash");
        assertEquals("scan", start.prompt());
    }

    @Test
    void aTriggerStampRoundTrips() throws Exception {
        RunEvent event = new RunEvent.RunStart("r2", "node-w", null, "scan the drop folder",
                "ollama", "qwen3", "fs #4 watch:/drop", null, 9L);
        String line = JSON.writeValueAsString(event);
        RunEvent.RunStart back = (RunEvent.RunStart) JSON.readValue(line, RunEvent.class);
        assertEquals("fs #4 watch:/drop", back.trigger());
        JsonNode node = JSON.readTree(line);
        assertEquals("run_start", node.path("type").asText(),
                "the discriminator is untouched by the additive field");
    }

    @Test
    void theLegacyAritiesStillConstructWithoutATrigger() {
        RunEvent.RunStart preModel = new RunEvent.RunStart("r", "main", null, "p",
                "anthropic", null, 1L);
        assertNull(preModel.model());
        assertNull(preModel.trigger());
        RunEvent.RunStart preTrigger = new RunEvent.RunStart("r", "main", null, "p",
                "anthropic", "m", null, 1L);
        assertEquals("m", preTrigger.model());
        assertNull(preTrigger.trigger());
    }
}
