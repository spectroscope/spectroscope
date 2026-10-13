package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SpectroConfig;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.springframework.web.socket.CloseStatus;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 580, second review X3: a settings write that lands while the socket
 * handler reads the settings for a new connection still reaches that chat.
 * The handler takes the write count before its read; a count taken after it
 * would miss the write, because the connection only listens once it starts.
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class SocketHandlerSettingsGapTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private byte[] userBefore;

    @BeforeEach
    void setTheOldDefault() throws IOException {
        Path user = SpectroConfig.USER_SETTINGS_PATH;
        userBefore = Files.exists(user) ? Files.readAllBytes(user) : null;
        Files.createDirectories(user.getParent());
        Files.writeString(user, """
                { "provider": "ollama", "model": "m-old" }
                """);
    }

    @AfterEach
    void restore() throws IOException {
        Path user = SpectroConfig.USER_SETTINGS_PATH;
        if (userBefore == null) {
            Files.deleteIfExists(user);
        } else {
            Files.write(user, userBefore);
        }
    }

    private static List<String> announcedPairs(FakeSocket socket) {
        List<String> out = new ArrayList<>();
        for (FakeSocket.Frame frame : socket.frames()) {
            try {
                JsonNode node = JSON.readTree(frame.payload());
                if ("provider_info".equals(node.path("type").asText())) {
                    out.add(node.path("provider").asText() + "/" + node.path("model").asText());
                }
            } catch (IOException notJson) {
                // not a frame this test reads
            }
        }
        return out;
    }

    @Test
    void aWriteDuringTheHandlersReadReachesTheNewChat() throws Exception {
        LiveSessions live = new LiveSessions();
        SpectroSocketHandler handler = new SpectroSocketHandler(null, live, null, null);
        handler.useSettingsLoader(() -> {
            SpectroConfig read = SpectroConfig.load(SpectroConfig.Overrides.none());
            try {
                // The write lands after the file was read and before the read returns.
                Files.writeString(SpectroConfig.USER_SETTINGS_PATH, """
                        { "provider": "ollama", "model": "m-new" }
                        """);
            } catch (IOException unwritable) {
                throw new java.io.UncheckedIOException(unwritable);
            }
            live.settingsWritten();
            return read;
        });
        FakeSocket socket = new FakeSocket("ws-580-handler-gap", "ws://localhost/ws");
        handler.afterConnectionEstablished(socket);
        try {
            assertThat(announcedPairs(socket)).as("premise: the connect frame is the read").startsWith("ollama/m-old");
            // The refresh runs on the connection's own virtual thread: wait for
            // its frame, at most ten seconds.
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
            while (!announcedPairs(socket).contains("ollama/m-new") && System.nanoTime() < deadline) {
                Thread.sleep(20);
            }
            assertThat(announcedPairs(socket)).as("the write during the read reached the chat")
                    .last().isEqualTo("ollama/m-new");
        } finally {
            handler.afterConnectionClosed(socket, CloseStatus.NORMAL);
        }
    }
}
