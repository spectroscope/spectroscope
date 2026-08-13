package dev.spectroscope.core.browser;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.image.ImageStore;
import dev.spectroscope.core.net.NetFence;
import dev.spectroscope.core.permission.ToolTier;
import dev.spectroscope.core.permission.ToolTierMap;
import dev.spectroscope.core.tools.Tool;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.net.InetAddress;
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
 * The MVP tool family of card 201, measured from 3,447 real browser calls: the
 * seven tools exist, they are shaped the way the model is told they are, and
 * every failure sentence names the address it tried.
 */
class BrowserToolsTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** A face that records what it was sent and answers from a script. */
    private static final class FakeFace implements BrowserFace {
        private final boolean attached;
        private final Map<String, BrowserFace.Reply> replies;
        private final List<String> sent = new ArrayList<>();

        FakeFace(boolean attached, Map<String, BrowserFace.Reply> replies) {
            this.attached = attached;
            this.replies = replies;
        }

        @Override
        public boolean attached() {
            return attached;
        }

        @Override
        public String pageUrl() {
            return attached ? "http://127.0.0.1:9/last" : null;
        }

        @Override
        public BrowserFace.Reply send(String verb, JsonNode args) {
            sent.add(verb + " " + args.toString());
            BrowserFace.Reply reply = replies.get(verb);
            return reply == null
                    ? BrowserFace.Reply.failed("no scripted reply for " + verb, null)
                    : reply;
        }
    }

    private static JsonNode obj(String json) {
        try {
            return JSON.readTree(json);
        } catch (Exception broken) {
            throw new IllegalStateException(broken);
        }
    }

    private static Tool.ToolContext context(Path cwd, List<RunEvent> events,
            List<Tool.Attachment> attachments) {
        return new Tool.ToolContext(cwd, new CancelSignal(), "main", "call-1",
                events::add, attachments::add);
    }

    /** Everything resolves to a private answer, so nothing leaves this machine. */
    private static final NetFence.Resolver DNS = host -> List.of(
            InetAddress.getByName("93.184.216.34"));

    private static BrowserTools tools(BrowserFace face, boolean allowLocalhost, Path dir) {
        return new BrowserTools(() -> face,
                () -> new NetFence(allowLocalhost, DNS),
                new ImageStore(dir));
    }

    @Test
    void theSevenMeasuredToolsAreRegistered(@TempDir Path dir) {
        List<String> names = tools(new FakeFace(true, Map.of()), false, dir).all()
                .stream().map(Tool::name).toList();
        assertEquals(List.of("browser_navigate", "browser_computer", "browser_eval",
                "browser_read_page", "browser_find", "browser_read_console",
                "browser_resize"), names);
    }

    @Test
    void everyBrowserToolIsRatedInTheShippedTierMap(@TempDir Path dir) {
        ToolTierMap map = ToolTierMap.shipped();
        for (Tool tool : tools(new FakeFace(true, Map.of()), false, dir).all()) {
            ToolTierMap.Resolution resolved = map.resolve(tool.name(), null);
            assertEquals("builtin", resolved.source(),
                    tool.name() + " must be named in tool-tiers.json, "
                            + "or it silently falls to eval-execute");
        }
    }

    @Test
    void evalIsTheDangerousOneAndTheReadersStayReadable(@TempDir Path dir) {
        ToolTierMap map = ToolTierMap.shipped();
        assertEquals(ToolTier.EVAL_EXECUTE, map.resolve("browser_eval", null).tier());
        assertEquals(ToolTier.READ, map.resolve("browser_read_page", null).tier());
        assertEquals(ToolTier.READ, map.resolve("browser_find", null).tier());
        assertEquals(ToolTier.READ, map.resolve("browser_read_console", null).tier());
        assertEquals(ToolTier.WRITE, map.resolve("browser_navigate", null).tier());
        assertEquals(ToolTier.WRITE, map.resolve("browser_computer", null).tier());
        assertEquals(ToolTier.WRITE, map.resolve("browser_resize", null).tier());
    }

    @Test
    void evalCarriesOneActionOneTextAndAnOptionalTabId(@TempDir Path dir) {
        Tool eval = byName(tools(new FakeFace(true, Map.of()), false, dir), "browser_eval");
        JsonNode schema = eval.inputSchema();
        JsonNode properties = schema.path("properties");
        assertTrue(properties.has("action"), "the pinned interface has an action");
        assertTrue(properties.has("text"), "the pinned interface has one text parameter");
        assertTrue(properties.has("tab_id"), "the pinned interface has an optional tab id");
        assertEquals(3, properties.size(), "no fourth parameter on the pinned interface");
        assertEquals("javascript_exec",
                properties.path("action").path("enum").path(0).asText(),
                "the single action is javascript_exec");
    }

    @Test
    void navigateRefusesAPrivateAddressAndNamesIt(@TempDir Path dir) {
        FakeFace face = new FakeFace(true, Map.of());
        Tool navigate = byName(tools(face, false, dir), "browser_navigate");
        String out = navigate.execute(obj("{\"url\":\"http://192.168.1.1/admin\"}"),
                context(dir, new ArrayList<>(), new ArrayList<>()));
        assertTrue(out.startsWith("ERROR: "), out);
        assertTrue(out.contains("192.168.1.1"), "the refusal names the address it tried: " + out);
        assertTrue(out.contains("rfc1918"), out);
        assertTrue(face.sent.isEmpty(), "a refused address never reaches the browser");
    }

    @Test
    void navigateRefusesLoopbackUntilTheVerifyLoopIsOptedIn(@TempDir Path dir) {
        FakeFace face = new FakeFace(true, Map.of());
        String refused = byName(tools(face, false, dir), "browser_navigate")
                .execute(obj("{\"url\":\"http://localhost:5173/\"}"),
                        context(dir, new ArrayList<>(), new ArrayList<>()));
        assertTrue(refused.contains("localhost:5173"), refused);
        assertTrue(refused.contains("allowLocalhost"),
                "the refusal says how to turn the verify loop on: " + refused);

        FakeFace opted = new FakeFace(true, Map.of("navigate",
                BrowserFace.Reply.ok(obj("{\"title\":\"dev\"}"), "http://localhost:5173/")));
        String allowed = byName(tools(opted, true, dir), "browser_navigate")
                .execute(obj("{\"url\":\"http://localhost:5173/\"}"),
                        context(dir, new ArrayList<>(), new ArrayList<>()));
        assertFalse(allowed.startsWith("ERROR"), allowed);
        assertTrue(allowed.contains("http://localhost:5173/"), allowed);
    }

    @Test
    void aDetachedFaceIsAnErrorThatNamesTheAddressAndTheFace(@TempDir Path dir) {
        Tool navigate = byName(tools(new FakeFace(false, Map.of()), false, dir), "browser_navigate");
        String out = navigate.execute(obj("{\"url\":\"https://example.com/x\"}"),
                context(dir, new ArrayList<>(), new ArrayList<>()));
        assertTrue(out.startsWith("ERROR: "), out);
        assertTrue(out.contains("https://example.com/x"),
                "even the no-browser failure names the URL it tried: " + out);
        assertTrue(out.contains("desktop"),
                "and says which face carries a browser: " + out);
    }

    @Test
    void anEngineFailureNamesThePageItHappenedOn(@TempDir Path dir) {
        FakeFace face = new FakeFace(true, Map.of("eval",
                BrowserFace.Reply.failed("ReferenceError: nope is not defined",
                        "http://localhost:5173/app")));
        String out = byName(tools(face, true, dir), "browser_eval")
                .execute(obj("{\"action\":\"javascript_exec\",\"text\":\"nope()\"}"),
                        context(dir, new ArrayList<>(), new ArrayList<>()));
        assertTrue(out.startsWith("ERROR: "), out);
        assertTrue(out.contains("http://localhost:5173/app"),
                "the failure names the page it ran on: " + out);
        assertTrue(out.contains("ReferenceError"), out);
    }

    @Test
    void evalReturnsTheResolvedValueJsonSerialized(@TempDir Path dir) {
        FakeFace face = new FakeFace(true, Map.of("eval", BrowserFace.Reply.ok(
                obj("{\"value\":{\"clicked\":true,\"count\":2}}"), "http://localhost:5173/")));
        String out = byName(tools(face, true, dir), "browser_eval")
                .execute(obj("{\"action\":\"javascript_exec\",\"text\":\"go()\"}"),
                        context(dir, new ArrayList<>(), new ArrayList<>()));
        assertEquals("{\"clicked\":true,\"count\":2}", out.strip());
        assertTrue(face.sent.get(0).contains("\"text\":\"go()\""),
                "the script travels verbatim: " + face.sent);
    }

    @Test
    void aScreenshotTravelsTheImagePathAndNeverTheTextOutput(@TempDir Path dir) throws Exception {
        byte[] png = pngBytes();
        FakeFace face = new FakeFace(true, Map.of("screenshot", BrowserFace.Reply.ok(
                obj("{\"mediaType\":\"image/png\",\"dataBase64\":\""
                        + Base64.getEncoder().encodeToString(png)
                        + "\",\"width\":800,\"height\":600}"),
                "http://localhost:5173/")));
        List<RunEvent> events = new ArrayList<>();
        List<Tool.Attachment> attachments = new ArrayList<>();
        String out = byName(tools(face, true, dir), "browser_computer")
                .execute(obj("{\"action\":\"screenshot\"}"), context(dir, events, attachments));

        assertFalse(out.contains(Base64.getEncoder().encodeToString(png)),
                "never base64 in the tool's text output: " + out);
        assertEquals(1, attachments.size(), "the model gets the picture, not a path");
        Tool.AttachedImage image = (Tool.AttachedImage) attachments.get(0);
        assertEquals("image/png", image.mediaType());
        RunEvent.ImageGenerated reference = (RunEvent.ImageGenerated) events.stream()
                .filter(e -> e instanceof RunEvent.ImageGenerated).findFirst().orElseThrow();
        assertTrue(reference.blobPath().startsWith("images/"), reference.blobPath());
        assertEquals("browser", reference.provider());
        assertNotNull(reference.sha256());
        assertTrue(java.nio.file.Files.exists(dir.resolve(reference.sha256() + ".png")),
                "the bytes are in the ImageStore, content-addressed");
        assertTrue(out.contains("http://localhost:5173/"), out);
    }

    @Test
    void aScreenshotInATypeTheSessionCannotServeIsRefusedNotStored(@TempDir Path dir) {
        FakeFace face = new FakeFace(true, Map.of("screenshot", BrowserFace.Reply.ok(
                obj("{\"mediaType\":\"image/tiff\",\"dataBase64\":\"AAAA\"}"),
                "http://localhost:5173/")));
        List<RunEvent> events = new ArrayList<>();
        List<Tool.Attachment> attachments = new ArrayList<>();
        String out = byName(tools(face, true, dir), "browser_computer")
                .execute(obj("{\"action\":\"screenshot\"}"), context(dir, events, attachments));
        assertTrue(out.startsWith("ERROR: "), out);
        assertTrue(out.contains("image/tiff"), out);
        assertTrue(attachments.isEmpty(), "nothing on the wire the session cannot serve back");
        assertTrue(events.isEmpty(), "and nothing announced either");
    }

    @Test
    void readPageAndFindAndConsoleAreReadOnlyAndNeedNoGate(@TempDir Path dir) {
        BrowserTools family = tools(new FakeFace(true, Map.of()), false, dir);
        assertFalse(byName(family, "browser_read_page").needsPermission());
        assertFalse(byName(family, "browser_find").needsPermission());
        assertFalse(byName(family, "browser_read_console").needsPermission());
        assertTrue(byName(family, "browser_eval").needsPermission());
        assertTrue(byName(family, "browser_navigate").needsPermission());
        assertTrue(byName(family, "browser_computer").needsPermission());
    }

    @Test
    void aTabIdTheShellCannotServeIsRefusedRatherThanSilentlyIgnored(@TempDir Path dir) {
        // Measured in review: tab_id was advertised on all seven schemas, travelled
        // the wire, and the shell never read it — so a model that addressed a second
        // tab drove the first one and nothing said so. The parameter stays, because
        // its meaning is now the per-session browser the owner asked for; what may
        // not stay is answering a request nobody served.
        FakeFace face = new FakeFace(true, Map.of("navigate",
                BrowserFace.Reply.ok(obj("{\"title\":\"dev\"}"), "http://localhost:5173/")));
        String out = byName(tools(face, true, dir), "browser_navigate")
                .execute(obj("{\"url\":\"http://localhost:5173/\",\"tab_id\":\"tab-2\"}"),
                        context(dir, new ArrayList<>(), new ArrayList<>()));
        assertTrue(out.startsWith("ERROR: "), out);
        assertTrue(out.contains("tab-2"), "the refusal names the tab it was given: " + out);
        assertTrue(face.sent.isEmpty(), "and nothing reached the pane under another tab's name");
    }

    @Test
    void theTabIdRefusalSaysItCanNeverNameAnotherSessionsBrowser(@TempDir Path dir) {
        // Card 218 gave tab_id its recorded meaning — a browser per session — and
        // then did NOT make it a session selector, which is the part a later
        // reader is most likely to get wrong. An argument that could name a
        // session would be a way for one agent to reach another session's page,
        // cookies and logins: exactly what the card was written to prevent. So
        // both the schema and the refusal have to say which of the two it is.
        FakeFace face = new FakeFace(true, Map.of());
        BrowserTools family = tools(face, true, dir);

        String out = byName(family, "browser_eval").execute(
                obj("{\"action\":\"javascript_exec\",\"text\":\"1\",\"tab_id\":\"other-session\"}"),
                context(dir, new ArrayList<>(), new ArrayList<>()));

        assertTrue(out.contains("another session"),
                "the refusal must say a tab id cannot cross into another session: " + out);
        for (Tool tool : family.all()) {
            String described = tool.inputSchema().path("properties").path("tab_id")
                    .path("description").asText("");
            assertTrue(described.contains("your session") || described.contains("YOUR session"),
                    tool.name() + " does not tell the model whose browser it drives: " + described);
        }
        assertTrue(face.sent.isEmpty(), "and nothing travelled under another session's name");
    }

    @Test
    void everyToolRefusesATabIdAndSaysSoOnItsSchema(@TempDir Path dir) {
        FakeFace face = new FakeFace(true, Map.of());
        for (Tool tool : tools(face, true, dir).all()) {
            JsonNode described = tool.inputSchema().path("properties").path("tab_id")
                    .path("description");
            assertTrue(described.asText("").contains("refused"),
                    tool.name() + " advertises tab_id without saying it is refused: " + described);
            String out = tool.execute(obj("{\"action\":\"screenshot\",\"query\":\"x\","
                    + "\"url\":\"https://example.com/\",\"text\":\"1\",\"tab_id\":\"t9\"}"),
                    context(dir, new ArrayList<>(), new ArrayList<>()));
            assertTrue(out.startsWith("ERROR: ") && out.contains("t9"),
                    tool.name() + " swallowed a tab id it cannot serve: " + out);
        }
        assertTrue(face.sent.isEmpty(), "not one verb travelled with an unserviceable tab id");
    }

    @Test
    void resizeReportsWhatThePageMeasuredAndNotWhatItWasAsked(@TempDir Path dir) {
        // The measured dishonesty: "The viewport of … is now 375x812 (mobile
        // emulation on)" while the page reported innerWidth 800, maxTouchPoints 0
        // and a Macintosh user agent. A sentence assembled from the tool's own
        // arguments can never be wrong, and is therefore worth nothing.
        FakeFace stubborn = new FakeFace(true, Map.of("resize", BrowserFace.Reply.ok(
                obj("{\"width\":375,\"height\":812,\"mobile\":true,\"screenWidth\":800,"
                        + "\"screenHeight\":740,\"innerWidth\":800,\"innerHeight\":740,"
                        + "\"maxTouchPoints\":0,\"touchApplied\":false,"
                        + "\"userAgentApplied\":false}"),
                "http://localhost:5173/")));
        String out = byName(tools(stubborn, true, dir), "browser_resize")
                .execute(obj("{\"preset\":\"mobile\"}"),
                        context(dir, new ArrayList<>(), new ArrayList<>()));
        assertTrue(out.contains("800x740"), "the sentence carries the measurement: " + out);
        assertTrue(out.contains("asked for 375x812"), "and admits the gap: " + out);
        assertTrue(out.contains("touch emulation is off"), out);
        assertFalse(out.contains("mobile user agent"),
                "a user agent that was not applied is not announced: " + out);
    }

    @Test
    void resizeSaysWhatItReallyDidWhenThePaneReallyDidIt(@TempDir Path dir) {
        FakeFace real = new FakeFace(true, Map.of("resize", BrowserFace.Reply.ok(
                obj("{\"width\":375,\"height\":812,\"mobile\":true,\"screenWidth\":375,"
                        + "\"screenHeight\":812,\"innerWidth\":375,\"innerHeight\":812,"
                        + "\"viewportMeta\":true,\"maxTouchPoints\":5,\"touchApplied\":true,"
                        + "\"userAgentApplied\":true}"),
                "http://localhost:5173/")));
        String out = byName(tools(real, true, dir), "browser_resize")
                .execute(obj("{\"preset\":\"mobile\"}"),
                        context(dir, new ArrayList<>(), new ArrayList<>()));
        assertTrue(out.contains("375x812"), out);
        assertFalse(out.contains("asked for"), "nothing to admit when it worked: " + out);
        assertTrue(out.contains("touch emulation is on with 5 points"), out);
        assertTrue(out.contains("mobile user agent"), out);
    }

    @Test
    void resizeSaysWhenTheDeviceAndTheLayoutViewportDisagree(@TempDir Path dir) {
        // Measured on this Chromium: a 375x812 device whose page declares no
        // viewport meta tag lays out at 981 CSS pixels — which is what a real
        // phone does too, and the single most useful thing a responsive check
        // can report. A sentence that quoted only 375 would be true and useless.
        FakeFace legacy = new FakeFace(true, Map.of("resize", BrowserFace.Reply.ok(
                obj("{\"width\":375,\"height\":812,\"mobile\":true,\"screenWidth\":375,"
                        + "\"screenHeight\":812,\"innerWidth\":981,\"innerHeight\":2123,"
                        + "\"viewportMeta\":false,\"maxTouchPoints\":5,\"touchApplied\":true,"
                        + "\"userAgentApplied\":true}"),
                "http://localhost:5173/")));
        String out = byName(tools(legacy, true, dir), "browser_resize")
                .execute(obj("{\"preset\":\"mobile\"}"),
                        context(dir, new ArrayList<>(), new ArrayList<>()));
        assertTrue(out.contains("is now 375x812"), out);
        assertFalse(out.contains("asked for"), "the device IS what was asked for: " + out);
        assertTrue(out.contains("lays out at 981x2123"), out);
        assertTrue(out.contains("no <meta name=\"viewport\">"), out);
    }

    @Test
    void resizeAdmitsAPaneThatMeasuredNothingInsteadOfClaimingASize(@TempDir Path dir) {
        FakeFace silent = new FakeFace(true, Map.of("resize",
                BrowserFace.Reply.ok(obj("{\"width\":375,\"height\":812}"),
                        "http://localhost:5173/")));
        String out = byName(tools(silent, true, dir), "browser_resize")
                .execute(obj("{\"preset\":\"mobile\"}"),
                        context(dir, new ArrayList<>(), new ArrayList<>()));
        assertTrue(out.contains("did not report its own size back"), out);
    }

    @Test
    void anOversizedScreenshotIsRefusedBeforeItIsEverDecoded(@TempDir Path dir) {
        // The javadoc promised the size was "decided on the encoded payload so an
        // oversized image never gets a decoded copy", and the code decoded first.
        // The two now agree, and this pins which way.
        long tooBig = BrowserTools.MAX_SCREENSHOT_BYTES + 1024;
        int encoded = (int) (tooBig * 4 / 3);
        assertTrue(BrowserTools.decodedLength("A".repeat(encoded)) > BrowserTools.MAX_SCREENSHOT_BYTES);
        assertEquals(3, BrowserTools.decodedLength("AAAA"));
        assertEquals(2, BrowserTools.decodedLength("AAA="));
        assertEquals(1, BrowserTools.decodedLength("AA=="));
        assertEquals(3, BrowserTools.decodedLength("AA\nAA"), "wrapping is not payload");

        // A payload this size is not valid base64 at all: if the guard decoded
        // first, the decoder would throw and the sentence would blame the
        // payload instead of naming the size.
        FakeFace face = new FakeFace(true, Map.of("screenshot", BrowserFace.Reply.ok(
                obj("{\"mediaType\":\"image/png\",\"dataBase64\":\"" + "!".repeat(encoded)
                        + "\",\"width\":800,\"height\":600}"),
                "http://localhost:5173/")));
        List<RunEvent> events = new ArrayList<>();
        List<Tool.Attachment> attachments = new ArrayList<>();
        String out = byName(tools(face, true, dir), "browser_computer")
                .execute(obj("{\"action\":\"screenshot\"}"), context(dir, events, attachments));
        assertTrue(out.startsWith("ERROR: "), out);
        assertTrue(out.contains("over the " + BrowserTools.MAX_SCREENSHOT_BYTES + " byte limit"),
                "the size is what was refused, so the size is what the sentence names: " + out);
        assertTrue(attachments.isEmpty() && events.isEmpty(), "nothing stored, nothing announced");
    }

    private static Tool byName(BrowserTools family, String name) {
        return family.all().stream().filter(t -> name.equals(t.name())).findFirst().orElseThrow();
    }

    /** The smallest real PNG — a 1x1 transparent pixel. */
    private static byte[] pngBytes() {
        return Base64.getDecoder().decode(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk"
                        + "YPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==");
    }
}
