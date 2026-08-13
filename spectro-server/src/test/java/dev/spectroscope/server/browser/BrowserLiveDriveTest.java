package dev.spectroscope.server.browser;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.browser.BrowserTools;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.image.ImageStore;
import dev.spectroscope.core.net.NetFence;
import dev.spectroscope.core.tools.Tool;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;

import com.sun.net.httpserver.HttpServer;

import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The whole chain, live: a real Chromium pane, the real control channel, and
 * the real seven tools.
 *
 * <p>Every other test in this card fakes one end. This one fakes none — the
 * pane is an actual {@code WebContentsView} in an actual Electron process, the
 * commands travel the actual {@code /ws/browser} socket, and the tool objects
 * are the ones the session registers. It is the answer to the house rule that
 * has paid for itself in every round here: <b>live prove beats code reading</b>,
 * and the expensive finds all came from looking at the result.
 *
 * <p><b>Off by default</b>, because it needs an Electron install and a display,
 * and neither is guaranteed on a build machine. Turn it on with
 * {@code SPECTRO_LIVE_BROWSER=1} and run it from a checkout whose
 * {@code spectro-desktop} has had {@code npm install && npx tsc}.
 *
 * <p>Nothing here reaches the network. The page under test is a fixture on
 * loopback started by this test; the refused address is a stand-in from the
 * curated list {@code NoOperatorAddressesInTheRepoTest} keeps, because this
 * repository is public.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {"server.address=127.0.0.1", "SPECTRO_HUB_PORT="})
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
@EnabledIfEnvironmentVariable(named = "SPECTRO_LIVE_BROWSER", matches = "1")
@Timeout(value = 180, unit = TimeUnit.SECONDS)
class BrowserLiveDriveTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @Autowired
    private BrowserControlSocket control;

    @LocalServerPort
    private int port;

    private Process shell;
    private HttpServer fixture;
    private String base;
    private Path blobs;
    private final List<RunEvent> events = new ArrayList<>();
    private final List<Tool.Attachment> attachments = new ArrayList<>();

    /** The fixture page: a button, an input and a late-arriving element. */
    private static final String PAGE = """
            <!doctype html><html><head><title>card 201 live fixture</title></head>
            <body style="background:#101010;color:#eee;font:16px sans-serif">
            <h1 id="head">not clicked</h1>
            <button id="go" onclick="document.getElementById('head').textContent='clicked'">go</button>
            <input id="field" placeholder="type here" />
            <script>window.__PAGE_MARKER__ = 'page-context-ok';</script>
            </body></html>
            """;

    @BeforeAll
    void startEverything() throws Exception {
        blobs = Files.createTempDirectory("spectro-live-blobs");
        fixture = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        fixture.createContext("/", exchange -> {
            byte[] body = PAGE.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "text/html");
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        fixture.start();
        base = "http://127.0.0.1:" + fixture.getAddress().getPort() + "/";

        Path desktop = Path.of(System.getProperty("user.dir")).getParent().resolve("spectro-desktop");
        ProcessBuilder builder = new ProcessBuilder(
                desktop.resolve("node_modules/.bin/electron").toString(),
                desktop.resolve("test/livePane.js").toString());
        builder.environment().put("SPECTRO_SERVER_PORT", String.valueOf(port));
        builder.directory(desktop.toFile());
        builder.redirectErrorStream(true);
        builder.redirectOutput(ProcessBuilder.Redirect.INHERIT);
        shell = builder.start();

        // The verify loop, opted in on BOTH halves of the fence: the tools below
        // build their NetFence with allowLocalhost, and the shell's own request
        // hook has to agree or the fixture is refused mid-journey. That the two
        // must be set together is the point — a live run found them disagreeing.
        control.useSettings(() -> true, () -> true);

        long deadline = System.currentTimeMillis() + 60_000;
        while (System.currentTimeMillis() < deadline && !control.attached()) {
            Thread.sleep(200);
        }
        assertTrue(control.attached(), "the live pane never attached to /ws/browser");
    }

    @AfterAll
    void stopEverything() {
        if (shell != null) {
            shell.destroy();
        }
        if (fixture != null) {
            fixture.stop(0);
        }
    }

    /** The session this live drive plays, shaped like a store id. */
    private static final String SESSION = "20260813-live-drive";

    /** A second one, for the card-218 isolation drive. */
    private static final String OTHER_SESSION = "20260813-live-drive-two";

    private Tool tool(String name) {
        return tool(name, SESSION);
    }

    /**
     * One tool, wired to one session's browser exactly the way
     * {@code SessionConnection} wires it.
     *
     * @param name    the tool's wire name
     * @param session whose browser it drives
     * @return the tool
     */
    private Tool tool(String name, String session) {
        return new BrowserTools(() -> control.forSession(session),
                () -> NetFence.withSystemDns(true),  // the verify loop, opted in
                new ImageStore(blobs))
                .all().stream().filter(t -> name.equals(t.name())).findFirst().orElseThrow();
    }

    private Tool.ToolContext context() {
        return new Tool.ToolContext(blobs, new CancelSignal(), "main", "live-call",
                events::add, attachments::add);
    }

    private static JsonNode args(String json) throws Exception {
        return JSON.readTree(json);
    }

    @Test
    void twoSessionsGetTwoBrowsersThatCannotReachEachOther() throws Exception {
        // Card 218, through the WHOLE chain rather than about a partition
        // string: the real tools, the real socket, two real Chromium sessions.
        // The claim under test is the one that would hurt most if it were only
        // a comment — a page one agent logged into is not a page the other
        // agent is logged into.
        String login = """
                (() => {
                  document.cookie = 'spectro_login=secret-of-A; path=/';
                  localStorage.setItem('spectro_token', 'token-of-A');
                  return { cookie: document.cookie,
                           token: localStorage.getItem('spectro_token') };
                })()""";
        String readBack = """
                ({ cookie: document.cookie,
                   token: localStorage.getItem('spectro_token') })""";

        assertFalse(tool("browser_navigate")
                .execute(args("{\"url\":\"" + base + "\"}"), context()).startsWith("ERROR"));
        String stored = tool("browser_eval").execute(
                JSON.createObjectNode().put("action", "javascript_exec").put("text", login),
                context());
        assertTrue(stored.contains("secret-of-A"), "the first session logged in: " + stored);

        // The second session, on the SAME origin. It has to load the page for
        // itself, which is already the point: it has its own view.
        String openedByOther = tool("browser_navigate", OTHER_SESSION)
                .execute(args("{\"url\":\"" + base + "\"}"), context());
        assertFalse(openedByOther.startsWith("ERROR"), openedByOther);
        String otherSees = tool("browser_eval", OTHER_SESSION).execute(
                JSON.createObjectNode().put("action", "javascript_exec").put("text", readBack),
                context());
        assertFalse(otherSees.contains("secret-of-A"),
                "the other session read the first one's cookie: " + otherSees);
        assertTrue(otherSees.contains("\"token\":null"),
                "the other session read the first one's storage: " + otherSees);

        // And back: the first session's page survived the second one taking the
        // screen. That is the owner's lifetime rule, measured rather than
        // assumed — still there, still logged in.
        String firstAgain = tool("browser_eval").execute(
                JSON.createObjectNode().put("action", "javascript_exec").put("text", readBack),
                context());
        assertTrue(firstAgain.contains("secret-of-A"),
                "the first session lost its login while the other one ran: " + firstAgain);

        // Closing the session takes its browser with it, and leaves the other
        // one exactly where it was.
        control.closeSession(SESSION);
        Thread.sleep(500);   // the close is fire-and-forget, by design
        String afterClose = tool("browser_eval").execute(
                JSON.createObjectNode().put("action", "javascript_exec").put("text", "1"),
                context());
        assertTrue(afterClose.startsWith("ERROR"),
                "a closed session still had a browser: " + afterClose);
        String otherStillThere = tool("browser_eval", OTHER_SESSION).execute(
                JSON.createObjectNode().put("action", "javascript_exec")
                        .put("text", "document.title"),
                context());
        assertTrue(otherStillThere.contains("fixture"),
                "closing one session took the other one's browser: " + otherStillThere);

        control.closeSession(OTHER_SESSION);
    }

    @Test
    void theWholeChainRunsAgainstARealPane() throws Exception {
        // 1. navigate — the pane really opens the page.
        String opened = tool("browser_navigate")
                .execute(args("{\"url\":\"" + base + "\"}"), context());
        assertFalse(opened.startsWith("ERROR"), opened);
        assertTrue(opened.contains("card 201 live fixture"), opened);

        // 2. eval — page context, act AND sense in one call, Promise awaited,
        //    resolved value JSON-serialized. All four in one script.
        String script = """
                (async () => {
                  document.getElementById('go').click();
                  const field = document.getElementById('field');
                  const setter = Object.getOwnPropertyDescriptor(
                    window.HTMLInputElement.prototype, 'value').set;
                  setter.call(field, 'typed by eval');
                  field.dispatchEvent(new Event('input', { bubbles: true }));
                  await new Promise(r => setTimeout(r, 50));
                  return { marker: window.__PAGE_MARKER__,
                           heading: document.getElementById('head').textContent,
                           value: field.value };
                })()""";
        String verdict = tool("browser_eval").execute(
                JSON.createObjectNode().put("action", "javascript_exec").put("text", script),
                context());
        assertFalse(verdict.startsWith("ERROR"), verdict);
        JsonNode read = JSON.readTree(verdict);
        assertEquals("page-context-ok", read.path("marker").asText(), verdict);
        assertEquals("clicked", read.path("heading").asText(), verdict);
        assertEquals("typed by eval", read.path("value").asText(), verdict);

        // 3. screenshot — card 198's path, and never base64 in the text.
        events.clear();
        attachments.clear();
        String shot = tool("browser_computer")
                .execute(args("{\"action\":\"screenshot\"}"), context());
        assertFalse(shot.startsWith("ERROR"), shot);
        assertEquals(1, attachments.size(), shot);
        Tool.AttachedImage image = (Tool.AttachedImage) attachments.get(0);
        assertEquals("image/png", image.mediaType());
        assertFalse(shot.contains(image.dataBase64().substring(0, 40)),
                "the payload must never enter the text output");
        RunEvent.ImageGenerated reference = (RunEvent.ImageGenerated) events.stream()
                .filter(e -> e instanceof RunEvent.ImageGenerated).findFirst().orElseThrow();
        assertTrue(Files.exists(blobs.resolve(reference.sha256() + ".png")),
                "the bytes are content-addressed in the store");

        // 4. read_page — the tree with ref handles.
        String tree = tool("browser_read_page").execute(args("{}"), context());
        assertFalse(tree.startsWith("ERROR"), tree);
        assertTrue(tree.contains("[ref_"), tree);

        // 5. find — a handle for something named in words.
        String found = tool("browser_find").execute(args("{\"query\":\"go button\"}"), context());
        assertTrue(found.contains("ref_"), found);

        // 6. console — reachable, and it names the page when empty.
        String console = tool("browser_read_console").execute(args("{}"), context());
        assertFalse(console.startsWith("ERROR"), console);

        // 7. resize — and the page is asked afterwards whether it agrees. The
        //    first version reported "375x812 (mobile emulation on)" and changed
        //    nothing a page could read; the sentence is now the measurement, so
        //    this asserts the measurement and then measures it again separately.
        String resized = tool("browser_resize")
                .execute(args("{\"preset\":\"mobile\"}"), context());
        assertFalse(resized.startsWith("ERROR"), resized);
        assertTrue(resized.contains("375x812"), resized);
        assertTrue(resized.contains("touch emulation is on"), resized);
        String measured = tool("browser_eval").execute(args("{\"action\":\"javascript_exec\","
                + "\"text\":\"({w:screen.width,h:screen.height,t:navigator.maxTouchPoints})\"}"),
                context());
        assertTrue(measured.contains("\"w\":375"), "the page itself says so: " + measured);
        assertTrue(measured.contains("\"t\":5"), measured);

        // 7b. a tab id nobody can serve is refused rather than silently ignored.
        String tabbed = tool("browser_read_page")
                .execute(args("{\"tab_id\":\"tab-2\"}"), context());
        assertTrue(tabbed.startsWith("ERROR") && tabbed.contains("tab-2"), tabbed);

        // 8. the fence — a private address is refused and the sentence names it,
        //    before the browser is asked at all.
        String refused = tool("browser_navigate")
                .execute(args("{\"url\":\"http://192.168.1.1/admin\"}"), context());
        assertTrue(refused.startsWith("ERROR"), refused);
        assertTrue(refused.contains("192.168.1.1"), refused);
    }
}
