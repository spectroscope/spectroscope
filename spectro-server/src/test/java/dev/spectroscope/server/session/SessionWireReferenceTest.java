package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.session.SessionStore;
import dev.spectroscope.core.wire.BrowserWireRecorder;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 473 on the face the owner uses: a browser session names the files
 * beside it in its own {@code run_start}, so an import on another machine
 * finds its wire by reference rather than by a folder it cannot see. No line
 * is added: the reference is three optional fields of the run_start the
 * session writes anyway.
 */
@Timeout(value = 120, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class SessionWireReferenceTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @TempDir
    Path workspace;

    @TempDir
    Path home;

    private SessionConnection sessionAgainst(SessionFreshReceiptTest.Backend backend, String socketId)
            throws IOException {
        Files.createDirectories(workspace.resolve(".spectro"));
        Files.writeString(workspace.resolve(".spectro/settings.json"), """
                { "provider": "ollama", "model": "qwen3", "baseUrl": "%s" }
                """.formatted(backend.baseUrl()));
        SpectroConfig config = SpectroConfig.load(new SpectroConfig.Overrides(
                "ollama", "qwen3", backend.baseUrl(), null, null, workspace.toString()));
        SessionConnection connection = new SessionConnection(
                new FakeSocket(socketId, "ws://localhost/ws"), JSON, config, null);
        connection.useTitles(new SessionTitles(
                new SessionMetaStore(home.resolve("session-meta.json")), SessionTitles.TIME_LIMIT));
        connection.start();
        return connection;
    }

    private static List<JsonNode> lines(String sessionId) throws IOException {
        return Files.readAllLines(SessionStore.sessionFile(sessionId)).stream()
                .map(SessionWireReferenceTest::parse)
                .toList();
    }

    private static JsonNode parse(String line) {
        try {
            return JSON.readTree(line);
        } catch (IOException notJson) {
            return JSON.createObjectNode();
        }
    }

    private static List<JsonNode> ofType(List<JsonNode> lines, String type) {
        return lines.stream().filter(n -> type.equals(n.path("type").asText())).toList();
    }

    /** Sends one prompt and waits until its run_end is in the file. */
    private static void runOnce(SessionConnection connection, String prompt, int runsBefore) throws Exception {
        connection.onUserMessage(prompt, null);
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(60);
        while (System.nanoTime() < deadline) {
            String id = connection.sessionId();
            if (id != null && Files.exists(SessionStore.sessionFile(id))
                    && ofType(lines(id), "run_end").size() > runsBefore) {
                return;
            }
            Thread.sleep(20);
        }
        throw new AssertionError("run " + (runsBefore + 1) + " did not end");
    }

    @Test
    void theFirstRunStartNamesTheLlmWireAndNoBrowserWireThatWasNeverWritten() throws Exception {
        try (SessionFreshReceiptTest.Backend backend = new SessionFreshReceiptTest.Backend()) {
            SessionConnection connection = sessionAgainst(backend, "ws-473-first");
            try {
                runOnce(connection, "hello", 0);
                String id = connection.sessionId();
                List<JsonNode> onDisk = lines(id);

                JsonNode first = onDisk.getFirst();
                assertThat(first.path("type").asText()).as("no line in front of the run_start: " + first)
                        .isEqualTo("run_start");
                assertThat(first.path("llmWire").asText()).isEqualTo(id + ".llm.jsonl");
                assertThat(first.has("browserWire")).as("never written, so not named").isFalse();
                assertThat(first.path("children").isArray()).isTrue();
                assertThat(first.path("children").size()).isZero();
                assertThat(first.path("prompt").asText()).as("the run_start is otherwise as it was")
                        .isEqualTo("hello");

                runOnce(connection, "again", 1);
                List<JsonNode> starts = ofType(lines(id), "run_start");
                assertThat(starts).hasSize(2);
                assertThat(starts.get(1).has("children"))
                        .as("the second run_start has nothing new to name").isFalse();
            } finally {
                connection.onClose();
            }
        }
    }

    @Test
    void aBrowserWireIsNamedOnTheFirstRunStartAfterItWasWritten() throws Exception {
        try (SessionFreshReceiptTest.Backend backend = new SessionFreshReceiptTest.Backend()) {
            SessionConnection connection = sessionAgainst(backend, "ws-473-browser");
            try {
                runOnce(connection, "hello", 0);
                String id = connection.sessionId();
                Path browser = BrowserWireRecorder.fileFor(id);
                Files.createDirectories(browser.getParent());
                Files.writeString(browser, "{\"t\":\"call\"}\n");

                runOnce(connection, "now with a page", 1);
                List<JsonNode> starts = ofType(lines(id), "run_start");
                assertThat(starts.get(1).path("browserWire").asText()).isEqualTo(id + ".browser.jsonl");
                assertThat(starts.get(1).path("llmWire").asText()).isEqualTo(id + ".llm.jsonl");
            } finally {
                connection.onClose();
            }
        }
    }

    @Test
    void pickingAWorkingFolderAloneLeavesNoSessionFile() throws IOException {
        FakeSocket socket = new FakeSocket("ws-473-folder", "ws://localhost/ws");
        Files.createDirectories(workspace.resolve(".spectro"));
        Files.writeString(workspace.resolve(".spectro/settings.json"),
                "{ \"provider\": \"ollama\", \"model\": \"qwen3:latest\" }\n");
        SessionConnection connection = new SessionConnection(socket, JSON,
                SpectroConfig.load(new SpectroConfig.Overrides("ollama", "qwen3:latest", null,
                        null, null, workspace.toString())),
                null);
        connection.start();
        connection.onSetWorkspace("random", null);
        String id = connection.sessionId();
        assertThat(id).as("positive control: the gesture minted a session").isNotBlank();
        assertThat(Files.exists(SessionStore.sessionFile(id)))
                .as("no session file for a gesture that wrote nothing").isFalse();
        connection.onClose();
    }
}
