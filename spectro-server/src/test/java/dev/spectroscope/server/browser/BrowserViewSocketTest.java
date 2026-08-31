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
                faces(headless(base), new AtomicBoolean(false), url -> null), new SessionBrowserBridge());
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
                                : null), new SessionBrowserBridge());
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
                faces(headless(base), new AtomicBoolean(false), url -> null), new SessionBrowserBridge());
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
                faces(headless(base), new AtomicBoolean(false), url -> null), new SessionBrowserBridge());
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
                faces(headless(base), desktopUp, url -> null), new SessionBrowserBridge());
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
                faces(headless(base), new AtomicBoolean(false), url -> null), new SessionBrowserBridge());
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
                faces(headless(base), new AtomicBoolean(false), url -> null), new SessionBrowserBridge());
        FakeSocket viewer = new FakeSocket("view-1", "ws://127.0.0.1:8746/ws/browser-view");
        socket.afterConnectionEstablished(viewer);
        tell(socket, viewer, "not json");
        tell(socket, viewer, "{\"type\":\"teleport\",\"sessionId\":\"x\"}");
        JsonNode error = lastOfType(viewer, "error");
        assertFalse(error.path("sentence").asText().isBlank());
    }

    // ---- card 227: the operator's controls on BOTH faces -------------------

    /** A desktop directory that records every verb, for the routing proofs. */
    static final class RecordingDesktop implements dev.spectroscope.core.browser.BrowserFaces {
        final List<String> verbs = new CopyOnWriteArrayList<>();
        volatile String url;

        @Override
        public boolean attached() {
            return true;
        }

        @Override
        public dev.spectroscope.core.browser.BrowserFace forSession(String sessionId) {
            return new dev.spectroscope.core.browser.BrowserFace() {
                @Override
                public boolean attached() {
                    return true;
                }

                @Override
                public String pageUrl() {
                    return url;
                }

                @Override
                public Reply send(String verb, JsonNode args) {
                    verbs.add(verb);
                    com.fasterxml.jackson.databind.node.ObjectNode value = JSON.createObjectNode();
                    if ("navigate".equals(verb)) {
                        url = args.path("url").asText();
                        value.put("url", url);
                    }
                    if ("screenshot".equals(verb)) {
                        value.put("mediaType", "image/png").put("dataBase64", "cGln")
                                .put("width", 2).put("height", 1);
                    }
                    return Reply.ok(value, url);
                }
            };
        }

        @Override
        public void closeSession(String sessionId) {
        }

        /** The real cache is BrowserControlSocket.pageUrls, and its rule is the
         *  one mirrored here: written from a reply's NON-NULL pageUrl, so a
         *  shell can never report "no page" through a reply, and cleared only
         *  by this method (card 346). */
        @Override
        public void forgetPage(String sessionId) {
            url = null;
        }
    }

    private static JsonNode awaitType(FakeSocket viewer, String type) throws Exception {
        long deadline = System.currentTimeMillis() + 5_000;
        while (System.currentTimeMillis() < deadline && !Thread.currentThread().isInterrupted()) {
            JsonNode found = lastOfType(viewer, type);
            if (found != null) {
                return found;
            }
            Thread.sleep(20);
        }
        throw new AssertionError("no " + type + " frame arrived: " + viewer.textJoined());
    }

    @Test
    void theEntryJudgeFiresForTheDesktopFaceToo(@TempDir Path base) throws Exception {
        // Criterion 3: the fence holds identically for a human-typed address,
        // no matter which face serves it. A refused address must never reach
        // the pane — refused BEFORE routing, with the fence's own sentence.
        RecordingDesktop desktop = new RecordingDesktop();
        BrowserViewSocket socket = new BrowserViewSocket(new PrecedenceBrowserFaces(
                desktop, () -> true, headless(base),
                url -> url.contains("localhost")
                        ? new NetFence.Refusal("localhost", "loopback",
                                "refused localhost: allowLocalhost is off.")
                        : null),
                new SessionBrowserBridge());
        FakeSocket viewer = new FakeSocket("view-1", "ws://127.0.0.1:8746/ws/browser-view");
        socket.afterConnectionEstablished(viewer);

        tell(socket, viewer, "{\"type\":\"navigate\",\"sessionId\":\"" + SESSION
                + "\",\"url\":\"http://localhost:5173/\"}");
        JsonNode refused = lastOfType(viewer, "refused");
        assertTrue(refused.path("sentence").asText().contains("allowLocalhost"),
                "the refusal names the setting: " + refused);
        assertTrue(desktop.verbs.isEmpty(), "a refused address must never reach the pane");
    }

    @Test
    void navigateBackForwardAndScreenshotDriveTheDesktopPane(@TempDir Path base) throws Exception {
        // Criterion 1: the desktop face gains the same control row — the verbs
        // travel this same channel and route to the pane, never a second engine.
        RecordingDesktop desktop = new RecordingDesktop();
        BrowserViewSocket socket = new BrowserViewSocket(new PrecedenceBrowserFaces(
                desktop, () -> true, headless(base), url -> null), new SessionBrowserBridge());
        FakeSocket viewer = new FakeSocket("view-1", "ws://127.0.0.1:8746/ws/browser-view");
        socket.afterConnectionEstablished(viewer);

        tell(socket, viewer, "{\"type\":\"navigate\",\"sessionId\":\"" + SESSION
                + "\",\"url\":\"http://dev.example.com/\"}");
        tell(socket, viewer, "{\"type\":\"back\",\"sessionId\":\"" + SESSION + "\"}");
        tell(socket, viewer, "{\"type\":\"forward\",\"sessionId\":\"" + SESSION + "\"}");
        tell(socket, viewer, "{\"type\":\"screenshot\",\"sessionId\":\"" + SESSION + "\"}");

        assertEquals(List.of("navigate", "back", "forward", "screenshot"), desktop.verbs,
                "the operator's verbs route to the live desktop face");
        assertTrue(engines.isEmpty(), "never a second engine while the pane is live");
        JsonNode verb = lastOfType(viewer, "verb");
        assertEquals("screenshot", verb.path("verb").asText());
        assertEquals("cGln", verb.path("dataBase64").asText(),
                "the shot travels back to the control row");
        // CARD 344 (d), THE PART THAT WAS WRITTEN DOWN WRONG. The back-fill
        // that answerVerb used to run was said to have reached only `input`.
        // It reached this verb too, and for the same two reasons: a screenshot
        // value carries mediaType/dataBase64/width/height and no `url`, while
        // pageUrl() names the page it was taken on. So dropping the back-fill
        // changed this answer as well — a screenshot no longer names an
        // address — and this is where that change is recorded rather than
        // left to be rediscovered. Nothing reads it: the address is the state
        // frame's to say, and on this face the status poll's besides.
        assertFalse(verb.has("url"),
                "a screenshot answers with an image, not with an address: " + verb);
    }

    @Test
    void anAgentInFlightLocksTheOperatorOutWithOneSentence(@TempDir Path base) throws Exception {
        // Criterion 5, the decision pinned on the card: while an agent browser
        // call is in flight, human driving is refused with one terse sentence;
        // between calls the controls are live again.
        SessionBrowserBridge bridge = new SessionBrowserBridge();
        dev.spectroscope.core.wire.BrowserWireTap guarded =
                bridge.agentGuard(() -> SESSION, dev.spectroscope.core.wire.BrowserWireTap::none);
        BrowserViewSocket socket = new BrowserViewSocket(
                faces(headless(base), new AtomicBoolean(false), url -> null), bridge);
        FakeSocket viewer = new FakeSocket("view-1", "ws://127.0.0.1:8746/ws/browser-view");
        socket.afterConnectionEstablished(viewer);

        dev.spectroscope.core.wire.BrowserWireTap.Call inFlight =
                guarded.open("browser_navigate", "main", "t1", null, null);
        tell(socket, viewer, "{\"type\":\"navigate\",\"sessionId\":\"" + SESSION
                + "\",\"url\":\"http://dev.example.com/\"}");
        JsonNode refused = lastOfType(viewer, "refused");
        assertTrue(refused.path("sentence").asText().contains("agent"),
                "the sentence says who holds the browser: " + refused);
        assertTrue(engines.isEmpty(), "a locked-out navigate must not spawn an engine");

        inFlight.end(true, "opened", null);
        tell(socket, viewer, "{\"type\":\"navigate\",\"sessionId\":\"" + SESSION
                + "\",\"url\":\"http://dev.example.com/\"}");
        JsonNode verb = lastOfType(viewer, "verb");
        assertTrue(verb.path("ok").asBoolean(), "between calls the operator drives: " + verb);
    }

    @Test
    void anOperatorNavigateLandsInTheSidecarAsOperator(@TempDir Path base) throws Exception {
        // Criterion 4: a replay must not attribute a human's navigation to the
        // model. The operator's verb records through the SESSION's own recorder
        // (same file, same epoch) with the one additive actor field.
        Path sidecar = base.resolve("s.browser.jsonl");
        dev.spectroscope.core.wire.BrowserWireRecorder recorder =
                new dev.spectroscope.core.wire.BrowserWireRecorder(sidecar, 1 << 20);
        SessionBrowserBridge bridge = new SessionBrowserBridge();
        bridge.register(SESSION, new SessionBrowserBridge.Live(recorder,
                new dev.spectroscope.core.launch.LaunchSupervisor((host, port) -> true),
                () -> base));
        BrowserViewSocket socket = new BrowserViewSocket(
                faces(headless(base), new AtomicBoolean(false), url -> null), bridge);
        FakeSocket viewer = new FakeSocket("view-1", "ws://127.0.0.1:8746/ws/browser-view");
        socket.afterConnectionEstablished(viewer);

        tell(socket, viewer, "{\"type\":\"navigate\",\"sessionId\":\"" + SESSION
                + "\",\"url\":\"http://dev.example.com/\"}");

        List<JsonNode> lines = new java.util.ArrayList<>();
        for (String line : java.nio.file.Files.readAllLines(sidecar)) {
            lines.add(JSON.readTree(line));
        }
        JsonNode call = lines.stream()
                .filter(l -> "browser_call".equals(l.path("type").asText()))
                .findFirst().orElseThrow(() -> new AssertionError("no call line"));
        assertEquals("operator", call.path("actor").asText(),
                "the human's navigation says who drove: " + call);
        assertEquals("navigate", call.path("tool").asText());
        assertEquals("http://dev.example.com/", call.path("input").path("url").asText());
        assertTrue(lines.stream().anyMatch(l -> "browser_result".equals(l.path("type").asText())),
                "the operator's call closes like any other");
    }

    @Test
    void launchListAnswersTheSessionsConfigurationsWithTheirState(@TempDir Path base)
            throws Exception {
        // Criterion 2, the data half: the start page lists the session's launch
        // configurations with their addresses and whether they are up NOW.
        Path project = base.resolve("project");
        java.nio.file.Files.createDirectories(project.resolve(".claude"));
        java.nio.file.Files.writeString(project.resolve(".claude/launch.json"), """
                {"version":"0.0.1","configurations":[
                  {"name":"web","runtimeExecutable":"npm","runtimeArgs":["run","dev"],"port":5173},
                  {"name":"api","url":"http://localhost:9999/"}]}
                """);
        SessionBrowserBridge bridge = new SessionBrowserBridge();
        bridge.register(SESSION, new SessionBrowserBridge.Live(
                dev.spectroscope.core.wire.BrowserWireTap.none(),
                new dev.spectroscope.core.launch.LaunchSupervisor((host, port) -> true),
                () -> project));
        BrowserViewSocket socket = new BrowserViewSocket(
                faces(headless(base), new AtomicBoolean(false), url -> null), bridge);
        FakeSocket viewer = new FakeSocket("view-1", "ws://127.0.0.1:8746/ws/browser-view");
        socket.afterConnectionEstablished(viewer);

        tell(socket, viewer, "{\"type\":\"launch_list\",\"sessionId\":\"" + SESSION + "\"}");
        JsonNode answer = lastOfType(viewer, "launch_configs");
        assertTrue(answer.path("ok").asBoolean(), answer.toString());
        JsonNode configs = answer.path("configs");
        assertEquals(2, configs.size());
        assertEquals("web", configs.get(0).path("name").asText());
        assertEquals("http://localhost:5173/", configs.get(0).path("address").asText());
        assertFalse(configs.get(0).path("up").asBoolean());
        assertFalse(configs.get(0).path("attaches").asBoolean());
        assertTrue(configs.get(1).path("attaches").asBoolean());
    }

    @Test
    void launchListNamesTheFileItReadAndTheOneItPassedOver(@TempDir Path base)
            throws Exception {
        // Card 350: the operator has to be able to see WHICH of the two launch
        // files answered. Without it the precedence is invisible from the app,
        // which is the silent disagreement the card was cut to prevent.
        Path project = base.resolve("project");
        java.nio.file.Files.createDirectories(project.resolve(".claude"));
        java.nio.file.Files.writeString(project.resolve(".claude/launch.json"), """
                {"version":"0.0.1","configurations":[{"name":"theirs","port":9999}]}
                """);
        dev.spectroscope.core.launch.LaunchWriter.write(project, java.util.List.of(
                new dev.spectroscope.core.launch.LaunchEntry("ours", 5173, "npm",
                        java.util.List.of("run", "dev"), null, java.util.List.of())));
        SessionBrowserBridge bridge = new SessionBrowserBridge();
        bridge.register(SESSION, new SessionBrowserBridge.Live(
                dev.spectroscope.core.wire.BrowserWireTap.none(),
                new dev.spectroscope.core.launch.LaunchSupervisor((host, port) -> true),
                () -> project));
        BrowserViewSocket socket = new BrowserViewSocket(
                faces(headless(base), new AtomicBoolean(false), url -> null), bridge);
        FakeSocket viewer = new FakeSocket("view-1", "ws://127.0.0.1:8746/ws/browser-view");
        socket.afterConnectionEstablished(viewer);

        tell(socket, viewer, "{\"type\":\"launch_list\",\"sessionId\":\"" + SESSION + "\"}");
        JsonNode answer = lastOfType(viewer, "launch_configs");

        assertEquals(".spectro/launch.json", answer.path("location").asText(), answer.toString());
        assertEquals(1, answer.path("shadowed").size(), answer.toString());
        assertEquals(".claude/launch.json", answer.path("shadowed").get(0).asText());
        assertEquals(1, answer.path("configs").size());
        assertEquals("ours", answer.path("configs").get(0).path("name").asText(),
                "ours wins whole — a merge would have carried theirs too: " + answer);
    }

    @Test
    void launchListWithoutALiveSessionOrFileSaysSo(@TempDir Path base) throws Exception {
        BrowserViewSocket socket = new BrowserViewSocket(
                faces(headless(base), new AtomicBoolean(false), url -> null),
                new SessionBrowserBridge());
        FakeSocket viewer = new FakeSocket("view-1", "ws://127.0.0.1:8746/ws/browser-view");
        socket.afterConnectionEstablished(viewer);

        tell(socket, viewer, "{\"type\":\"launch_list\",\"sessionId\":\"" + SESSION + "\"}");
        JsonNode answer = lastOfType(viewer, "launch_configs");
        assertFalse(answer.path("ok").asBoolean());
        assertFalse(answer.path("sentence").asText().isBlank(),
                "why there is nothing is said, not implied: " + answer);
    }

    @Test
    void launchPlayBringsTheConfigUpAndOpensTheBrowserOnIt(@TempDir Path base) throws Exception {
        // Criterion 2, the verb half: press play, the config starts, the
        // browser opens its URL — through the session's own supervisor and the
        // session's own face, recorded as the operator's navigation.
        Path project = base.resolve("project");
        java.nio.file.Files.createDirectories(project.resolve(".claude"));
        java.nio.file.Files.writeString(project.resolve(".claude/launch.json"), """
                {"version":"0.0.1","configurations":[
                  {"name":"api","url":"http://api.example.com:9999/"}]}
                """);
        Path sidecar = base.resolve("s.browser.jsonl");
        SessionBrowserBridge bridge = new SessionBrowserBridge();
        bridge.register(SESSION, new SessionBrowserBridge.Live(
                new dev.spectroscope.core.wire.BrowserWireRecorder(sidecar, 1 << 20),
                new dev.spectroscope.core.launch.LaunchSupervisor((host, port) -> true),
                () -> project));
        BrowserViewSocket socket = new BrowserViewSocket(
                faces(headless(base), new AtomicBoolean(false), url -> null), bridge);
        FakeSocket viewer = new FakeSocket("view-1", "ws://127.0.0.1:8746/ws/browser-view");
        socket.afterConnectionEstablished(viewer);

        tell(socket, viewer, "{\"type\":\"launch_play\",\"sessionId\":\"" + SESSION
                + "\",\"name\":\"api\"}");
        JsonNode played = awaitType(viewer, "launch_played");
        assertTrue(played.path("ok").asBoolean(), played.toString());
        assertEquals("api", played.path("name").asText());
        assertEquals("http://api.example.com:9999/", played.path("url").asText());
        assertTrue(engines.containsKey(SESSION), "the browser really opened the address");
        String lines = java.nio.file.Files.readString(sidecar);
        assertTrue(lines.contains("\"actor\":\"operator\""),
                "the play button's navigation is the operator's, on the record");
    }

    @Test
    void launchPlayMissNamesTheFileThatAnsweredRatherThanBoth(@TempDir Path base)
            throws Exception {
        // Card 350: the reader already knows which of the two files answered, and
        // location() is in hand at this point. Naming both sends the operator to
        // open a file that is not the one his name was looked up in.
        Path project = base.resolve("project");
        java.nio.file.Files.createDirectories(project.resolve(".claude"));
        java.nio.file.Files.writeString(project.resolve(".claude/launch.json"), """
                {"version":"0.0.1","configurations":[{"name":"api","port":9999}]}
                """);
        SessionBrowserBridge bridge = new SessionBrowserBridge();
        bridge.register(SESSION, new SessionBrowserBridge.Live(
                dev.spectroscope.core.wire.BrowserWireTap.none(),
                new dev.spectroscope.core.launch.LaunchSupervisor((host, port) -> true),
                () -> project));
        BrowserViewSocket socket = new BrowserViewSocket(
                faces(headless(base), new AtomicBoolean(false), url -> null), bridge);
        FakeSocket viewer = new FakeSocket("view-1", "ws://127.0.0.1:8746/ws/browser-view");
        socket.afterConnectionEstablished(viewer);

        tell(socket, viewer, "{\"type\":\"launch_play\",\"sessionId\":\"" + SESSION
                + "\",\"name\":\"nope\"}");
        JsonNode played = awaitType(viewer, "launch_played");

        assertFalse(played.path("ok").asBoolean(), played.toString());
        String sentence = played.path("sentence").asText();
        assertTrue(sentence.contains(".claude/launch.json"),
                "the file that actually answered: " + sentence);
        assertFalse(sentence.contains(".spectro/launch.json"),
                "this project has no file of ours; sending him there is a wrong turn: "
                        + sentence);
    }

    @Test
    void launchPlayInAProjectWithNoLaunchFileSaysThatRatherThanNamingAMiss(@TempDir Path base)
            throws Exception {
        // The other half of the same branch: with NO file at all there is no
        // location to name, so the sentence has to be the "carries none" one and
        // it has to name both places a file may go.
        Path project = base.resolve("project");
        java.nio.file.Files.createDirectories(project);
        SessionBrowserBridge bridge = new SessionBrowserBridge();
        bridge.register(SESSION, new SessionBrowserBridge.Live(
                dev.spectroscope.core.wire.BrowserWireTap.none(),
                new dev.spectroscope.core.launch.LaunchSupervisor((host, port) -> true),
                () -> project));
        BrowserViewSocket socket = new BrowserViewSocket(
                faces(headless(base), new AtomicBoolean(false), url -> null), bridge);
        FakeSocket viewer = new FakeSocket("view-1", "ws://127.0.0.1:8746/ws/browser-view");
        socket.afterConnectionEstablished(viewer);

        tell(socket, viewer, "{\"type\":\"launch_play\",\"sessionId\":\"" + SESSION
                + "\",\"name\":\"nope\"}");
        JsonNode played = awaitType(viewer, "launch_played");

        assertFalse(played.path("ok").asBoolean(), played.toString());
        String sentence = played.path("sentence").asText();
        assertTrue(sentence.contains(".spectro/launch.json")
                && sentence.contains(".claude/launch.json"),
                "with no file at all, both places have to be named: " + sentence);
        assertFalse(sentence.contains("no configuration of that name"),
                "there is no file to have missed a name in: " + sentence);
    }

    @Test
    void launchPlayWithTheFenceClosedStartsTheServerAndKeepsTheBrowserAway(@TempDir Path base)
            throws Exception {
        // Card 202's split, held for the play button too: the server comes up,
        // the browser stays away, and the sentence names the one setting.
        Path project = base.resolve("project");
        java.nio.file.Files.createDirectories(project.resolve(".claude"));
        java.nio.file.Files.writeString(project.resolve(".claude/launch.json"), """
                {"version":"0.0.1","configurations":[
                  {"name":"api","url":"http://localhost:9999/"}]}
                """);
        SessionBrowserBridge bridge = new SessionBrowserBridge();
        bridge.register(SESSION, new SessionBrowserBridge.Live(
                dev.spectroscope.core.wire.BrowserWireTap.none(),
                new dev.spectroscope.core.launch.LaunchSupervisor((host, port) -> true),
                () -> project));
        BrowserViewSocket socket = new BrowserViewSocket(
                faces(headless(base), new AtomicBoolean(false),
                        url -> url.contains("localhost")
                                ? new NetFence.Refusal("localhost", "loopback",
                                        "refused localhost: allowLocalhost is off.")
                                : null),
                bridge);
        FakeSocket viewer = new FakeSocket("view-1", "ws://127.0.0.1:8746/ws/browser-view");
        socket.afterConnectionEstablished(viewer);

        tell(socket, viewer, "{\"type\":\"launch_play\",\"sessionId\":\"" + SESSION
                + "\",\"name\":\"api\"}");
        JsonNode played = awaitType(viewer, "launch_played");
        assertFalse(played.path("ok").asBoolean(), played.toString());
        assertTrue(played.path("sentence").asText().contains("allowLocalhost"),
                "the sentence names the setting: " + played);
        assertTrue(played.path("up").asBoolean(),
                "the config itself is up — only the browser stayed away");
        assertTrue(engines.isEmpty(), "no engine dials a refused address");
    }

    // ---- cards 344 and 346: what the row says, and closing the page --------

    @Test
    void theStateFrameCarriesWhereTheHistoryCanGo(@TempDir Path base) throws Exception {
        // Card 344 (c). The toolbar had no disabled states at all, so the
        // operator learned "there is no history" by pressing a control and
        // reading a red alert. The web face knows the answer; it now says it.
        BrowserViewSocket socket = new BrowserViewSocket(
                faces(headless(base), new AtomicBoolean(false), url -> null),
                new SessionBrowserBridge());
        FakeSocket viewer = new FakeSocket("view-1", "ws://127.0.0.1:8746/ws/browser-view");
        socket.afterConnectionEstablished(viewer);

        tell(socket, viewer, "{\"type\":\"watch\",\"sessionId\":\"" + SESSION + "\"}");
        JsonNode idle = lastOfType(viewer, "state");
        assertTrue(idle.hasNonNull("canGoBack"), "the frame must carry the field: " + idle);
        assertFalse(idle.path("canGoBack").asBoolean(),
                "a browser with no page has nothing earlier: " + idle);
        assertFalse(idle.path("canGoForward").asBoolean(), idle.toString());
        assertTrue(engines.isEmpty(), "and asking must not cost a Chrome process");
    }

    @Test
    void theDesktopFaceSaysNothingAboutItsHistoryRatherThanGuessing(@TempDir Path base)
            throws Exception {
        // The honest floor, card 344 (c). The desktop shell pushes no
        // navigation up its control channel, so any boolean here would be a
        // cache that goes stale the moment the operator clicks a link on the
        // real pane — and a stale false is a dead button over a working page.
        // Null travels, the UI leaves the control alone.
        RecordingDesktop desktop = new RecordingDesktop();
        BrowserViewSocket socket = new BrowserViewSocket(new PrecedenceBrowserFaces(
                desktop, () -> true, headless(base), url -> null), new SessionBrowserBridge());
        FakeSocket viewer = new FakeSocket("view-1", "ws://127.0.0.1:8746/ws/browser-view");
        socket.afterConnectionEstablished(viewer);

        tell(socket, viewer, "{\"type\":\"watch\",\"sessionId\":\"" + SESSION + "\"}");
        JsonNode state = lastOfType(viewer, "state");
        assertEquals("desktop", state.path("live").asText());
        assertTrue(state.has("canGoBack"), "the field is on the wire on both faces: " + state);
        assertTrue(state.path("canGoBack").isNull(),
                "and it is null where nothing fresh can be known: " + state);
        assertTrue(state.path("canGoForward").isNull(), state.toString());
    }

    @Test
    void aPageThatMovesByItselfPushesAFreshStateFrame(@TempDir Path base) throws Exception {
        // Card 344 (d). Click a link inside the streamed picture and the
        // picture repainted while the address bar kept the old address: state
        // frames are pushed on five occasions and a page-initiated navigation
        // is none of them. Now the face announces it.
        BrowserViewSocket socket = new BrowserViewSocket(
                faces(headless(base), new AtomicBoolean(false), url -> null),
                new SessionBrowserBridge());
        FakeSocket viewer = new FakeSocket("view-1", "ws://127.0.0.1:8746/ws/browser-view");
        socket.afterConnectionEstablished(viewer);
        tell(socket, viewer, "{\"type\":\"navigate\",\"sessionId\":\"" + SESSION
                + "\",\"url\":\"http://dev.example.com/\"}");
        tell(socket, viewer, "{\"type\":\"watch\",\"sessionId\":\"" + SESSION + "\"}");

        engines.get(SESSION).listeners.getOrDefault("Page.frameNavigated", List.of())
                .forEach(l -> l.accept(JSON.createObjectNode()
                        .<com.fasterxml.jackson.databind.node.ObjectNode>set("frame",
                                JSON.createObjectNode().put("url", "http://dev.example.com/deep"))));

        JsonNode state = awaitState(viewer, "http://dev.example.com/deep");
        assertEquals("http://dev.example.com/deep", state.path("url").asText(),
                "the address follows the page: " + state);
    }

    @Test
    void aClickThatMovesThePageIsFollowedByAStateFrameAndTheAnswerNamesNoAddress(
            @TempDir Path base) throws Exception {
        // THE OTHER HALF OF (d), AND THE NAME IS THE POINT. This test used to be
        // called aClickThatMovesThePageAnswersWithWhereItLanded and it fired
        // Page.frameNavigated BEFORE the click — so the page had already moved
        // and the click moved nothing. It could not go red for the thing it was
        // named after.
        //
        // Fired in the order a real engine produces, the fact it pins is the
        // opposite one. Input.dispatchMouseEvent returns as soon as the event is
        // dispatched; the navigation happens after. So reply.pageUrl() at the
        // moment the answer is built is by CONSTRUCTION the address before the
        // click — exactly the staleness card 344 (d) is about. Copying it into
        // the answer cannot follow the page, and it can UNDO the state frame
        // that does: the client applies any verb url it receives.
        //
        // What follows the page is the sixth occasion (see the test above).
        BrowserViewSocket socket = new BrowserViewSocket(
                faces(headless(base), new AtomicBoolean(false), url -> null),
                new SessionBrowserBridge());
        FakeSocket viewer = new FakeSocket("view-1", "ws://127.0.0.1:8746/ws/browser-view");
        socket.afterConnectionEstablished(viewer);
        tell(socket, viewer, "{\"type\":\"navigate\",\"sessionId\":\"" + SESSION
                + "\",\"url\":\"http://dev.example.com/\"}");
        tell(socket, viewer, "{\"type\":\"watch\",\"sessionId\":\"" + SESSION + "\"}");
        // QuietCdp reports nothing on its own, so the fixture says where the
        // navigate landed rather than calling an unset address an answer.
        navigated("http://dev.example.com/");

        tell(socket, viewer, "{\"type\":\"input\",\"sessionId\":\"" + SESSION
                + "\",\"action\":\"left_click\",\"coordinate\":[10,20]}");

        JsonNode verb = lastOfType(viewer, "verb");
        assertEquals("input", verb.path("verb").asText());
        assertFalse(verb.has("url"),
                "the click's answer names no address: the only one it could name is the one "
                        + "before the click, and the client would apply it over a fresher "
                        + "state frame: " + verb);

        // And now the page moves, the way it does: after the dispatch.
        navigated("http://dev.example.com/deep");
        assertEquals("http://dev.example.com/deep",
                awaitState(viewer, "http://dev.example.com/deep").path("url").asText());
    }

    @Test
    void reloadRunsOnWhicheverFaceIsLiveAndCarriesNoAddress(@TempDir Path base) throws Exception {
        // Card 344 (b) on the wire: one more navigation verb, the same guards
        // navigate uses, routed by the same precedence rule.
        RecordingDesktop desktop = new RecordingDesktop();
        BrowserViewSocket socket = new BrowserViewSocket(new PrecedenceBrowserFaces(
                desktop, () -> true, headless(base), url -> null), new SessionBrowserBridge());
        FakeSocket viewer = new FakeSocket("view-1", "ws://127.0.0.1:8746/ws/browser-view");
        socket.afterConnectionEstablished(viewer);

        tell(socket, viewer, "{\"type\":\"navigate\",\"sessionId\":\"" + SESSION
                + "\",\"url\":\"http://dev.example.com/\"}");
        tell(socket, viewer, "{\"type\":\"reload\",\"sessionId\":\"" + SESSION + "\"}");

        assertEquals(List.of("navigate", "reload"), desktop.verbs,
                "the reload is a verb of its own, not a second navigate: " + desktop.verbs);
        JsonNode verb = lastOfType(viewer, "verb");
        assertEquals("reload", verb.path("verb").asText());
        assertTrue(verb.path("ok").asBoolean(), verb.toString());
    }

    @Test
    void anAgentInFlightLocksTheReloadAndTheCloseOutToo(@TempDir Path base) throws Exception {
        // The fight rule reaches every OPERATOR driving verb. A reload and a
        // close are both driving: one moves the page, the other takes it away
        // from under a call that is mid-flight.
        SessionBrowserBridge bridge = new SessionBrowserBridge();
        dev.spectroscope.core.wire.BrowserWireTap guarded =
                bridge.agentGuard(() -> SESSION, dev.spectroscope.core.wire.BrowserWireTap::none);
        BrowserViewSocket socket = new BrowserViewSocket(
                faces(headless(base), new AtomicBoolean(false), url -> null), bridge);
        FakeSocket viewer = new FakeSocket("view-1", "ws://127.0.0.1:8746/ws/browser-view");
        socket.afterConnectionEstablished(viewer);
        dev.spectroscope.core.wire.BrowserWireTap.Call inFlight =
                guarded.open("browser_navigate", "main", "t1", null, null);

        tell(socket, viewer, "{\"type\":\"reload\",\"sessionId\":\"" + SESSION + "\"}");
        assertEquals(1, countOfType(viewer, "refused"), viewer.textJoined());
        assertEquals(BrowserViewSocket.AGENT_DRIVING,
                lastOfType(viewer, "refused").path("sentence").asText());

        tell(socket, viewer, "{\"type\":\"close_page\",\"sessionId\":\"" + SESSION + "\"}");
        // COUNTED, not read as "the last one": the reload's refusal is already
        // on this socket, so a close that was NOT refused would leave that
        // sentence standing and the assertion would pass on the neighbour's
        // evidence. Measured on 2026-08-31: without this count the gate could
        // be deleted from close_page and this test stayed green.
        assertEquals(2, countOfType(viewer, "refused"), viewer.textJoined());
        assertEquals(BrowserViewSocket.AGENT_DRIVING,
                lastOfType(viewer, "refused").path("sentence").asText());
        assertTrue(engines.isEmpty(), "a locked-out verb must not spawn an engine");
        inFlight.end(true, "opened", null);
    }

    @Test
    void closingThePageTakesTheAddressAndBringsTheStartPageBack(@TempDir Path base)
            throws Exception {
        // Card 346, criterion 5. "The start page returns" is, on this wire,
        // exactly `url == null` in the state frame — which is what both faces
        // render their configuration list from.
        BrowserViewSocket socket = new BrowserViewSocket(
                faces(headless(base), new AtomicBoolean(false), url -> null),
                new SessionBrowserBridge());
        FakeSocket viewer = new FakeSocket("view-1", "ws://127.0.0.1:8746/ws/browser-view");
        socket.afterConnectionEstablished(viewer);
        tell(socket, viewer, "{\"type\":\"navigate\",\"sessionId\":\"" + SESSION
                + "\",\"url\":\"http://dev.example.com/\"}");
        tell(socket, viewer, "{\"type\":\"watch\",\"sessionId\":\"" + SESSION + "\"}");

        tell(socket, viewer, "{\"type\":\"close_page\",\"sessionId\":\"" + SESSION + "\"}");

        JsonNode verb = lastOfType(viewer, "verb");
        assertEquals("close_page", verb.path("verb").asText());
        assertTrue(verb.path("ok").asBoolean(), verb.toString());
        JsonNode state = lastOfType(viewer, "state");
        assertTrue(state.path("url").isNull(),
                "a closed page leaves no address behind: " + state);
        assertFalse(state.path("canGoBack").asBoolean(),
                "and nowhere to walk back to: " + state);
    }

    @Test
    void aClickAfterACloseDrivesNothing(@TempDir Path base) throws Exception {
        // The server half of the same hazard the web face closes. The face kept
        // the last frame of a CLOSED page on screen and kept it clickable, so a
        // click on a page that is gone went out as an `input` verb naming a
        // coordinate on it. The face no longer renders that frame — and this
        // pins the floor under it: even a client that sent the verb anyway gets
        // a refusal, not a click into whatever the engine is showing now.
        BrowserViewSocket socket = new BrowserViewSocket(
                faces(headless(base), new AtomicBoolean(false), url -> null),
                new SessionBrowserBridge());
        FakeSocket viewer = new FakeSocket("view-1", "ws://127.0.0.1:8746/ws/browser-view");
        socket.afterConnectionEstablished(viewer);
        tell(socket, viewer, "{\"type\":\"navigate\",\"sessionId\":\"" + SESSION
                + "\",\"url\":\"http://dev.example.com/\"}");
        tell(socket, viewer, "{\"type\":\"watch\",\"sessionId\":\"" + SESSION + "\"}");
        tell(socket, viewer, "{\"type\":\"close_page\",\"sessionId\":\"" + SESSION + "\"}");

        int dispatchesBefore = (int) engines.get(SESSION).called.stream()
                .filter(m -> m.startsWith("Input.")).count();
        tell(socket, viewer, "{\"type\":\"input\",\"sessionId\":\"" + SESSION
                + "\",\"action\":\"left_click\",\"coordinate\":[10,20]}");

        JsonNode verb = lastOfType(viewer, "verb");
        assertEquals("input", verb.path("verb").asText());
        assertFalse(verb.path("ok").asBoolean(),
                "a click on a page that was closed is not an input the engine runs: " + verb);
        assertEquals(dispatchesBefore, (int) engines.get(SESSION).called.stream()
                        .filter(m -> m.startsWith("Input.")).count(),
                "and nothing reached the engine: " + engines.get(SESSION).called);
    }

    @Test
    void closingThePageOnTheDesktopFaceClearsTheServersOwnAddressCache(@TempDir Path base)
            throws Exception {
        // Card 346 names this as not optional, and the measurement behind that
        // is the shape of the control channel: BrowserControlSocket writes its
        // per-session address from a reply's pageUrl and only when that field
        // is non-null, so the shell CANNOT say "there is no page now". Without
        // an explicit clear the desktop face serves the closed address forever
        // — the toolbar keeps offering it and the start page never returns.
        RecordingDesktop desktop = new RecordingDesktop();
        BrowserViewSocket socket = new BrowserViewSocket(new PrecedenceBrowserFaces(
                desktop, () -> true, headless(base), url -> null), new SessionBrowserBridge());
        FakeSocket viewer = new FakeSocket("view-1", "ws://127.0.0.1:8746/ws/browser-view");
        socket.afterConnectionEstablished(viewer);
        tell(socket, viewer, "{\"type\":\"navigate\",\"sessionId\":\"" + SESSION
                + "\",\"url\":\"http://dev.example.com/\"}");
        assertEquals("http://dev.example.com/",
                lastOfType(viewer, "state").path("url").asText());

        tell(socket, viewer, "{\"type\":\"close_page\",\"sessionId\":\"" + SESSION + "\"}");

        assertEquals(List.of("navigate", "close_page"), desktop.verbs,
                "the close reached the pane: " + desktop.verbs);
        JsonNode state = lastOfType(viewer, "state");
        assertTrue(state.path("url").isNull(),
                "the server went on serving the closed address: " + state);
    }

    @Test
    void closingThePageIsRecordedAsTheOperatorsOwn(@TempDir Path base) throws Exception {
        // The same rule every other operator navigation follows (card 227,
        // criterion 4): a replay must not attribute a human's close to a model.
        Path sidecar = base.resolve("s.browser.jsonl");
        SessionBrowserBridge bridge = new SessionBrowserBridge();
        bridge.register(SESSION, new SessionBrowserBridge.Live(
                new dev.spectroscope.core.wire.BrowserWireRecorder(sidecar, 1 << 20),
                new dev.spectroscope.core.launch.LaunchSupervisor((host, port) -> true),
                () -> base));
        BrowserViewSocket socket = new BrowserViewSocket(
                faces(headless(base), new AtomicBoolean(false), url -> null), bridge);
        FakeSocket viewer = new FakeSocket("view-1", "ws://127.0.0.1:8746/ws/browser-view");
        socket.afterConnectionEstablished(viewer);
        tell(socket, viewer, "{\"type\":\"navigate\",\"sessionId\":\"" + SESSION
                + "\",\"url\":\"http://dev.example.com/\"}");

        tell(socket, viewer, "{\"type\":\"close_page\",\"sessionId\":\"" + SESSION + "\"}");

        String lines = java.nio.file.Files.readString(sidecar);
        assertTrue(lines.contains("close_page"), lines);
        assertTrue(lines.contains("\"actor\":\"operator\""), lines);
    }

    /** How many frames of one type this viewer has been sent. */
    private static int countOfType(FakeSocket viewer, String type) {
        int found = 0;
        for (String line : viewer.textJoined().split("\n")) {
            if (line.isBlank()) {
                continue;
            }
            try {
                if (type.equals(JSON.readTree(line).path("type").asText())) {
                    found++;
                }
            } catch (Exception notJson) {
                throw new AssertionError("the view socket must speak JSON: " + line);
            }
        }
        return found;
    }

    /** Fires Page.frameNavigated on this session's engine, the way a real
     *  Chromium reports a main-frame navigation. */
    private void navigated(String url) {
        engines.get(SESSION).listeners.getOrDefault("Page.frameNavigated", List.of())
                .forEach(l -> l.accept(JSON.createObjectNode()
                        .<com.fasterxml.jackson.databind.node.ObjectNode>set("frame",
                                JSON.createObjectNode().put("url", url))));
    }

    /** Waits for a state frame carrying the given address — the push is async. */
    private static JsonNode awaitState(FakeSocket viewer, String url) throws Exception {
        long deadline = System.currentTimeMillis() + 5_000;
        while (System.currentTimeMillis() < deadline) {
            JsonNode found = lastOfType(viewer, "state");
            if (found != null && url.equals(found.path("url").asText(null))) {
                return found;
            }
            Thread.sleep(20);
        }
        throw new AssertionError("no state frame named " + url + ": " + viewer.textJoined());
    }
}
