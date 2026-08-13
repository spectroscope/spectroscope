package dev.spectroscope.core.browser;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.image.ImageStore;
import dev.spectroscope.core.net.NetFence;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.wire.BrowserWireRecorder;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.net.InetAddress;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 204 at the tool seam: driving a browser tool writes the sidecar and emits
 * the additive {@code browser_action} event, and NOTHING the pane answered with
 * beyond what the model read back gets anywhere near the file.
 */
class BrowserToolsRecordingTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** A one-pixel PNG, so the image path is exercised with real bytes. */
    private static final String PNG_BASE64 = Base64.getEncoder().encodeToString(new byte[] {
        (byte) 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D,
        0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, (byte) 0xC4, (byte) 0x89 });

    private static final NetFence.Resolver DNS =
            host -> List.of(InetAddress.getByName("93.184.216.34"));

    /** A face whose replies carry MORE than the model ever sees. */
    private static final class LoudFace implements BrowserFace {
        private final Map<String, Reply> replies;

        LoudFace(Map<String, Reply> replies) {
            this.replies = replies;
        }

        @Override
        public boolean attached() {
            return true;
        }

        @Override
        public String pageUrl() {
            return "https://example.com/app";
        }

        @Override
        public Reply send(String verb, JsonNode args) {
            Reply reply = replies.get(verb);
            return reply == null ? Reply.failed("no scripted reply for " + verb, pageUrl()) : reply;
        }
    }

    private static JsonNode obj(String json) {
        try {
            return JSON.readTree(json);
        } catch (Exception broken) {
            throw new IllegalStateException(broken);
        }
    }

    private static Tool byName(BrowserTools tools, String name) {
        return tools.all().stream().filter(t -> name.equals(t.name())).findFirst().orElseThrow();
    }

    private static List<JsonNode> lines(Path file) throws Exception {
        List<JsonNode> out = new ArrayList<>();
        for (String line : Files.readAllLines(file)) {
            out.add(JSON.readTree(line));
        }
        return out;
    }

    @Test
    void aNavigateWritesItsTwoLinesAndEmitsItsEvent(@TempDir Path dir) throws Exception {
        Path sidecar = dir.resolve("s.browser.jsonl");
        List<RunEvent> events = new ArrayList<>();
        try (BrowserWireRecorder recorder = new BrowserWireRecorder(sidecar, 1 << 20)) {
            BrowserTools tools = new BrowserTools(() -> new LoudFace(Map.of("navigate",
                    BrowserFace.Reply.ok(obj("{\"title\":\"Example\"}"), "https://example.com/app"))),
                    () -> new NetFence(false, DNS), new ImageStore(dir.resolve("images")),
                    () -> recorder);
            String answer = byName(tools, "browser_navigate").execute(
                    obj("{\"url\":\"https://example.com/app\"}"),
                    new Tool.ToolContext(dir, new CancelSignal(), "main", "toolu_7",
                            events::add, a -> { }));
            assertTrue(answer.startsWith("Opened https://example.com/app"), answer);
        }

        List<JsonNode> lines = lines(sidecar);
        JsonNode call = lines.get(1);
        JsonNode result = lines.get(2);
        assertEquals("browser_call", call.path("type").asText());
        assertEquals("browser_navigate", call.path("tool").asText());
        assertEquals("toolu_7", call.path("callId").asText());
        assertEquals("https://example.com/app", call.path("input").path("url").asText());
        assertEquals(call.path("cid").asText(), result.path("cid").asText());
        assertTrue(result.path("ok").asBoolean());

        RunEvent.BrowserAction action = events.stream()
                .filter(RunEvent.BrowserAction.class::isInstance)
                .map(RunEvent.BrowserAction.class::cast).findFirst().orElseThrow();
        assertEquals("browser_navigate", action.tool());
        assertEquals("toolu_7", action.callId());
        assertEquals(call.path("cid").asText(), action.cid(),
                "the event's key is the sidecar's key, or the drill-in has nothing to open");
        assertEquals(1, action.epoch());
        assertTrue(action.ok());
        assertTrue(action.durationMs() >= 0);
    }

    @Test
    void aRefusedCallIsRecordedTooAndSaysSo(@TempDir Path dir) throws Exception {
        // A run worth replaying is usually a run that went wrong. The fence
        // refusal never reaches the browser at all (card 199), so nothing but the
        // recorder would ever know the model tried.
        Path sidecar = dir.resolve("s.browser.jsonl");
        List<RunEvent> events = new ArrayList<>();
        try (BrowserWireRecorder recorder = new BrowserWireRecorder(sidecar, 1 << 20)) {
            BrowserTools tools = new BrowserTools(() -> new LoudFace(Map.of()),
                    () -> new NetFence(false, DNS), new ImageStore(dir.resolve("images")),
                    () -> recorder);
            String answer = byName(tools, "browser_navigate").execute(
                    obj("{\"url\":\"file:///etc/passwd\"}"),
                    new Tool.ToolContext(dir, new CancelSignal(), "main", "toolu_8",
                            events::add, a -> { }));
            assertTrue(answer.startsWith("ERROR:"), answer);
        }

        JsonNode result = lines(sidecar).get(2);
        assertEquals("browser_result", result.path("type").asText());
        assertFalse(result.path("ok").asBoolean(), "a refusal is not an outcome to smooth over");
        assertTrue(result.path("result").asText().startsWith("ERROR:"));
        RunEvent.BrowserAction action = events.stream()
                .filter(RunEvent.BrowserAction.class::isInstance)
                .map(RunEvent.BrowserAction.class::cast).findFirst().orElseThrow();
        assertFalse(action.ok());
    }

    @Test
    void aScreenshotRecordsTheBlobAndNotOneByteOfIt(@TempDir Path dir) throws Exception {
        // The pane's reply carries the picture AND a field nobody asked for. What
        // reaches the record is the model's own result sentence plus the store
        // reference — the reply object crosses no recording signature at all.
        Path sidecar = dir.resolve("s.browser.jsonl");
        List<RunEvent> events = new ArrayList<>();
        try (BrowserWireRecorder recorder = new BrowserWireRecorder(sidecar, 1 << 20)) {
            BrowserTools tools = new BrowserTools(() -> new LoudFace(Map.of("screenshot",
                    BrowserFace.Reply.ok(obj("{\"mediaType\":\"image/png\",\"width\":8,"
                            + "\"height\":8,\"cookies\":\"session=super-secret-value\","
                            + "\"dataBase64\":\"" + PNG_BASE64 + "\"}"),
                            "https://example.com/app"))),
                    () -> new NetFence(false, DNS), new ImageStore(dir.resolve("images")),
                    () -> recorder);
            String answer = byName(tools, "browser_computer").execute(
                    obj("{\"action\":\"screenshot\"}"),
                    new Tool.ToolContext(dir, new CancelSignal(), "main", "toolu_9",
                            events::add, a -> { }));
            assertTrue(answer.startsWith("Screenshot of https://example.com/app"), answer);
        }

        String raw = Files.readString(sidecar);
        assertFalse(raw.contains(PNG_BASE64), "no picture bytes on the sidecar");
        assertFalse(raw.contains("dataBase64"), "not even the field name");
        assertFalse(raw.contains("super-secret-value"),
                "the pane's own reply never crosses the recording seam");
        assertFalse(raw.contains("cookies"), "and neither does anything it invented");

        JsonNode image = lines(sidecar).get(2).path("image");
        assertEquals("image/png", image.path("mediaType").asText());
        assertTrue(image.path("blobPath").asText().startsWith("images/"), image.toString());
        assertEquals(8, image.path("width").asInt());

        // The reference is the SAME blob the image_generated event announced, so
        // a replay can load exactly the picture the model was shown.
        RunEvent.ImageGenerated announced = events.stream()
                .filter(RunEvent.ImageGenerated.class::isInstance)
                .map(RunEvent.ImageGenerated.class::cast).findFirst().orElseThrow();
        RunEvent.BrowserAction action = events.stream()
                .filter(RunEvent.BrowserAction.class::isInstance)
                .map(RunEvent.BrowserAction.class::cast).findFirst().orElseThrow();
        assertEquals(announced.sha256(), image.path("sha256").asText());
        assertEquals(announced.sha256(), action.sha256());
        assertNotNull(announced.blobPath());
    }

    @Test
    void withoutARecorderTheToolsBehaveExactlyAsBefore(@TempDir Path dir) {
        // The CLI, a subagent, a fleet node: no session, no sidecar, and no
        // second code path through the tools.
        List<RunEvent> events = new ArrayList<>();
        BrowserTools tools = new BrowserTools(() -> new LoudFace(Map.of("navigate",
                BrowserFace.Reply.ok(obj("{\"title\":\"Example\"}"), "https://example.com/app"))),
                () -> new NetFence(false, DNS), new ImageStore(dir.resolve("images")));
        String answer = byName(tools, "browser_navigate").execute(
                obj("{\"url\":\"https://example.com/app\"}"),
                new Tool.ToolContext(dir, new CancelSignal(), "main", "toolu_0",
                        events::add, a -> { }));

        assertTrue(answer.startsWith("Opened https://example.com/app"), answer);
        RunEvent.BrowserAction action = events.stream()
                .filter(RunEvent.BrowserAction.class::isInstance)
                .map(RunEvent.BrowserAction.class::cast).findFirst().orElseThrow();
        assertEquals(0, action.epoch(), "nothing recorded it, and the event says so");
        assertFalse(action.cid().isBlank());
    }
}
