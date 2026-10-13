package dev.spectroscope.core.events;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 586: the run view's line on the wire, written and read back byte for byte.
 * A field a later version adds, on the line or inside a node or a document,
 * costs an older reader nothing.
 */
class RunStepWireTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @Test
    void aStepEndRoundTripsWithItsDocumentsAndLeavesNullsOff() throws Exception {
        RunEvent.RunStep end = new RunEvent.RunStep("playbook", "abcdefabcdef", "playbook", RunEvent.RunStep.STEP_END,
                "Write plan", null, null, "write_plan", "step", 1,
                null, null, null, null, null,
                null, null, null,
                null, null,
                "done", 1200L, "worker-1", null,
                "the plan is written", 19, List.of(new RunEvent.RunDoc("plan", "docs/plan.md", "created")),
                null, null, null, null, null, 7L);
        String json = JSON.writeValueAsString(end);
        JsonNode tree = JSON.readTree(json);
        assertEquals("run_step", tree.get("type").asText());
        assertEquals("step_end", tree.get("phase").asText());
        assertEquals("created", tree.get("documents").get(0).get("change").asText());
        assertFalse(tree.has("performer"), "a null field stays off the wire: " + json);
        RunEvent back = JSON.readValue(json, RunEvent.class);
        assertInstanceOf(RunEvent.RunStep.class, back);
        assertEquals(end, back);
        assertEquals(json, JSON.writeValueAsString(back));
    }

    @Test
    void aRunStartCarriesItsForwardPath() throws Exception {
        RunEvent.RunStep start = new RunEvent.RunStep("playbook", "abcdefabcdef", "workflow", RunEvent.RunStep.RUN_START,
                "fanout-review", "review the diff",
                List.of(new RunEvent.RunNode("diff", "diff", "prompt"), new RunEvent.RunNode("review", "Review", "fanout")),
                null, null, null, null, null, null, null, null, null, null, null, null, null,
                null, null, null, null, null, null, null, null, null, null, null, null, 1L);
        String json = JSON.writeValueAsString(start);
        RunEvent back = JSON.readValue(json, RunEvent.class);
        assertEquals(start, back);
        assertEquals(json, JSON.writeValueAsString(back));
    }

    @Test
    void aReadDocumentLeavesItsChangeOffAndARunEndCarriesOnlyItsFiveFields() throws Exception {
        RunEvent.RunStep stepStart = new RunEvent.RunStep("playbook", "abcdefabcdef", "playbook",
                RunEvent.RunStep.STEP_START,
                "Write plan", null, null, "write_plan", "step", 1,
                "chat", null, "ollama", "qwen2.5:7b", true,
                "write the plan", 14, List.of(new RunEvent.RunDoc("brief", "docs/brief.md", null)),
                null, null,
                null, null, null, null,
                null, null, null,
                null, null,
                null, null, null, 3L);
        String json = JSON.writeValueAsString(stepStart);
        JsonNode tree = JSON.readTree(json);
        assertEquals("step_start", tree.get("phase").asText());
        assertTrue(tree.get("picked").asBoolean(), "the owner's pick rides the line: " + json);
        JsonNode read = tree.get("reads").get(0);
        assertEquals("docs/brief.md", read.get("path").asText());
        assertFalse(read.has("change"), "a read document carries no change: " + json);
        RunEvent back = JSON.readValue(json, RunEvent.class);
        assertEquals(stepStart, back);
        assertEquals(json, JSON.writeValueAsString(back));

        RunEvent.RunStep runEnd = new RunEvent.RunStep("playbook", "abcdefabcdef", "playbook",
                RunEvent.RunStep.RUN_END,
                null, null, null, null, null, null,
                null, null, null, null, null,
                null, null, null,
                null, null,
                null, null, null, null,
                null, null, null,
                null, null,
                null, null, null, 9L);
        String endJson = JSON.writeValueAsString(runEnd);
        JsonNode endTree = JSON.readTree(endJson);
        assertEquals("run_end", endTree.get("phase").asText());
        Set<String> keys = new HashSet<>();
        endTree.fieldNames().forEachRemaining(keys::add);
        assertEquals(Set.of("type", "agentId", "runId", "runKind", "phase", "ts"), keys, endJson);
        RunEvent endBack = JSON.readValue(endJson, RunEvent.class);
        assertEquals(runEnd, endBack);
        assertEquals(endJson, JSON.writeValueAsString(endBack));
    }

    @Test
    void aFieldALaterVersionAddsInsideANodeOrADocumentCostsTheLineNothing() throws Exception {
        String json = """
                {"type":"run_step","agentId":"playbook","runId":"abcdefabcdef","runKind":"workflow",\
                "phase":"step_end","future":"x",\
                "nodes":[{"id":"review","name":"Review","kind":"fanout","future":"x"}],\
                "documents":[{"doc":"plan","path":"docs/plan.md","change":"changed","future":"x"}],\
                "ts":5}""";
        RunEvent back = JSON.readValue(json, RunEvent.class);
        RunEvent.RunStep known = new RunEvent.RunStep("playbook", "abcdefabcdef", "workflow", RunEvent.RunStep.STEP_END,
                null, null, List.of(new RunEvent.RunNode("review", "Review", "fanout")), null, null, null,
                null, null, null, null, null,
                null, null, null,
                null, null,
                null, null, null, null,
                null, null, List.of(new RunEvent.RunDoc("plan", "docs/plan.md", "changed")),
                null, null,
                null, null, null, 5L);
        assertEquals(known, back);
    }

    @Test
    void aRunStartCarriesTheFingerprintOfItsFolderByteForByte() throws Exception {
        RunEvent.RunStep start = new RunEvent.RunStep("playbook", "abcdefabcdef", "playbook", RunEvent.RunStep.RUN_START,
                "T", "add a CSV export", List.of(new RunEvent.RunNode("write_plan", "Write plan", "step")),
                null, null, null, null, null, null, null, null, null, null, null, null, null,
                null, null, null, null, null, null, null, null, null, null, null, null, 1L, "0123456789abcdef");
        String json = JSON.writeValueAsString(start);
        assertEquals("0123456789abcdef", JSON.readTree(json).get("workspaceFingerprint").asText());
        RunEvent back = JSON.readValue(json, RunEvent.class);
        assertEquals(start, back);
        assertEquals(json, JSON.writeValueAsString(back));
    }

    @Test
    void aLineBuiltWithoutTheFingerprintLeavesItOffTheWire() throws Exception {
        RunEvent.RunStep end = new RunEvent.RunStep("playbook", "abcdefabcdef", "playbook", RunEvent.RunStep.RUN_END,
                null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null,
                null, 5L, null, null, null, null, null, null, null, "done", "done", null, 9L);
        String json = JSON.writeValueAsString(end);
        assertNull(end.workspaceFingerprint());
        assertFalse(JSON.readTree(json).has("workspaceFingerprint"), json);
        assertTrue(JSON.readTree(json).has("stopReason"), "positive: the line itself is written: " + json);
    }

    @Test
    void theFingerprintIsTheFirstSixteenHexDigitsOfTheSha256OfThePath() throws Exception {
        Path folder = Path.of("/Users/someone/projects/frogger");
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(folder.toString().getBytes(StandardCharsets.UTF_8));
        String expected = HexFormat.of().formatHex(digest).substring(0, 16);

        assertEquals(expected, RunEvent.RunStep.fingerprintOf(folder));
        assertEquals(16, RunEvent.RunStep.fingerprintOf(folder).length());
        assertFalse(RunEvent.RunStep.fingerprintOf(folder).contains("frogger"), "never the path itself");
        assertNotEquals(expected, RunEvent.RunStep.fingerprintOf(Path.of("/Users/someone/projects/frogger2")));
    }
}
