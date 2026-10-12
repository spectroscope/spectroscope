package dev.spectroscope.core.playbook;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 506, criterion 1, fix round 1: the conversion pinned on the real
 * {@code fanout:} steps of {@code spectro-web/src/scenario/registry.ts}. The
 * fixture holds each of them as a workflow file of that step and an end;
 * {@code registryFanouts.drift.test.ts} holds the fixture to the registry.
 *
 * <p>What converts is the {@code fanout:} step, not a whole scenario: a
 * scenario's {@code id}, localized {@code name}, {@code prompt}, {@code fleet},
 * {@code phases} and its think and say steps are not workflow fields. A
 * fan-out wider than the spawn width ({@link WorkflowReader#MAX_AGENTS}) is
 * refused at load, and so is the agent field {@code subject}.</p>
 */
class WorkflowRegistryFanoutsTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static List<JsonNode> docs() throws IOException {
        try (InputStream in = WorkflowRegistryFanoutsTest.class.getResourceAsStream("/playbook/registry-fanouts.json")) {
            assertNotNull(in, "the fixture is on the test class path");
            List<JsonNode> out = new ArrayList<>();
            JSON.readTree(in).forEach(out::add);
            return out;
        }
    }

    @Test
    void everyRegistryFanoutWithinTheSpawnWidthConvertsBackWithoutLoss() throws Exception {
        List<String> lossless = new ArrayList<>();
        for (JsonNode doc : docs()) {
            WorkflowReader.Read read = WorkflowReader.read(JSON.writeValueAsString(doc));
            if (read.workflow() == null) {
                continue;
            }
            assertEquals(List.of(), read.findings(), doc.get("name").asText());
            assertTrue(read.workflow().scenario(), doc.get("name").asText());
            assertEquals(doc, JSON.readTree(WorkflowWriter.toScenarioShape(read.workflow())), doc.get("name").asText());
            lossless.add(doc.get("name").asText());
        }
        assertEquals(List.of("bughunt", "fanout", "coding", "research", "codereview", "fleetswarm"), lossless);
    }

    @Test
    void theWiderRegistryFanoutsAreRefusedWithTheFindingThatNamesTheWidth() throws Exception {
        Map<String, List<String>> refused = new TreeMap<>();
        for (JsonNode doc : docs()) {
            WorkflowReader.Read read = WorkflowReader.read(JSON.writeValueAsString(doc));
            if (read.workflow() != null) {
                continue;
            }
            List<String> lines = read.findings().stream()
                    .filter(f -> !f.path().endsWith(".subject"))
                    .map(f -> f.path() + ": " + f.message()).toList();
            refused.put(doc.get("name").asText(), lines);
            assertNull(read.workflow());
        }
        List<String> width = List.of("steps[0].fanout.agents: a fanout starts 1 to " + WorkflowReader.MAX_AGENTS
                + " children");
        assertEquals(Map.of("fanout-eight", width, "fanout-workflow", width, "workflow-phases-1", width,
                "workflow-phases-2", width), refused);
    }

    @Test
    void theReleaseCheckFanoutsSubjectFieldIsAFindingAtEachAgent() throws Exception {
        JsonNode doc = docs().stream().filter(d -> d.get("name").asText().equals("fanout-workflow")).findFirst()
                .orElseThrow();
        WorkflowReader.Read read = WorkflowReader.read(JSON.writeValueAsString(doc));
        long subjects = read.findings().stream().filter(f -> f.path().endsWith(".subject")
                && f.message().equals("unknown field")).count();
        assertEquals(doc.at("/steps/0/fanout/agents").size(), subjects, read.findings().toString());
    }
}
