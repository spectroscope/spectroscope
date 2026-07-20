package dev.spectroscope.core.session;

import dev.spectroscope.core.events.RunEvent;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;

/**
 * The interop contract, tested against the LITERAL example session from
 * concept/JSONL-FORMAT.md §4 — the lines a TypeScript-edition harness would
 * write. Every line must parse (the bonus-2 voice_input line included, now that
 * this edition knows the type), a torn trailing line must be tolerated silently,
 * and the parsed payloads must survive structurally (JsonNode inputs, camelCase
 * fields).
 */
class JsonlFormatInteropTest {

    /** Verbatim from JSONL-FORMAT.md §4, plus a voice_input line (§3) and a torn tail. */
    private static final String TS_EDITION_SESSION = """
            {"type":"run_start","runId":"r-m4x2k9","agentId":"a0","prompt":"Compare apps/ and packages/","provider":"anthropic","ts":1751407220001}
            {"type":"turn_start","agentId":"a0","turn":1,"ts":1751407220002}
            {"type":"text_delta","agentId":"a0","text":"I will delegate this to two explore agents.","ts":1751407221100}
            {"type":"tool_call","agentId":"a0","callId":"c1","name":"spawn_agents","input":{"tasks":[{"type":"explore","task":"Explore apps/"}]},"ts":1751407221900}
            {"type":"agent_spawn","agentId":"a1","parentId":"a0","task":"Explore apps/","ts":1751407221950}
            {"type":"turn_start","agentId":"a1","turn":1,"ts":1751407222010}
            {"type":"tool_call","agentId":"a1","callId":"c2","name":"list_dir","input":{"path":"apps"},"ts":1751407223518}
            {"type":"tool_result","agentId":"a1","callId":"c2","output":"cli\\nserver\\nweb","isError":false,"durationMs":9,"ts":1751407223527}
            {"type":"text_delta","agentId":"a1","text":"apps/ contains three packages …","ts":1751407224803}
            {"type":"usage","agentId":"a1","inputTokens":911,"outputTokens":74,"ts":1751407225010}
            {"type":"tool_result","agentId":"a0","callId":"c1","output":"[explore-1] apps/ contains three packages …","isError":false,"durationMs":3110,"ts":1751407225060}
            {"type":"voice_input","agentId":"a0","durationMs":4200,"model":"ggml-small","ts":1751407225100}
            {"type":"text_delta","agentId":"a0","text":"In summary: …","ts":1751407226412}
            {"type":"usage","agentId":"a0","inputTokens":2411,"outputTokens":186,"ts":1751407227200}
            {"type":"run_end","runId":"r-m4x2k9","stopReason":"end_turn","ts":1751407227205}
            {"type":"text_delta","agentId":"a0","text":"torn li""";

    @Test
    void aTypeScriptEditionSessionFileParsesToleantly() throws IOException {
        String id = "ts-interop-test";
        Path file = SessionStore.SESSIONS_DIR.resolve(id + ".jsonl");
        Files.createDirectories(SessionStore.SESSIONS_DIR);
        Files.writeString(file, TS_EDITION_SESSION, StandardCharsets.UTF_8);

        List<RunEvent> events = SessionStore.readSessionEvents(id);

        // 16 lines: 15 complete + 1 torn. The voice_input line now parses (voice input is
        // built here) and the torn tail is dropped SILENTLY -> 15 events survive.
        assertEquals(15, events.size());
        assertInstanceOf(RunEvent.VoiceInput.class, events.get(11),
                "the voice_input provenance line parses now that this edition knows the type");

        RunEvent.RunStart start = assertInstanceOf(RunEvent.RunStart.class, events.getFirst());
        assertEquals("r-m4x2k9", start.runId());
        assertEquals("anthropic", start.provider());

        RunEvent.ToolCall spawn = assertInstanceOf(RunEvent.ToolCall.class, events.get(3));
        assertEquals("spawn_agents", spawn.name());
        assertEquals("Explore apps/",
                spawn.input().path("tasks").get(0).path("task").asText(),
                "tool input must survive as a structured JSON tree");

        RunEvent.AgentSpawn edge = assertInstanceOf(RunEvent.AgentSpawn.class, events.get(4));
        assertEquals("a0", edge.parentId());

        RunEvent.RunEnd end = assertInstanceOf(RunEvent.RunEnd.class, events.getLast());
        assertEquals("end_turn", end.stopReason());

        Files.deleteIfExists(file);
    }
}
