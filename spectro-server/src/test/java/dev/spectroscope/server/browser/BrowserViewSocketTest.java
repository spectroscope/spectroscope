package dev.spectroscope.server.browser;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.browser.headless.HeadlessBrowserFaces;
import dev.spectroscope.core.net.NetFence;
import dev.spectroscope.server.session.FakeSocket;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.web.socket.TextMessage;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The picture channel of the web face (card 226): {@code /ws/browser-view},
 * the wire the UI half builds its browser segment against.
 *
 * <p>The wire shape pinned here IS the contract: {@code watch} answers a
 * {@code state} frame and starts the screencast when a page is open;
 * {@code frame} messages carry base64 jpeg with device dimensions; {@code
 * input}, {@code navigate}, {@code back} and {@code forward} are answered by
 * {@code verb} frames; a fence refusal is its own {@code refused} frame so the
 * segment can show the sentence; and with the desktop pane live, the channel
 * says so and streams nothing — one browser per session, never two.
 */
class BrowserViewSocketTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String SESSION = "20260814-120000-cafecafe";

    private final Map<String, PrecedenceBrowserFacesTest.QuietCdp> engines =
            new ConcurrentHashMap<>();

    private HeadlessBrowserFaces headless(Path base) {
        return new HeadlessBrowserFaces(
                () -> java.util.Optional.of(Path.of("/usr/bin/true")), base, url -> null,
                (sessionId, profileDir) -> {
                    PrecedenceBrowserFacesTest.QuietCdp cdp =
                            new PrecedenceBrowserFacesTest.QuietCdp();
                    engines.put(sessionId, cdp);
                    return new HeadlessBrowserFaces.Engine() {
                        @Override
                        public dev.spectroscope.core.browser.headless.HeadlessBrowserFace.Cdp cdp() {
                            return cdp;
                        }

                        @Override
                        public void kill() {
                        }
                    };
                });
    }

    private static PrecedenceBrowserFaces faces(HeadlessBrowserFaces web,
            AtomicBoolean desktopUp, java.util.function.Function<String, NetFence.Refusal> judge) {
        return new PrecedenceBrowserFaces(dev.spectroscope.core.browser.BrowserFaces.none(),
                desktopUp::get, web, judge);
    }

    private static JsonNode lastOfType(FakeSocket viewer, String type) {
        JsonNode found = null;
        for (String line : viewer.textJoined().split("\n")) {
            if (line.isBlank()) {
                continue;
            }
            try {
                JsonNode frame = JSON.readTree(line);
                if (type.equals(frame.path("type").asText())) {
                    found = frame;
                }
            } catch (Exception notJson) {
                throw new AssertionError("the view socket must speak JSON: " + line);
            }
        }
        return found;
    }

    private static void tell(BrowserViewSocket socket, FakeSocket viewer, String json)
            throws Exception {
        socket.handleTextMessage(viewer, new TextMessage(json));
    }

    @Test
    void watchAnswersAStateFrameNamingTheLiveFace(@TempDir Path base) throws Exception {
        BrowserViewSocket socket = new BrowserViewSocket(
                faces(headless(base), new AtomicBoolean(false), url -> null));
        FakeSocket viewer = new FakeSocket("view-1", "ws://127.0.0.1:8746/ws/browser-view");
        socket.afterConnectionEstablished(viewer);
        tell(socket, viewer, "{\"type\":\"watch\",\"sessionId\":\"" + SESSION + "\"}");

        JsonNode state = lastOfType(viewer, "state");
        assertEquals("web", state.path("live").asText());
        assertEquals(SESSION, state.path("sessionId").asText());
        assertTrue(state.path("attached").asBoolean());
        assertTrue(engines.isEmpty(),
                "watching an idle session must not cost a Chrome process");
    }

    @Test
    void navigateRunsTheFenceFirstAndARefusalIsItsOwnFrame(@TempDir Path base) throws Exception {
        BrowserViewSocket socket = new BrowserViewSocket(
                faces(headless(base), new AtomicBoolean(false),
                        url -> url.contains("192.168.")
                                ? new NetFence.Refusal("192.168.1.1", "rfc1918",
                                        "refused 192.168.1.1: it is a private network address, "
                                                + "RFC 1918 (rule: rfc1918).")
                                : null));
        FakeSocket viewer = new FakeSocket("view-1", "ws://127.0.0.1:8746/ws/browser-view");
        socket.afterConnectionEstablished(viewer);
        tell(socket, viewer, "{\"type\":\"watch\",\"sessionId\":\"" + SESSION + "\"}");

        tell(socket, viewer, "{\"type\":\"navigate\",\"sessionId\":\"" + SESSION
                + "\",\"url\":\"http://192.168.1.1/admin\"}");
        JsonNode refused = lastOfType(viewer, "refused");
        assertTrue(refused.path("sentence").asText().contains("rfc1918"),
                "the segment shows the fence's own sentence: " + refused);
        assertTrue(engines.isEmpty(), "a refused navigate must not spawn an engine");

        tell(socket, viewer, "{\"type\":\"navigate\",\"sessionId\":\"" + SESSION
                + "\",\"url\":\"http://dev.example.com/\"}");
        JsonNode verb = lastOfType(viewer, "verb");
        assertEquals("navigate", verb.path("verb").asText());
        assertTrue(verb.path("ok").asBoolean(), verb.toString());
        JsonNode state = lastOfType(viewer, "state");
        assertEquals("web", state.path("live").asText());
    }

    @Test
    void inputIsForwardedToTheFaceInTheToolsOwnDialect(@TempDir Path base) throws Exception {
        BrowserViewSocket socket = new BrowserViewSocket(
                faces(headless(base), new AtomicBoolean(false), url -> null));
        FakeSocket viewer = new FakeSocket("view-1", "ws://127.0.0.1:8746/ws/browser-view");
        socket.afterConnectionEstablished(viewer);
        tell(socket, viewer, "{\"type\":\"navigate\",\"sessionId\":\"" + SESSION
                + "\",\"url\":\"http://dev.example.com/\"}");

        tell(socket, viewer, "{\"type\":\"input\",\"sessionId\":\"" + SESSION
                + "\",\"action\":\"left_click\",\"coordinate\":[10,20]}");
        JsonNode verb = lastOfType(viewer, "verb");
        assertEquals("input", verb.path("verb").asText());
        assertTrue(verb.path("ok").asBoolean(), verb.toString());
        assertTrue(engines.get(SESSION).called.contains("Input.dispatchMouseEvent"),
                "the click must reach the page over CDP");
    }

    @Test
    void framesFlowAfterAWatchOnAPageAndStopOnUnwatch(@TempDir Path base) throws Exception {
        BrowserViewSocket socket = new BrowserViewSocket(
                faces(headless(base), new AtomicBoolean(false), url -> null));
        FakeSocket viewer = new FakeSocket("view-1", "ws://127.0.0.1:8746/ws/browser-view");
        socket.afterConnectionEstablished(viewer);
        tell(socket, viewer, "{\"type\":\"navigate\",\"sessionId\":\"" + SESSION
                + "\",\"url\":\"http://dev.example.com/\"}");
        tell(socket, viewer, "{\"type\":\"watch\",\"sessionId\":\"" + SESSION + "\"}");

        PrecedenceBrowserFacesTest.QuietCdp cdp = engines.get(SESSION);
        assertTrue(cdp.called.contains("Page.startScreencast"),
                "a watch on an open page starts the cast");

        cdp.listeners.getOrDefault("Page.screencastFrame", List.of())
                .forEach(l -> l.accept(JSON.createObjectNode()
                        .put("data", "aGVsbG8=")
                        .put("sessionId", 7)
                        .<com.fasterxml.jackson.databind.node.ObjectNode>set("metadata",
                                JSON.createObjectNode()
                                        .put("deviceWidth", 1280).put("deviceHeight", 800)
                                        .put("timestamp", 1.0))));
        JsonNode frame = lastOfType(viewer, "frame");
        assertEquals("aGVsbG8=", frame.path("dataBase64").asText());
        assertEquals("jpeg", frame.path("format").asText());
        assertEquals(1280, frame.path("deviceWidth").asInt());
        assertEquals(SESSION, frame.path("sessionId").asText());
        assertTrue(cdp.called.contains("Page.screencastFrameAck"),
                "every frame is acked or Chrome stops sending");

        tell(socket, viewer, "{\"type\":\"unwatch\"}");
        assertTrue(cdp.called.contains("Page.stopScreencast"));
    }

    @Test
    void withTheDesktopPaneLiveTheChannelSaysSoAndDrivesNothing(@TempDir Path base)
            throws Exception {
        AtomicBoolean desktopUp = new AtomicBoolean(true);
        BrowserViewSocket socket = new BrowserViewSocket(
                faces(headless(base), desktopUp, url -> null));
        FakeSocket viewer = new FakeSocket("view-1", "ws://127.0.0.1:8746/ws/browser-view");
        socket.afterConnectionEstablished(viewer);

        tell(socket, viewer, "{\"type\":\"watch\",\"sessionId\":\"" + SESSION + "\"}");
        JsonNode state = lastOfType(viewer, "state");
        assertEquals("desktop", state.path("live").asText(),
                "the web face says which face is live so the UI can say it");

        tell(socket, viewer, "{\"type\":\"input\",\"sessionId\":\"" + SESSION
                + "\",\"action\":\"left_click\",\"coordinate\":[1,1]}");
        JsonNode refused = lastOfType(viewer, "refused");
        assertTrue(refused.path("sentence").asText().contains("desktop"),
                "never two engines racing: " + refused);
        assertTrue(engines.isEmpty());
    }

    @Test
    void aViewerGoingAwayStopsItsCast(@TempDir Path base) throws Exception {
        BrowserViewSocket socket = new BrowserViewSocket(
                faces(headless(base), new AtomicBoolean(false), url -> null));
        FakeSocket viewer = new FakeSocket("view-1", "ws://127.0.0.1:8746/ws/browser-view");
        socket.afterConnectionEstablished(viewer);
        tell(socket, viewer, "{\"type\":\"navigate\",\"sessionId\":\"" + SESSION
                + "\",\"url\":\"http://dev.example.com/\"}");
        tell(socket, viewer, "{\"type\":\"watch\",\"sessionId\":\"" + SESSION + "\"}");
        socket.afterConnectionClosed(viewer,
                org.springframework.web.socket.CloseStatus.NORMAL);
        assertTrue(engines.get(SESSION).called.contains("Page.stopScreencast"),
                "an unwatched cast is work nobody reads");
    }

    @Test
    void nonsenseIsAnsweredWithAnErrorFrameNotSilence(@TempDir Path base) throws Exception {
        BrowserViewSocket socket = new BrowserViewSocket(
                faces(headless(base), new AtomicBoolean(false), url -> null));
        FakeSocket viewer = new FakeSocket("view-1", "ws://127.0.0.1:8746/ws/browser-view");
        socket.afterConnectionEstablished(viewer);
        tell(socket, viewer, "not json");
        tell(socket, viewer, "{\"type\":\"teleport\",\"sessionId\":\"x\"}");
        JsonNode error = lastOfType(viewer, "error");
        assertFalse(error.path("sentence").asText().isBlank());
    }
}
