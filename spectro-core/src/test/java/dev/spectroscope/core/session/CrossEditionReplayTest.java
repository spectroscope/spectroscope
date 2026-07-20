package dev.spectroscope.core.session;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.LlmProvider.ProviderMessage;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The cross-edition replay proof. The fixture is the TypeScript edition's
 * canonical example session, taken VERBATIM from its JSONL-FORMAT.md §4
 * (German prompts, compact example ids "a0"/"a1", a subagent spawn) — a
 * session "written by the other edition". If this harness parses it, re-emits
 * it byte for byte, and reconstructs a resumable history from it, the two
 * editions genuinely share one format — not just one document.
 */
class CrossEditionReplayTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String SESSION_ID = "19990101-000000-tsfixture";

    private Path sessionFile;

    @BeforeEach
    void installFixtureAsSession() throws IOException {
        // user.home is redirected into the build dir by the Gradle test task.
        Files.createDirectories(SessionStore.SESSIONS_DIR);
        sessionFile = SessionStore.SESSIONS_DIR.resolve(SESSION_ID + ".jsonl");
        try (InputStream fixture = getClass().getResourceAsStream("/interop/ts-edition-session.jsonl")) {
            Files.write(sessionFile, fixture.readAllBytes());
        }
    }

    @AfterEach
    void removeFixtureSession() throws IOException {
        Files.deleteIfExists(sessionFile);
    }

    @Test
    void everyLineOfTheOtherEditionParsesIntoATypedEvent() throws IOException {
        List<RunEvent> events = SessionStore.readSessionEvents(SESSION_ID);
        assertEquals(14, events.size(), "no line may be dropped as unreadable");
        assertTrue(events.getFirst() instanceof RunEvent.RunStart);
        assertTrue(events.getLast() instanceof RunEvent.RunEnd);
    }

    @Test
    void reserializingReproducesTheOtherEditionsBytesExactly() throws IOException {
        List<String> original = Files.readAllLines(sessionFile, StandardCharsets.UTF_8).stream()
                .filter(line -> !line.isBlank())
                .toList();
        List<RunEvent> events = SessionStore.readSessionEvents(SESSION_ID);
        for (int i = 0; i < original.size(); i++) {
            String reborn = serialize(events.get(i));
            assertEquals(original.get(i), reborn,
                    "line " + (i + 1) + " must survive the round trip byte for byte");
        }
    }

    @Test
    void resumeReconstructsTheMainAgentHistoryDespiteTheCompactExampleIds() throws IOException {
        // The fixture's main agent is "a0" (the doc's compact id), not "main" —
        // loadSession finds it structurally via the parentId-less run_start.
        List<ProviderMessage> history = SessionStore.loadSession(SESSION_ID);
        assertEquals(4, history.size(),
                "user prompt, assistant text+spawn call, tool result, closing answer");
        assertEquals(ProviderMessage.Role.USER, history.get(0).role());
        assertEquals(ProviderMessage.Role.ASSISTANT, history.get(1).role());
        assertEquals(ProviderMessage.Role.USER, history.get(2).role());
        assertEquals(ProviderMessage.Role.ASSISTANT, history.get(3).role());
    }

    @Test
    void theSessionsOverviewDescribesTheForeignSession() {
        SessionStore.SessionInfo info = SessionStore.listSessions().stream()
                .filter(session -> SESSION_ID.equals(session.id()))
                .findFirst()
                .orElseThrow();
        assertEquals("Vergleiche apps/ und packages/", info.firstPrompt());
        assertEquals("anthropic", info.provider());
        assertEquals(911 + 74 + 2411 + 186, info.tokens(), "usage of parent AND child counts");
    }

    private static String serialize(RunEvent event) {
        try {
            return JSON.writeValueAsString(event);
        } catch (IOException jsonError) {
            throw new AssertionError("serialization failed for " + event, jsonError);
        }
    }
}
