package dev.spectroscope.core.browser.headless;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sun.net.httpserver.HttpServer;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.browser.BrowserFace;
import dev.spectroscope.core.browser.BrowserTools;
import dev.spectroscope.core.image.ImageStore;
import dev.spectroscope.core.net.NetFence;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.web.BrowsePageTool;
import dev.spectroscope.core.wire.BrowserWireRecorder;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestMethodOrder;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * The web face against a REAL headless Chrome (card 226) — the whole chain
 * live: spawn, drive, fence, record, and kill the tree.
 *
 * <p>Skipped honestly on a machine with no Chrome/Chromium; everywhere else it
 * is the proof, not the claim:
 *
 * <ul>
 *   <li>the seven-tool loop works against a page a local server really serves;</li>
 *   <li>the fence refuses a 302 to a private address AT THE HOP, with the
 *       sentence naming the rule — the case the entry check cannot see;</li>
 *   <li>a SUBRESOURCE is honestly not judged on this face — the promise
 *       {@code docs/BROWSER.md} makes is measured here, not assumed;</li>
 *   <li>card 204's sidecar records this face exactly as it records the
 *       desktop's, epoch marker and image reference included;</li>
 *   <li>closing the session kills the whole process TREE and the count is read
 *       twice, because card 221 taught this house what an orphan costs.</li>
 * </ul>
 */
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
@Timeout(value = 120, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class HeadlessLiveDriveTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static HttpServer server;
    private static int port;
    private static final AtomicInteger subresourceHits = new AtomicInteger();
    private static final List<String> judged = new CopyOnWriteArrayList<>();

    private static Path profileBase;
    private static HeadlessBrowserFaces faces;

    @BeforeAll
    static void serveAndOpen() throws Exception {
        assumeTrue(BrowsePageTool.findChrome(System.getenv()).isPresent(),
                "no Chrome/Chromium on this machine — the live drive cannot run");

        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        port = server.getAddress().getPort();
        server.createContext("/app", exchange -> {
            String html = "<!doctype html><html><head><title>The Live App</title></head>"
                    + "<body><button id=\"go\" onclick=\"console.log('pressed!')\">press me"
                    + "</button><script src=\"http://127.0.0.1:" + port + "/sub.js\"></script>"
                    + "</body></html>";
            answer(exchange, 200, html, "text/html");
        });
        server.createContext("/sub.js", exchange -> {
            subresourceHits.incrementAndGet();
            answer(exchange, 200, "window.__subLoaded = true;", "text/javascript");
        });
        server.createContext("/redirect", exchange -> {
            exchange.getResponseHeaders().add("Location", "http://10.0.0.5/admin");
            exchange.sendResponseHeaders(302, -1);
            exchange.close();
        });
        server.start();

        profileBase = Files.createTempDirectory("spectro-live-headless");
        // The real fence with the loopback opt-in ON (the page under test is
        // local), spied so the suite can say what was judged and what never was.
        HeadlessFence fence = new HeadlessFence(() -> true);
        faces = new HeadlessBrowserFaces(
                () -> BrowsePageTool.findChrome(System.getenv()),
                profileBase,
                url -> {
                    judged.add(url);
                    return fence.judge(url);
                },
                HeadlessBrowserFaces.realEngines(
                        () -> BrowsePageTool.findChrome(System.getenv())));
    }

    @AfterAll
    static void tearDown() {
        if (faces != null) {
            faces.closeAllSessions();
        }
        if (server != null) {
            server.stop(0);
        }
    }

    private static void answer(com.sun.net.httpserver.HttpExchange exchange, int status,
            String body, String type) throws java.io.IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().add("Content-Type", type);
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream out = exchange.getResponseBody()) {
            out.write(bytes);
        }
    }

    @Test
    @Order(1)
    void theSevenToolLoopDrivesARealPage() {
        BrowserFace face = faces.forSession("live-1");
        String appUrl = "http://127.0.0.1:" + port + "/app";

        BrowserFace.Reply navigate = face.send("navigate",
                JSON.createObjectNode().put("url", appUrl));
        assertTrue(navigate.ok(), () -> String.valueOf(navigate.error()));
        assertEquals("The Live App", navigate.value().path("title").asText());
        assertTrue(judged.stream().anyMatch(url -> url.contains("/app")),
                "the top-level document must have passed the fence");

        BrowserFace.Reply eval = face.send("eval", JSON.createObjectNode()
                .put("text", "Promise.resolve(6 * 7)"));
        assertTrue(eval.ok());
        assertEquals(42, eval.value().path("value").asInt(),
                "a returned Promise must be awaited and the value JSON-serialized");

        BrowserFace.Reply read = face.send("read_page",
                JSON.createObjectNode().put("filter", "interactive").put("maxChars", 8000));
        assertTrue(read.ok());
        assertTrue(read.value().path("tree").asText().contains("press me"),
                read.value().path("tree").asText());

        BrowserFace.Reply find = face.send("find",
                JSON.createObjectNode().put("query", "press me"));
        assertTrue(find.ok(), () -> String.valueOf(find.error()));
        assertTrue(find.value().path("matches").asText().contains("ref_1"));

        BrowserFace.Reply click = face.send("input",
                JSON.createObjectNode().put("action", "left_click").put("ref", "ref_1"));
        assertTrue(click.ok(), () -> String.valueOf(click.error()));

        // The click's console line arrives asynchronously; poll briefly.
        String lines = "";
        long deadline = System.currentTimeMillis() + 5_000;
        while (System.currentTimeMillis() < deadline && !lines.contains("pressed!")) {
            BrowserFace.Reply console = face.send("console", JSON.createObjectNode());
            lines = console.value().path("lines").asText();
        }
        assertTrue(lines.contains("[log] pressed!"),
                "the click must really land in the page: " + lines);

        BrowserFace.Reply shot = face.send("screenshot", JSON.createObjectNode());
        assertTrue(shot.ok(), () -> String.valueOf(shot.error()));
        assertEquals("image/png", shot.value().path("mediaType").asText());
        assertTrue(shot.value().path("width").asInt() > 100,
                "a real pane paints a real picture");
    }

    @Test
    @Order(2)
    void aSubresourceIsHonestlyNotJudgedOnThisFace() {
        // The page in test 1 loaded /sub.js. The promise this face makes —
        // pinned against docs/BROWSER.md by WebFaceFencePromiseTest — is that
        // documents are judged and subresources are not. Both halves measured:
        assertTrue(subresourceHits.get() >= 1,
                "the subresource must really have been fetched");
        assertTrue(judged.stream().noneMatch(url -> url.contains("/sub.js")),
                "and the fence must honestly never have seen it — if this fails, "
                        + "the engine started pausing subresources and the PROMISE "
                        + "in docs/BROWSER.md must be rewritten, not this test");
    }

    @Test
    @Order(3)
    void aRedirectToAPrivateAddressIsRefusedAtTheHopWithTheSentence() {
        BrowserFace face = faces.forSession("live-1");
        BrowserFace.Reply reply = face.send("navigate", JSON.createObjectNode()
                .put("url", "http://127.0.0.1:" + port + "/redirect"));
        assertFalse(reply.ok(), "the 302 to 10.0.0.5 must fail the navigation");
        assertTrue(reply.error().contains("the net fence refused a hop on the way there"),
                reply.error());
        assertTrue(reply.error().contains("rfc1918"),
                "the sentence names the rule, not an error code: " + reply.error());
        assertTrue(judged.stream().anyMatch(url -> url.contains("10.0.0.5")),
                "the hop itself must have been judged — this is the case the "
                        + "entry check can never see");
    }

    @Test
    @Order(4)
    void theSidecarRecordsThisFaceExactlyLikeTheDesktops(@TempDir Path dir) throws Exception {
        Path sidecar = dir.resolve("live.browser.jsonl");
        try (BrowserWireRecorder recorder = new BrowserWireRecorder(sidecar, 1024 * 1024)) {
            BrowserTools tools = new BrowserTools(
                    () -> faces.forSession("live-1"),
                    () -> new NetFence(true, NetFence.SYSTEM_DNS),
                    new ImageStore(dir.resolve("images")),
                    () -> recorder);
            Tool.ToolContext context = new Tool.ToolContext(dir, new CancelSignal(),
                    "main", "toolu_live_1", event -> { }, attachment -> { });
            Tool navigate = tools.all().stream()
                    .filter(tool -> tool.name().equals("browser_navigate")).findFirst().orElseThrow();
            Tool computer = tools.all().stream()
                    .filter(tool -> tool.name().equals("browser_computer")).findFirst().orElseThrow();

            String opened = navigate.execute(JSON.createObjectNode()
                    .put("url", "http://127.0.0.1:" + port + "/app"), context);
            assertTrue(opened.startsWith("Opened "), opened);
            String shot = computer.execute(JSON.createObjectNode()
                    .put("action", "screenshot"), context);
            assertTrue(shot.contains("attached for you to see"), shot);
        }

        List<String> lines = Files.readAllLines(sidecar);
        assertTrue(lines.get(0).contains("\"browser_open\""),
                "the epoch marker heads the file exactly as on the desktop face");
        assertEquals(2, lines.stream().filter(l -> l.contains("\"browser_call\"")).count());
        assertEquals(2, lines.stream().filter(l -> l.contains("\"browser_result\"")).count());
        String result = lines.stream()
                .filter(l -> l.contains("\"browser_result\"") && l.contains("\"image\""))
                .findFirst().orElseThrow(() -> new AssertionError(
                        "the screenshot must be on record as a REFERENCE"));
        JsonNode image = JSON.readTree(result).path("image");
        assertEquals("image/png", image.path("mediaType").asText());
        assertFalse(image.path("sha256").asText().isBlank());
        assertTrue(result.length() < 4096,
                "a reference, never the bytes — the sidecar must stay a text file");
    }

    @Test
    @Order(5)
    void closingTheSessionKillsTheTreeAndTheCountIsReadTwice() throws Exception {
        // The browser of live-1 is up from the earlier tests. Find its tree by
        // its profile directory, which is on every Chrome process's command line.
        String profileMarker = profileBase.toString();
        long before = processesMentioning(profileMarker);
        assertTrue(before >= 2, "a Chrome is never one process — measured " + before
                + " with marker " + profileMarker);

        faces.closeSession("live-1");

        long deadline = System.currentTimeMillis() + 10_000;
        while (processesMentioning(profileMarker) > 0
                && System.currentTimeMillis() < deadline) {
            Thread.sleep(100);
        }
        assertEquals(0, processesMentioning(profileMarker),
                "first count: the whole tree must be gone");
        Thread.sleep(500);
        assertEquals(0, processesMentioning(profileMarker),
                "second count, after a settle: a dying tree can look dead and twitch "
                        + "— card 221's lesson, counted twice on purpose");

        deadline = System.currentTimeMillis() + 5_000;
        while (Files.exists(profileDirsUnder(profileBase))
                && System.currentTimeMillis() < deadline) {
            Thread.sleep(100);
        }
        assertFalse(Files.exists(profileDirsUnder(profileBase)),
                "the profile directory — the cookie jar of this face — must be deleted");
    }

    private static Path profileDirsUnder(Path base) throws java.io.IOException {
        try (var children = Files.list(base)) {
            return children.findFirst().orElse(base.resolve("(gone)"));
        }
    }

    private static long processesMentioning(String marker) {
        return ProcessHandle.allProcesses()
                .filter(handle -> handle.info().commandLine()
                        .map(line -> line.contains(marker)).orElse(false))
                .count();
    }
}
