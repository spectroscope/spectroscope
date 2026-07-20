package dev.spectroscope.core.events;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The wire-format promise: every event serializes with a snake_case {@code type}
 * discriminator and camelCase fields, omits null optionals, and survives a
 * lossless Jackson round-trip — byte-compatible with the TypeScript edition.
 */
class RunEventJsonTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** One instance of every event type, as a stream — the round-trip is a reduce over it. */
    private static Stream<RunEvent> allEvents() {
        JsonNode input = JSON.createObjectNode().put("path", "src");
        return Stream.of(
                new RunEvent.RunStart("r1", "main", null, "count files", "anthropic", null, 1L),
                new RunEvent.TurnStart("main", 1, 2L),
                new RunEvent.TextDelta("main", "Let me look", 3L),
                new RunEvent.ThinkingDelta("main", "I should list the dir first", 3L),
                new RunEvent.ToolCall("main", "c1", "list_dir", input, 4L),
                new RunEvent.PermissionRequest("main", "c2", "run_command", input, 5L),
                new RunEvent.PermissionDecision("c2", true, 6L),
                new RunEvent.ToolResult("main", "c1", "src\nbuild.gradle.kts", false, 12L, 7L),
                new RunEvent.AgentSpawn("explore-1", "main", "Explore apps/", 8L),
                new RunEvent.Compaction("main", 12, 1830, 9L),
                new RunEvent.VoiceInput("main", 4200, "ggml-small", 10L),
                new RunEvent.Usage("main", 2411, 186, 11L),
                new RunEvent.RunEnd("r1", "end_turn", 12L),
                new RunEvent.ErrorEvent("main", "Rate limit reached", 13L),
                new RunEvent.ImageGenerated("main", "c3", "a lighthouse at dusk", "gemini",
                        "gemini-2.5-flash-image", "image/png", "images/3f7a.png", "3f7a", 14L),
                new RunEvent.ContextInfo("main", 2, 5, 2612, 100_000,
                        List.of(new RunEvent.ContextPart("conversation", 10448, 2612)), 15L),
                new RunEvent.AgentMessage("main", "worker-1", "task", "submitted",
                        "Plan the feature", "build_plan", 16L),
                new RunEvent.Plan("main", List.of(
                        new RunEvent.PlanStep("read the files", "completed"),
                        new RunEvent.PlanStep("write the tool", "in_progress")), 17L));
    }

    @Test
    void everyEventTypeSurvivesAJacksonRoundTrip() {
        long verified = allEvents()
                .map(this::roundTrip)
                .filter(pair -> pair.original().equals(pair.reborn()))
                .count();
        assertEquals(18, verified, "every event must deserialize back to an equal record");
    }

    @Test
    void usageCacheFieldsAreAdditiveAndOmittedWhenAbsent() throws Exception {
        // The legacy shape (no cache counts) serializes EXACTLY as before —
        // old sessions and the TypeScript edition stay byte-identical.
        String legacy = JSON.writeValueAsString(new RunEvent.Usage("main", 2411, 186, 11L));
        assertEquals("{\"type\":\"usage\",\"agentId\":\"main\",\"inputTokens\":2411,"
                + "\"outputTokens\":186,\"ts\":11}", legacy);

        // The cache-carrying shape (Anthropic prompt caching) round-trips losslessly.
        RunEvent.Usage cached = new RunEvent.Usage("main", 13, 1084, 1500, 200, 12L);
        assertEquals(cached, JSON.readValue(JSON.writeValueAsString(cached), RunEvent.class));
    }

    private record Trip(RunEvent original, RunEvent reborn) {}

    private Trip roundTrip(RunEvent event) {
        try {
            String line = JSON.writeValueAsString(event);
            return new Trip(event, JSON.readValue(line, RunEvent.class));
        } catch (Exception jsonError) {
            throw new AssertionError("round trip failed for " + event, jsonError);
        }
    }

    @Test
    void typeDiscriminatorsAreSnakeCase() throws Exception {
        List<String> expected = List.of("run_start", "turn_start", "text_delta", "thinking_delta",
                "tool_call", "permission_request", "permission_decision", "tool_result", "agent_spawn",
                "compaction", "voice_input", "usage", "run_end", "error", "image_generated", "context_info",
                "agent_message", "plan");
        List<String> actual = allEvents()
                .map(this::serialize)
                .map(json -> json.get("type").asText())
                .toList();
        assertEquals(expected, actual);
    }

    @Test
    void nullOptionalsAreOmittedFromTheJson() {
        RunEvent.RunStart minimal = new RunEvent.RunStart("r1", "main", null, "hi", null, null, 1L);
        JsonNode json = serialize(minimal);
        assertFalse(json.has("parentId"), "null parentId must be absent, not null");
        assertFalse(json.has("provider"), "null provider must be absent, not null");
        assertFalse(json.has("attachments"), "null attachments must be absent, not null");
        assertEquals(List.of("type", "runId", "agentId", "prompt", "ts"), fieldNames(json));
    }

    private static List<String> fieldNames(JsonNode json) {
        List<String> names = new java.util.ArrayList<>();
        json.fieldNames().forEachRemaining(names::add);
        return names;
    }

    @Test
    void fieldNamesAreCamelCaseOnTheWire() {
        JsonNode json = serialize(new RunEvent.ToolResult("main", "c1", "ok", false, 12L, 7L));
        assertTrue(json.has("callId"));
        assertTrue(json.has("isError"));
        assertTrue(json.has("durationMs"));
        assertFalse(json.has("call_id"), "wire format is camelCase for fields, snake_case only for type");
    }

    @Test
    void toolInputTravelsAsStructuredJsonNotAsAString() {
        JsonNode input = JSON.createObjectNode().put("path", "src/Agent.java");
        JsonNode json = serialize(new RunEvent.ToolCall("main", "c1", "read_file", input, 4L));
        assertTrue(json.get("input").isObject(), "input must stay a JSON object on the wire");
        assertEquals("src/Agent.java", json.get("input").get("path").asText());
    }

    @Test
    void attachmentsCarryReferencesOnlyAndRoundTrip() throws Exception {
        // Attachment wire shape: the line references blobPath + sha256 — the image
        // bytes live NEXT TO the session file, never inside it (JSONL-FORMAT §7).
        RunEvent.RunStart start = new RunEvent.RunStart("r1", "main", null, "What is this?",
                "anthropic",
                List.of(new RunEvent.Attachment("image", "image/png",
                        "/home/u/.spectro/sessions/s1/blobs/3f7a", "3f7a")),
                1L);

        JsonNode json = serialize(start);
        JsonNode attachment = json.get("attachments").get(0);
        assertEquals(List.of("kind", "mediaType", "blobPath", "sha256"), fieldNames(attachment));
        assertEquals("image", attachment.get("kind").asText());
        assertFalse(json.toString().contains("dataBase64"),
                "bytes must never enter a RunEvent — cat/jq stay usable");

        RunEvent reborn = JSON.readValue(JSON.writeValueAsString(start), RunEvent.class);
        assertEquals(start, reborn, "attachments must survive the round trip losslessly");
    }

    @Test
    void aPreBonusLineWithoutAttachmentsStillDeserializes() throws Exception {
        // Old sessions have no attachments field at all — Jackson yields null.
        RunEvent event = JSON.readValue(
                "{\"type\":\"run_start\",\"runId\":\"r1\",\"agentId\":\"main\",\"prompt\":\"hi\",\"ts\":1}",
                RunEvent.class);
        RunEvent.RunStart start = (RunEvent.RunStart) event;
        assertEquals(null, start.attachments(), "absent field must deserialize to null, never []");
    }

    @Test
    void voiceInputMatchesTheJsonlFormatWireShape() {
        // Voice input, JSONL-FORMAT §3:
        // {"type":"voice_input","agentId":"a0","durationMs":4200,"model":"ggml-small","ts":…}
        JsonNode json = serialize(new RunEvent.VoiceInput("main", 4200, "ggml-small", 42L));
        assertEquals("voice_input", json.get("type").asText());
        assertEquals(List.of("type", "agentId", "durationMs", "model", "ts"), fieldNames(json));
        assertEquals(4200, json.get("durationMs").asLong());
        assertEquals("ggml-small", json.get("model").asText());
    }

    @Test
    void agentMessageMatchesTheA2AWireShapeAndOmitsANullLabel() {
        // A2A-lite: {"type":"agent_message","from":…,"to":…,"role":…,"state":…,"text":…,["label":…],"ts":…}
        JsonNode labeled = serialize(new RunEvent.AgentMessage(
                "worker-1", "main", "status", "working", "writing section 2/4", null, 42L));
        assertEquals("agent_message", labeled.get("type").asText());
        assertEquals(List.of("type", "from", "to", "role", "state", "text", "ts"), fieldNames(labeled),
                "a null label must be absent, not null");
        assertEquals("working", labeled.get("state").asText());
    }

    @Test
    void planMatchesTheJsonlWireShapeWithCamelCaseSteps() {
        // Additive: {"type":"plan","agentId":"main","steps":[{"text":…,"status":…},…],"ts":…}
        JsonNode json = serialize(new RunEvent.Plan("main", List.of(
                new RunEvent.PlanStep("read the files", "completed"),
                new RunEvent.PlanStep("write the tool", "in_progress")), 42L));
        assertEquals("plan", json.get("type").asText());
        assertEquals(List.of("type", "agentId", "steps", "ts"), fieldNames(json),
                "the plan line carries only agentId + steps + ts");
        assertTrue(json.get("steps").isArray(), "steps must stay a JSON array on the wire");
        JsonNode first = json.get("steps").get(0);
        assertEquals(List.of("text", "status"), fieldNames(first),
                "a step is camelCase {text, status}, never a subtype");
        assertEquals("in_progress", json.get("steps").get(1).get("status").asText(),
                "wire status values stay English");
    }

    private JsonNode serialize(RunEvent event) {
        try {
            return JSON.readTree(JSON.writeValueAsString(event));
        } catch (Exception jsonError) {
            throw new AssertionError("serialization failed for " + event, jsonError);
        }
    }
}
