package dev.spectroscope.core.browser.headless;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.browser.BrowserFace;
import dev.spectroscope.core.net.NetFence;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.function.BiFunction;
import java.util.function.Consumer;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The web face's verbs, driven over a scripted CDP channel (card 226).
 *
 * <p>Every reply shape here is the DESKTOP pane's reply shape, deliberately:
 * {@code BrowserTools} reads these objects and builds the model's sentences
 * from their fields, and a face whose {@code navigate} answered {@code title}
 * under another name would ship seven silently broken tools. The pane
 * ({@code browserPane.ts}) is the behaviour reference; this suite is where the
 * parity is pinned on the Java side.
 */
@Timeout(value = 30, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class HeadlessBrowserFaceTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** A scripted CDP endpoint: handlers per method, events pushed by hand. */
    static final class FakeCdp implements HeadlessBrowserFace.Cdp {
        final List<String> called = new ArrayList<>();
        final Map<String, BiFunction<FakeCdp, JsonNode, JsonNode>> handlers = new HashMap<>();
        final Map<String, List<Consumer<JsonNode>>> listeners = new HashMap<>();
        boolean closed;

        @Override
        public synchronized JsonNode call(String method, JsonNode params) {
            called.add(method);
            BiFunction<FakeCdp, JsonNode, JsonNode> handler = handlers.get(method);
            if (handler != null) {
                return handler.apply(this, params);
            }
            // An unscripted engine still loads pages: without this, every test
            // that merely boots a face would sit out the 30 s load budget.
            if ("Page.navigate".equals(method)) {
                emit("Page.loadEventFired", JSON.createObjectNode());
            }
            return JSON.createObjectNode();
        }

        @Override
        public void on(String method, Consumer<JsonNode> listener) {
            listeners.computeIfAbsent(method, unused -> new ArrayList<>()).add(listener);
        }

        @Override
        public void close() {
            closed = true;
        }

        void emit(String method, JsonNode params) {
            listeners.getOrDefault(method, List.of()).forEach(l -> l.accept(params));
        }

        /** Scripts a page: navigate succeeds and fires its own load event. */
        void scriptLoadingPage(String finalUrl, String title) {
            handlers.put("Page.navigate", (cdp, params) -> {
                cdp.emit("Page.frameNavigated", JSON.createObjectNode()
                        .set("frame", JSON.createObjectNode().put("url", finalUrl)));
                cdp.emit("Page.loadEventFired", JSON.createObjectNode());
                return JSON.createObjectNode().put("frameId", "F1");
            });
            handlers.put("Runtime.evaluate", (cdp, params) -> {
                String expression = params.path("expression").asText();
                if (expression.contains("document.title")) {
                    return evalValue(JSON.getNodeFactory().textNode(title));
                }
                return evalValue(JSON.getNodeFactory().nullNode());
            });
        }

        static JsonNode evalValue(JsonNode value) {
            ObjectNode result = JSON.createObjectNode();
            result.set("result", JSON.createObjectNode().put("type", "object")
                    .<ObjectNode>set("value", value));
            return result;
        }
    }

    private static HeadlessBrowserFace face(FakeCdp cdp) {
        return face(cdp, url -> null);
    }

    private static HeadlessBrowserFace face(FakeCdp cdp,
            java.util.function.Function<String, NetFence.Refusal> judge) {
        return new HeadlessBrowserFace("s-1", () -> cdp, judge);
    }

    // ---- navigate ----------------------------------------------------------

    @Test
    void navigateAnswersTitleUrlAndBlockCountsLikeThePane() {
        FakeCdp cdp = new FakeCdp();
        cdp.scriptLoadingPage("http://dev.example.com/app", "The App");
        HeadlessBrowserFace face = face(cdp);
        BrowserFace.Reply reply = face.send("navigate",
                JSON.createObjectNode().put("url", "http://dev.example.com/app"));
        assertTrue(reply.ok(), () -> "navigate must succeed: " + reply.error());
        assertEquals("The App", reply.value().path("title").asText());
        assertEquals("http://dev.example.com/app", reply.value().path("url").asText());
        assertEquals(0, reply.value().path("blockedRequests").asInt(-1),
                "the pane reports blockedRequests and so must this face");
        assertEquals(0, reply.value().path("adblocked").asInt(-1),
                "no filter list rides this face, and the honest count is zero");
        assertEquals("http://dev.example.com/app", face.pageUrl(),
                "the face must remember the address for failure sentences to name");
    }

    @Test
    void theBootEnablesTheDomainsAndTheDocumentFence() {
        FakeCdp cdp = new FakeCdp();
        cdp.scriptLoadingPage("http://dev.example.com/", "x");
        face(cdp).send("navigate", JSON.createObjectNode().put("url", "http://dev.example.com/"));
        assertTrue(cdp.called.contains("Page.enable"));
        assertTrue(cdp.called.contains("Runtime.enable"));
        assertTrue(cdp.called.contains("Fetch.enable"),
                "the navigation fence rides Fetch and must be enabled at boot");
    }

    @Test
    void aRefusedDocumentHopFailsTheNavigationWithTheFenceSentence() {
        FakeCdp cdp = new FakeCdp();
        // Chrome answers the navigate call, then reports a paused document
        // request for the redirect target — which the fence refuses.
        cdp.handlers.put("Page.navigate", (fake, params) -> {
            fake.emit("Fetch.requestPaused", JSON.createObjectNode()
                    .put("requestId", "R1")
                    .put("resourceType", "Document")
                    .<ObjectNode>set("request",
                            JSON.createObjectNode().put("url", "http://192.168.1.1/admin")));
            return JSON.createObjectNode().put("frameId", "F1");
        });
        HeadlessBrowserFace face = face(cdp, url -> url.contains("192.168.1.1")
                ? new NetFence.Refusal("192.168.1.1", "rfc1918",
                        "refused 192.168.1.1: it is a private network address, RFC 1918 "
                                + "(rule: rfc1918).")
                : null);
        BrowserFace.Reply reply = face.send("navigate",
                JSON.createObjectNode().put("url", "http://dev.example.com/redirects"));
        assertFalse(reply.ok(), "a refused hop must fail the navigation");
        assertTrue(reply.error().contains("the net fence refused a hop on the way there"),
                "the pane's sentence shape, not an error code: " + reply.error());
        assertTrue(reply.error().contains("rfc1918"));
        assertTrue(cdp.called.contains("Fetch.failRequest"),
                "the refused hop must be failed in the browser, not only in the sentence");
    }

    @Test
    void anAllowedDocumentHopIsContinued() {
        FakeCdp cdp = new FakeCdp();
        cdp.scriptLoadingPage("http://dev.example.com/", "x");
        HeadlessBrowserFace face = face(cdp);
        face.send("navigate", JSON.createObjectNode().put("url", "http://dev.example.com/"));
        cdp.emit("Fetch.requestPaused", JSON.createObjectNode()
                .put("requestId", "R2")
                .put("resourceType", "Document")
                .<ObjectNode>set("request",
                        JSON.createObjectNode().put("url", "http://dev.example.com/next")));
        assertTrue(cdp.called.contains("Fetch.continueRequest"),
                "an allowed hop must be continued or the page hangs forever");
    }

    // ---- the verbs before any page -----------------------------------------

    @Test
    void everyPageVerbBeforeANavigateSaysNoPageIsOpen() {
        FakeCdp cdp = new FakeCdp();
        HeadlessBrowserFace face = face(cdp);
        for (String verb : List.of("eval", "screenshot", "input", "read_page", "find", "resize")) {
            BrowserFace.Reply reply = face.send(verb, JSON.createObjectNode());
            assertFalse(reply.ok(), verb + " must refuse before a navigate");
            assertTrue(reply.error().contains("no page is open"),
                    verb + " must say so in the pane's words: " + reply.error());
            assertTrue(reply.error().contains("s-1"),
                    verb + " must name the session: " + reply.error());
        }
    }

    // ---- eval --------------------------------------------------------------

    @Test
    void evalCarriesTheFourPinnedSemanticsOnTheWire() {
        FakeCdp cdp = new FakeCdp();
        cdp.scriptLoadingPage("http://dev.example.com/", "x");
        List<JsonNode> evaluates = new ArrayList<>();
        HeadlessBrowserFace face = face(cdp);
        face.send("navigate", JSON.createObjectNode().put("url", "http://dev.example.com/"));
        cdp.handlers.put("Runtime.evaluate", (fake, params) -> {
            evaluates.add(params);
            return FakeCdp.evalValue(JSON.getNodeFactory().numberNode(42));
        });
        BrowserFace.Reply reply = face.send("eval",
                JSON.createObjectNode().put("text", "6*7"));
        assertTrue(reply.ok());
        assertEquals(42, reply.value().path("value").asInt());
        JsonNode sent = evaluates.get(evaluates.size() - 1);
        assertEquals("6*7", sent.path("expression").asText());
        assertTrue(sent.path("awaitPromise").asBoolean(false),
                "semantic 3 is a FLAG on CDP and forgetting it changes the contract");
        assertTrue(sent.path("returnByValue").asBoolean(false),
                "semantic 4 is the other flag — without it an object comes back as a handle");
    }

    @Test
    void aThrowingEvalAnswersTheExceptionTextNotASuccess() {
        FakeCdp cdp = new FakeCdp();
        cdp.scriptLoadingPage("http://dev.example.com/", "x");
        HeadlessBrowserFace face = face(cdp);
        face.send("navigate", JSON.createObjectNode().put("url", "http://dev.example.com/"));
        cdp.handlers.put("Runtime.evaluate", (fake, params) -> {
            ObjectNode result = JSON.createObjectNode();
            result.set("result", JSON.createObjectNode().put("type", "object"));
            result.set("exceptionDetails", JSON.createObjectNode()
                    .put("text", "Uncaught")
                    .<ObjectNode>set("exception", JSON.createObjectNode()
                            .put("description", "ReferenceError: nope is not defined")));
            return result;
        });
        BrowserFace.Reply reply = face.send("eval", JSON.createObjectNode().put("text", "nope"));
        assertFalse(reply.ok());
        assertTrue(reply.error().contains("ReferenceError"), reply.error());
    }

    // ---- screenshot --------------------------------------------------------

    @Test
    void aScreenshotAnswersPngBytesWithTheDimensionsOutOfTheImageItself() {
        FakeCdp cdp = new FakeCdp();
        cdp.scriptLoadingPage("http://dev.example.com/", "x");
        HeadlessBrowserFace face = face(cdp);
        face.send("navigate", JSON.createObjectNode().put("url", "http://dev.example.com/"));
        cdp.handlers.put("Page.captureScreenshot", (fake, params) ->
                JSON.createObjectNode().put("data", Base64.getEncoder().encodeToString(
                        tinyPng(320, 200))));
        BrowserFace.Reply reply = face.send("screenshot", JSON.createObjectNode());
        assertTrue(reply.ok(), () -> String.valueOf(reply.error()));
        assertEquals("image/png", reply.value().path("mediaType").asText());
        assertEquals(320, reply.value().path("width").asInt(),
                "the dimensions must be measured from the PNG, not assumed");
        assertEquals(200, reply.value().path("height").asInt());
        assertFalse(reply.value().path("dataBase64").asText().isBlank());
    }

    // ---- input -------------------------------------------------------------

    @Test
    void aClickDispatchesMovePressAndReleaseAtTheCoordinate() {
        FakeCdp cdp = new FakeCdp();
        cdp.scriptLoadingPage("http://dev.example.com/", "x");
        List<JsonNode> mouse = new ArrayList<>();
        HeadlessBrowserFace face = face(cdp);
        face.send("navigate", JSON.createObjectNode().put("url", "http://dev.example.com/"));
        cdp.handlers.put("Input.dispatchMouseEvent", (fake, params) -> {
            mouse.add(params);
            return JSON.createObjectNode();
        });
        ObjectNode input = JSON.createObjectNode().put("action", "left_click");
        input.set("coordinate", JSON.createArrayNode().add(10).add(20));
        BrowserFace.Reply reply = face.send("input", input);
        assertTrue(reply.ok());
        assertEquals("left_click at 10,20", reply.value().path("detail").asText());
        assertEquals(List.of("mouseMoved", "mousePressed", "mouseReleased"),
                mouse.stream().map(m -> m.path("type").asText()).toList());
        assertEquals(10, mouse.get(1).path("x").asInt());
        assertEquals(20, mouse.get(1).path("y").asInt());
        assertEquals("left", mouse.get(1).path("button").asText());
        assertEquals(1, mouse.get(1).path("clickCount").asInt());
    }

    @Test
    void typingInsertsTextAndSaysHowManyCharacters() {
        FakeCdp cdp = new FakeCdp();
        cdp.scriptLoadingPage("http://dev.example.com/", "x");
        List<JsonNode> inserted = new ArrayList<>();
        HeadlessBrowserFace face = face(cdp);
        face.send("navigate", JSON.createObjectNode().put("url", "http://dev.example.com/"));
        cdp.handlers.put("Input.insertText", (fake, params) -> {
            inserted.add(params);
            return JSON.createObjectNode();
        });
        BrowserFace.Reply reply = face.send("input",
                JSON.createObjectNode().put("action", "type").put("text", "hello"));
        assertTrue(reply.ok());
        assertEquals("typed 5 character(s)", reply.value().path("detail").asText());
        assertEquals("hello", inserted.get(0).path("text").asText());
    }

    @Test
    void aScrollDownMovesContentDownInPuppeteerSigns() {
        FakeCdp cdp = new FakeCdp();
        cdp.scriptLoadingPage("http://dev.example.com/", "x");
        List<JsonNode> mouse = new ArrayList<>();
        HeadlessBrowserFace face = face(cdp);
        face.send("navigate", JSON.createObjectNode().put("url", "http://dev.example.com/"));
        cdp.handlers.put("Input.dispatchMouseEvent", (fake, params) -> {
            mouse.add(params);
            return JSON.createObjectNode();
        });
        face.send("input", JSON.createObjectNode()
                .put("action", "scroll").put("scroll_direction", "down").put("scroll_amount", 3));
        JsonNode wheel = mouse.get(0);
        assertEquals("mouseWheel", wheel.path("type").asText());
        assertEquals(300, wheel.path("deltaY").asInt(),
                "on CDP a positive deltaY scrolls DOWN — the Electron pane's sign is inverted, "
                        + "and copying it would scroll every page the wrong way");
    }

    @Test
    void aRefResolvesThroughThePageBeforeTheClick() {
        FakeCdp cdp = new FakeCdp();
        cdp.scriptLoadingPage("http://dev.example.com/", "x");
        HeadlessBrowserFace face = face(cdp);
        face.send("navigate", JSON.createObjectNode().put("url", "http://dev.example.com/"));
        List<JsonNode> mouse = new ArrayList<>();
        cdp.handlers.put("Runtime.evaluate", (fake, params) ->
                FakeCdp.evalValue(JSON.createObjectNode().put("x", 55).put("y", 66)));
        cdp.handlers.put("Input.dispatchMouseEvent", (fake, params) -> {
            mouse.add(params);
            return JSON.createObjectNode();
        });
        BrowserFace.Reply reply = face.send("input",
                JSON.createObjectNode().put("action", "left_click").put("ref", "ref_2"));
        assertTrue(reply.ok(), () -> String.valueOf(reply.error()));
        assertEquals(55, mouse.get(0).path("x").asInt());
        assertEquals(66, mouse.get(0).path("y").asInt());
    }

    @Test
    void aStaleRefSaysReadThePageAgain() {
        FakeCdp cdp = new FakeCdp();
        cdp.scriptLoadingPage("http://dev.example.com/", "x");
        HeadlessBrowserFace face = face(cdp);
        face.send("navigate", JSON.createObjectNode().put("url", "http://dev.example.com/"));
        cdp.handlers.put("Runtime.evaluate", (fake, params) ->
                FakeCdp.evalValue(JSON.getNodeFactory().nullNode()));
        BrowserFace.Reply reply = face.send("input",
                JSON.createObjectNode().put("action", "left_click").put("ref", "ref_9"));
        assertFalse(reply.ok());
        assertTrue(reply.error().contains("read the page again"), reply.error());
    }

    // ---- read_page / find --------------------------------------------------

    @Test
    void readPageEvaluatesTheTreeScriptAndAnswersTheTree() {
        FakeCdp cdp = new FakeCdp();
        cdp.scriptLoadingPage("http://dev.example.com/", "x");
        HeadlessBrowserFace face = face(cdp);
        face.send("navigate", JSON.createObjectNode().put("url", "http://dev.example.com/"));
        cdp.handlers.put("Runtime.evaluate", (fake, params) ->
                params.path("expression").asText().contains("__spectroRefs")
                        ? FakeCdp.evalValue(JSON.getNodeFactory().textNode("title: \"x\"\n- button [ref_1]"))
                        : FakeCdp.evalValue(JSON.getNodeFactory().nullNode()));
        BrowserFace.Reply reply = face.send("read_page",
                JSON.createObjectNode().put("filter", "interactive").put("maxChars", 8000));
        assertTrue(reply.ok());
        assertTrue(reply.value().path("tree").asText().contains("[ref_1]"));
    }

    @Test
    void findBeforeAnyReadNamesTheFixLikeThePane() {
        FakeCdp cdp = new FakeCdp();
        cdp.scriptLoadingPage("http://dev.example.com/", "x");
        HeadlessBrowserFace face = face(cdp);
        face.send("navigate", JSON.createObjectNode().put("url", "http://dev.example.com/"));
        cdp.handlers.put("Runtime.evaluate", (fake, params) ->
                FakeCdp.evalValue(JSON.getNodeFactory().textNode("NO_TREE")));
        BrowserFace.Reply reply = face.send("find",
                JSON.createObjectNode().put("query", "the button"));
        assertFalse(reply.ok());
        assertTrue(reply.error().contains("browser_read_page first"), reply.error());
    }

    // ---- console -----------------------------------------------------------

    @Test
    void theConsoleCollectsPageLinesAndCountsRefusals() {
        FakeCdp cdp = new FakeCdp();
        cdp.scriptLoadingPage("http://dev.example.com/", "x");
        HeadlessBrowserFace face = face(cdp, url -> url.contains("10.0.0.5")
                ? new NetFence.Refusal("10.0.0.5", "rfc1918", "refused 10.0.0.5: it is a "
                        + "private network address, RFC 1918 (rule: rfc1918).")
                : null);
        face.send("navigate", JSON.createObjectNode().put("url", "http://dev.example.com/"));
        cdp.emit("Runtime.consoleAPICalled", JSON.createObjectNode()
                .put("type", "error")
                .set("args", JSON.createArrayNode()
                        .add(JSON.createObjectNode().put("type", "string")
                                .put("value", "boom in app.js"))));
        cdp.emit("Fetch.requestPaused", JSON.createObjectNode()
                .put("requestId", "R9")
                .put("resourceType", "Document")
                .<ObjectNode>set("request",
                        JSON.createObjectNode().put("url", "http://10.0.0.5/frame")));
        BrowserFace.Reply reply = face.send("console", JSON.createObjectNode().put("limit", 50));
        assertTrue(reply.ok());
        String lines = reply.value().path("lines").asText();
        assertTrue(lines.contains("[error] boom in app.js"), lines);
        assertTrue(lines.contains("1 by the net fence"), "refusals are counted where the "
                + "operator debugs, exactly like the pane: " + lines);
    }

    // ---- resize ------------------------------------------------------------

    @Test
    void resizeEmulatesAndAnswersWhatThePageMeasuredBack() {
        FakeCdp cdp = new FakeCdp();
        cdp.scriptLoadingPage("http://dev.example.com/", "x");
        List<String> emulated = new ArrayList<>();
        HeadlessBrowserFace face = face(cdp);
        face.send("navigate", JSON.createObjectNode().put("url", "http://dev.example.com/"));
        cdp.handlers.put("Browser.getVersion", (fake, params) -> JSON.createObjectNode()
                .put("product", "HeadlessChrome/151.0.0.0")
                .put("userAgent", "Mozilla/5.0 (Macintosh) Chrome/151.0.0.0 Safari/537.36"));
        cdp.handlers.put("Emulation.setDeviceMetricsOverride", (fake, params) -> {
            emulated.add("metrics " + params.path("width").asInt() + "x"
                    + params.path("height").asInt() + " mobile=" + params.path("mobile").asBoolean());
            return JSON.createObjectNode();
        });
        cdp.handlers.put("Emulation.setTouchEmulationEnabled", (fake, params) -> {
            emulated.add("touch " + params.path("enabled").asBoolean());
            return JSON.createObjectNode();
        });
        cdp.handlers.put("Emulation.setUserAgentOverride", (fake, params) -> {
            emulated.add("agent " + params.path("userAgent").asText().contains("Android"));
            return JSON.createObjectNode();
        });
        cdp.handlers.put("Runtime.evaluate", (fake, params) ->
                FakeCdp.evalValue(JSON.createObjectNode()
                        .put("innerWidth", 981).put("innerHeight", 2123)
                        .put("screenWidth", 375).put("screenHeight", 812)
                        .put("maxTouchPoints", 5).put("devicePixelRatio", 3)
                        .put("coarsePointer", true).put("viewportMeta", false)));
        BrowserFace.Reply reply = face.send("resize",
                JSON.createObjectNode().put("width", 375).put("height", 812));
        assertTrue(reply.ok(), () -> String.valueOf(reply.error()));
        assertTrue(emulated.contains("metrics 375x812 mobile=true"), String.valueOf(emulated));
        assertTrue(emulated.contains("touch true"));
        assertTrue(emulated.contains("agent true"), "a 375-wide viewport borrows a mobile agent");
        assertEquals(375, reply.value().path("screenWidth").asInt(),
                "every number in the answer is the page's own measurement");
        assertEquals(981, reply.value().path("innerWidth").asInt());
        assertEquals(5, reply.value().path("maxTouchPoints").asInt());
        assertTrue(reply.value().path("userAgentApplied").asBoolean());
        assertFalse(reply.value().path("viewportMeta").asBoolean());
    }

    // ---- history -----------------------------------------------------------

    @Test
    void backWalksTheNavigationHistoryAndForwardRefusesAtTheEnd() {
        FakeCdp cdp = new FakeCdp();
        cdp.scriptLoadingPage("http://dev.example.com/two", "Two");
        HeadlessBrowserFace face = face(cdp);
        face.send("navigate", JSON.createObjectNode().put("url", "http://dev.example.com/two"));
        cdp.handlers.put("Page.getNavigationHistory", (fake, params) -> {
            ObjectNode history = JSON.createObjectNode().put("currentIndex", 1);
            history.set("entries", JSON.createArrayNode()
                    .add(JSON.createObjectNode().put("id", 1)
                            .put("url", "http://dev.example.com/one").put("title", "One"))
                    .add(JSON.createObjectNode().put("id", 2)
                            .put("url", "http://dev.example.com/two").put("title", "Two")));
            return history;
        });
        BrowserFace.Reply back = face.send("back", JSON.createObjectNode());
        assertTrue(back.ok(), () -> String.valueOf(back.error()));
        assertEquals("http://dev.example.com/one", back.value().path("url").asText());
        assertTrue(cdp.called.contains("Page.navigateToHistoryEntry"));

        BrowserFace.Reply forward = face.send("forward", JSON.createObjectNode());
        assertFalse(forward.ok(), "at the end of history, forward must say so");
        assertTrue(forward.error().contains("nothing later"), forward.error());
    }

    // ---- unknown -----------------------------------------------------------

    @Test
    void anUnknownVerbIsRefusedByName() {
        FakeCdp cdp = new FakeCdp();
        HeadlessBrowserFace face = face(cdp);
        BrowserFace.Reply reply = face.send("teleport", JSON.createObjectNode());
        assertFalse(reply.ok());
        assertTrue(reply.error().contains("teleport"), reply.error());
    }

    @Test
    void attachedAsksTheOpenerNothingUntilTheFirstVerb() {
        HeadlessBrowserFace face = new HeadlessBrowserFace("s-1", () -> {
            throw new IllegalStateException("the opener must not run for attached()");
        }, url -> null);
        assertTrue(face.attached(), "a face whose engine can be opened is attached");
        assertNotNull(face);
    }

    /** A minimal valid PNG header carrying the given dimensions in its IHDR. */
    static byte[] tinyPng(int width, int height) {
        byte[] png = new byte[33];
        byte[] signature = {(byte) 0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'};
        System.arraycopy(signature, 0, png, 0, 8);
        png[11] = 13; // IHDR length
        png[12] = 'I';
        png[13] = 'H';
        png[14] = 'D';
        png[15] = 'R';
        png[16] = (byte) (width >>> 24);
        png[17] = (byte) (width >>> 16);
        png[18] = (byte) (width >>> 8);
        png[19] = (byte) width;
        png[20] = (byte) (height >>> 24);
        png[21] = (byte) (height >>> 16);
        png[22] = (byte) (height >>> 8);
        png[23] = (byte) height;
        return png;
    }
}
