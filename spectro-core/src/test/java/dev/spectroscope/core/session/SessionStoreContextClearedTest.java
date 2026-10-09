package dev.spectroscope.core.session;

import dev.spectroscope.core.provider.LlmProvider.ProviderMessage;
import dev.spectroscope.core.provider.LlmProvider.TextContent;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * Card 471: a resume honours the last {@code context_cleared}.
 *
 * <p>The session file keeps everything that was said before a {@code /clear},
 * because the file is the record and is never rewritten. The provider history a
 * resume rebuilds from it starts after the last marker, so a clear survives a
 * restart instead of coming undone the moment the server reloads the session.</p>
 */
class SessionStoreContextClearedTest {

    private static final String ID = "session-store-context-cleared-test";

    private static final String TWO_RUNS = """
            {"type":"run_start","runId":"r1","agentId":"main","prompt":"ALPHA","ts":1}
            {"type":"text_delta","agentId":"main","text":"alpha answer","ts":2}
            {"type":"run_end","runId":"r1","stopReason":"end_turn","ts":3}
            {"type":"run_start","runId":"r2","agentId":"main","prompt":"BRAVO","ts":4}
            {"type":"text_delta","agentId":"main","text":"bravo answer","ts":5}
            {"type":"run_end","runId":"r2","stopReason":"end_turn","ts":6}
            """;

    private static final String CLEAR = """
            {"type":"context_cleared","agentId":"main","removedMessages":4,"ts":7}
            """;

    private static final String THIRD_RUN = """
            {"type":"run_start","runId":"r3","agentId":"main","prompt":"CHARLIE","ts":8}
            {"type":"text_delta","agentId":"main","text":"charlie answer","ts":9}
            {"type":"run_end","runId":"r3","stopReason":"end_turn","ts":10}
            """;

    private static Path write(String body) throws Exception {
        Files.createDirectories(SessionStore.SESSIONS_DIR);
        Path file = SessionStore.SESSIONS_DIR.resolve(ID + ".jsonl");
        Files.writeString(file, body, StandardCharsets.UTF_8);
        return file;
    }

    @AfterEach
    void removeFile() throws Exception {
        Files.deleteIfExists(SessionStore.SESSIONS_DIR.resolve(ID + ".jsonl"));
    }

    private static List<String> texts(List<ProviderMessage> messages) {
        return messages.stream()
                .flatMap(message -> message.content().stream())
                .filter(TextContent.class::isInstance)
                .map(content -> ((TextContent) content).text())
                .toList();
    }

    @Test
    void withoutAMarkerTheWholeConversationComesBack() throws Exception {
        write(TWO_RUNS + THIRD_RUN);

        assertEquals(List.of("ALPHA", "alpha answer", "BRAVO", "bravo answer", "CHARLIE", "charlie answer"),
                texts(SessionStore.loadSession(ID)));
    }

    @Test
    void aResumeRebuildsOnlyWhatCameAfterTheClear() throws Exception {
        write(TWO_RUNS + CLEAR + THIRD_RUN);

        assertEquals(List.of("CHARLIE", "charlie answer"), texts(SessionStore.loadSession(ID)));
    }

    @Test
    void withTwoClearsTheResumeStartsAfterTheLastOne() throws Exception {
        write(TWO_RUNS + CLEAR + THIRD_RUN
                + "{\"type\":\"context_cleared\",\"agentId\":\"main\",\"removedMessages\":2,\"ts\":11}\n"
                + "{\"type\":\"run_start\",\"runId\":\"r4\",\"agentId\":\"main\",\"prompt\":\"DELTA\",\"ts\":12}\n"
                + "{\"type\":\"text_delta\",\"agentId\":\"main\",\"text\":\"delta answer\",\"ts\":13}\n"
                + "{\"type\":\"run_end\",\"runId\":\"r4\",\"stopReason\":\"end_turn\",\"ts\":14}\n");

        assertEquals(List.of("DELTA", "delta answer"), texts(SessionStore.loadSession(ID)),
                "the second clear also cut CHARLIE, which came after the first");
    }

    @Test
    void aClearAtTheEndLeavesAnEmptyHistory() throws Exception {
        write(TWO_RUNS + CLEAR);

        assertEquals(List.of(), SessionStore.loadSession(ID));
    }

    @Test
    void aChildsMarkerDoesNotCutTheMainHistory() throws Exception {
        write(TWO_RUNS
                + "{\"type\":\"context_cleared\",\"agentId\":\"explore-1\",\"removedMessages\":3,\"ts\":7}\n"
                + THIRD_RUN);

        assertEquals(6, texts(SessionStore.loadSession(ID)).size());
    }
}
