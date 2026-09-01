package dev.spectroscope.core.browser.headless;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.browser.BrowserFace;
import dev.spectroscope.core.config.governing.Governs;
import dev.spectroscope.core.net.NetFence;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.Consumer;
import java.util.function.Function;
import java.util.function.Supplier;

/**
 * One session's browser on the WEB face: a headless Chrome the server spawned,
 * driven over CDP (card 226) — the second implementation of the seam card 200
 * section 5 promised, under the same seven tools, the same sidecar and the same
 * sentences.
 *
 * <p><b>The desktop pane is the behaviour reference, field for field.</b>
 * Every verb here answers the object shape {@code browserPane.ts} answers,
 * because {@link dev.spectroscope.core.browser.BrowserTools} builds the model's
 * sentences from those fields and must not care which face produced them. Where
 * the engines honestly differ, the difference is stated here and in
 * {@code docs/BROWSER.md} rather than smoothed over:
 *
 * <ul>
 *   <li>{@link #SUBRESOURCE_PROMISE} — the fence on this face is enforced at
 *       NAVIGATION level: every document request, so the top-level page, every
 *       redirect hop of it, and every iframe, all judged before Chrome dials.
 *       Subresources (scripts, images, XHR) are not judged here: policing them
 *       over CDP means routing every request through the JVM for an explicit
 *       verdict, the structural cost card 200 section 4 measured. Following
 *       {@code browse_page}'s precedent, the limit is PROMISED in the docs and
 *       pinned by a drift test instead of being silently absent.</li>
 *   <li>No filter list rides this face (adblock is the same per-request hook
 *       the fence deliberately does not take), so a navigate reply's
 *       {@code adblocked} is honestly zero.</li>
 *   <li>The scroll sign is inverted relative to the Electron pane:
 *       on CDP a positive {@code deltaY} scrolls down (the DOM's own
 *       convention), where Electron's {@code sendInputEvent} takes the
 *       opposite. Copying the pane's sign would scroll every page the wrong
 *       way — measured by the face test rather than discovered live.</li>
 * </ul>
 */
public final class HeadlessBrowserFace implements BrowserFace, AutoCloseable {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** How long one page load may take before the sentence says it did not. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.SECONDS)
    static final Duration LOAD_BUDGET = Duration.ofSeconds(30);

    /** How many console lines one page may accumulate — the pane's own cap. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.LINES)
    private static final int CONSOLE_CAP = 500;

    /**
     * The promise this face makes about its fence, word for word where the
     * drift test can pin it against the docs: navigation-level enforcement,
     * subresources excluded, said rather than implied.
     */
    public static final String SUBRESOURCE_PROMISE =
            "On the web face the fence judges every DOCUMENT request — the page, every "
                    + "redirect hop of it, and every iframe — before Chrome dials it. "
                    + "Subresources (scripts, images, XHR) are not judged on this face: "
                    + "policing them over CDP costs a JVM round trip per request, and a "
                    + "promise the engine cannot keep is not made.";

    /** The CDP endpoint as this face needs it — {@link CdpConnection} in
     *  production, a scripted fake in the suite. */
    public interface Cdp extends AutoCloseable {
        /** One command, blocking for its reply.
         *  @param method the CDP method
         *  @param params the parameters or null
         *  @return the result object */
        JsonNode call(String method, JsonNode params);

        /** Registers an event listener.
         *  @param method   the CDP event
         *  @param listener receives the event's params */
        void on(String method, Consumer<JsonNode> listener);

        /** Closes the endpoint. */
        @Override
        void close();
    }

    private final String sessionId;
    private final Supplier<Cdp> opener;
    private final Function<String, NetFence.Refusal> judge;

    private final Object boot = new Object();
    private volatile Cdp cdp;
    private volatile String pageUrl;
    private volatile boolean navigatedOnce;
    private volatile String baseUserAgent;

    /** One page load in flight: completed by the load event or a refused hop. */
    private volatile CompletableFuture<String> loading;

    /** One refused request, in the pane's own record shape. */
    record Refusal(String url, String rule, String sentence) {
    }

    private final List<Refusal> refusals = new CopyOnWriteArrayList<>();
    private final List<String> consoleLines = new CopyOnWriteArrayList<>();

    /** Where screencast frames go when the view socket is watching, or null. */
    private volatile Consumer<JsonNode> frameSink;

    /**
     * Who to wake when the MAIN frame moves, or null (card 344, criterion 4).
     *
     * <p>One slot, newest wins, exactly like {@link #frameSink}: the view
     * socket serves one viewer per session, and a list here would be a way for
     * a dropped viewer to keep being told about a page it is not watching.
     */
    private volatile Runnable navSink;

    /**
     * @param sessionId the session this browser belongs to — for sentences only,
     *                  never for keying (the directory already resolved us)
     * @param opener    how the engine is spawned and dialled, run once on the
     *                  first verb — a session that never calls a browser tool
     *                  never costs a Chrome process
     * @param judge     the navigation fence, judging every document hop
     */
    public HeadlessBrowserFace(String sessionId, Supplier<Cdp> opener,
            Function<String, NetFence.Refusal> judge) {
        this.sessionId = sessionId;
        this.opener = opener;
        this.judge = judge;
    }

    /** @return true — a face is only built when its engine can be opened */
    @Override
    public boolean attached() {
        return true;
    }

    /** @return the address this session's browser is showing, or null */
    @Override
    public String pageUrl() {
        return pageUrl;
    }

    /** @return whether this browser has ever opened a page — the view socket
     *          asks before starting a cast, so watching an idle session never
     *          spawns an engine */
    public boolean hasPage() {
        return navigatedOnce;
    }

    /**
     * Who to wake when the page moves by itself (card 344, criterion 4).
     *
     * <p>The defect this closes: the address bar kept the old address after a
     * click on a link inside the streamed picture. State frames are pushed on
     * five occasions and a page-initiated navigation is none of them, so the
     * bar could only ever be as fresh as the last verb the operator ran.
     *
     * <p>Only the MAIN frame wakes it. An advert in an iframe moves constantly
     * and is not the page the reader is on.
     *
     * @param sink runs after {@link #pageUrl()} has been updated, or null to
     *             drop the current watcher
     */
    public void onNavigated(Runnable sink) {
        navSink = sink;
    }

    private void announceNavigation() {
        Runnable sink = navSink;
        if (sink == null) {
            return;
        }
        try {
            sink.run();
        } catch (RuntimeException watcherBroke) {
            // A watcher that throws must not take down the CDP reader thread —
            // every later event, the fence's own included, rides this listener.
            navSink = null;
        }
    }

    /**
     * Where this browser's history can go, asked of Chromium rather than
     * remembered (card 344, criterion 3).
     *
     * <p>Remembering it would be the same defect the address had: a number
     * cached at verb time is wrong the moment the page follows a link by
     * itself. This is a CDP round trip, and it is affordable because the
     * state frame that carries it is pushed on operator-scale events only.
     *
     * @return the two answers, or {@link BrowserFace.History#UNKNOWN} when the
     *         engine could not be asked
     */
    @Override
    public History history() {
        if (!navigatedOnce) {
            // Provable without an engine, and asking would SPAWN one: watching
            // an idle session must stay free (see hasPage).
            return History.NOWHERE;
        }
        try {
            JsonNode walk = engine().call("Page.getNavigationHistory", null);
            int current = walk.path("currentIndex").asInt(0);
            int size = walk.path("entries").size();
            return new History(current > 0, current < size - 1);
        } catch (RuntimeException cannotAsk) {
            return History.UNKNOWN;
        }
    }

    /**
     * Runs one verb. Never throws: transport failures, timeouts and page errors
     * all come back as a failed reply carrying a sentence.
     *
     * @param verb the verb, from {@link BrowserFace}'s own list
     * @param args the verb's arguments
     * @return the reply
     */
    @Override
    public Reply send(String verb, JsonNode args) {
        try {
            return dispatch(verb, args == null ? JSON.createObjectNode() : args);
        } catch (RuntimeException failure) {
            return Reply.failed(failure.getMessage(), pageUrl);
        }
    }

    private Reply dispatch(String verb, JsonNode args) {
        return switch (verb) {
            case "navigate" -> navigate(args);
            case "eval" -> withPage(() -> eval(args));
            case "screenshot" -> withPage(this::screenshot);
            case "input" -> withPage(() -> input(args));
            case "read_page" -> withPage(() -> readPage(args));
            case "find" -> withPage(() -> find(args));
            case "console" -> console(args);
            case "resize" -> withPage(() -> resize(args));
            case "back" -> withPage(() -> walkHistory(-1));
            case "forward" -> withPage(() -> walkHistory(+1));
            case "reload" -> withPage(this::reload);
            case "close_page" -> withPage(this::closePage);
            default -> Reply.failed("this browser does not know the verb \""
                    + String.valueOf(verb).substring(0, Math.min(40, String.valueOf(verb).length()))
                    + "\"", pageUrl);
        };
    }

    /** The pane's own guard: page verbs before any navigate say so, naming the session. */
    private Reply withPage(Supplier<Reply> work) {
        if (!navigatedOnce) {
            return Reply.failed("no page is open in this session's browser yet — navigate "
                    + "first (session " + sessionId + ")", pageUrl);
        }
        return work.get();
    }

    /**
     * The engine, spawned and wired on first use.
     *
     * <p>The boot enables the three domains this face lives on and installs the
     * listeners ONCE: the fence on {@code Fetch.requestPaused}, the address on
     * {@code Page.frameNavigated}, the load waiter on {@code Page.loadEventFired},
     * the console on {@code Runtime.consoleAPICalled}, and the frame relay on
     * {@code Page.screencastFrame} — acked immediately, because a frame Chrome
     * never hears back about is the last frame Chrome sends.
     *
     * @return the open endpoint
     */
    private Cdp engine() {
        Cdp current = cdp;
        if (current != null) {
            return current;
        }
        synchronized (boot) {
            if (cdp != null) {
                return cdp;
            }
            Cdp opened = opener.get();
            opened.on("Page.frameNavigated", params -> {
                JsonNode frame = params.path("frame");
                // Only the main frame's address is THE address; an iframe's is not.
                if (!frame.has("parentId")) {
                    String url = frame.path("url").asText(null);
                    if (url != null && !url.isBlank() && !"about:blank".equals(url)) {
                        pageUrl = url;
                        announceNavigation();
                    }
                }
            });
            opened.on("Page.loadEventFired", params -> {
                CompletableFuture<String> waiting = loading;
                if (waiting != null) {
                    waiting.complete(null);
                }
            });
            opened.on("Runtime.consoleAPICalled", params -> {
                String level = params.path("type").asText("log");
                StringBuilder text = new StringBuilder();
                for (JsonNode arg : params.path("args")) {
                    if (!text.isEmpty()) {
                        text.append(' ');
                    }
                    if (arg.has("value")) {
                        text.append(arg.path("value").isTextual()
                                ? arg.path("value").asText() : arg.path("value").toString());
                    } else {
                        text.append(arg.path("description").asText(arg.path("type").asText("")));
                    }
                }
                consoleLines.add("[" + level + "] " + text);
                if (consoleLines.size() > CONSOLE_CAP) {
                    consoleLines.subList(0, consoleLines.size() - CONSOLE_CAP).clear();
                }
            });
            opened.on("Fetch.requestPaused", params -> gate(opened, params));
            opened.on("Page.screencastFrame", params -> {
                // Ack FIRST: an unacked frame stops the cast, and a slow or gone
                // sink must never be the reason the operator's picture freezes.
                try {
                    opened.call("Page.screencastFrameAck", JSON.createObjectNode()
                            .put("sessionId", params.path("sessionId").asInt()));
                } catch (RuntimeException gone) {
                    return;
                }
                Consumer<JsonNode> sink = frameSink;
                if (sink != null) {
                    sink.accept(params);
                }
            });
            opened.call("Page.enable", null);
            opened.call("Runtime.enable", null);
            // Documents only: the top-level page, every redirect hop of it, and
            // every iframe. That IS the promise — see SUBRESOURCE_PROMISE.
            ObjectNode fetchArgs = JSON.createObjectNode();
            fetchArgs.set("patterns", JSON.createArrayNode()
                    .add(JSON.createObjectNode()
                            .put("urlPattern", "*")
                            .put("resourceType", "Document")
                            .put("requestStage", "Request")));
            opened.call("Fetch.enable", fetchArgs);
            cdp = opened;
            return opened;
        }
    }

    /**
     * One paused document request: judged, then failed or continued. This is
     * the hook half of the fence on this face — the half that sees every
     * redirect hop, which the entry check never does.
     *
     * @param opened the endpoint the verdict is answered on
     * @param params the {@code Fetch.requestPaused} event
     */
    private void gate(Cdp opened, JsonNode params) {
        String requestId = params.path("requestId").asText();
        String url = params.path("request").path("url").asText();
        NetFence.Refusal refusal;
        try {
            refusal = judge.apply(url);
        } catch (RuntimeException judgeFailed) {
            // The fence must never fail OPEN in silence: an unjudgeable hop is
            // refused, and the refusal names the failure.
            refusal = new NetFence.Refusal(url, "fence-error",
                    "refused a hop the fence could not judge: " + judgeFailed.getMessage());
        }
        if (refusal == null) {
            opened.call("Fetch.continueRequest",
                    JSON.createObjectNode().put("requestId", requestId));
            return;
        }
        refusals.add(new Refusal(refusal.address(), refusal.rule(), refusal.sentence()));
        CompletableFuture<String> waiting = loading;
        if (waiting != null) {
            waiting.complete("the net fence refused a hop on the way there: "
                    + refusal.sentence());
        }
        opened.call("Fetch.failRequest", JSON.createObjectNode()
                .put("requestId", requestId)
                .put("errorReason", "BlockedByClient"));
    }

    // ---- navigate ----------------------------------------------------------

    private Reply navigate(JsonNode args) {
        String url = args.path("url").asText("");
        Cdp opened = engine();
        refusals.clear();
        consoleLines.clear();
        CompletableFuture<String> waiting = new CompletableFuture<>();
        loading = waiting;
        navigatedOnce = true;
        JsonNode result = opened.call("Page.navigate",
                JSON.createObjectNode().put("url", url));
        String errorText = result.path("errorText").asText(null);
        if (errorText != null && !errorText.isBlank()) {
            loading = null;
            return Reply.failed(loadFailureSentence(errorText), pageUrl);
        }
        String verdict;
        try {
            verdict = waiting.get(LOAD_BUDGET.toMillis(), TimeUnit.MILLISECONDS);
        } catch (TimeoutException tooSlow) {
            loading = null;
            return Reply.failed("loading " + url + " did not finish within "
                    + LOAD_BUDGET.toSeconds() + " s", pageUrl);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            loading = null;
            return Reply.failed("the wait for " + url + " was interrupted", pageUrl);
        } catch (java.util.concurrent.ExecutionException impossible) {
            loading = null;
            return Reply.failed("loading " + url + " failed: " + impossible.getMessage(), pageUrl);
        }
        loading = null;
        if (verdict != null) {
            return Reply.failed(verdict, pageUrl);
        }
        String title = evalString(opened, "document.title");
        ObjectNode value = JSON.createObjectNode();
        value.put("title", title == null ? "" : title);
        value.put("url", pageUrl == null ? url : pageUrl);
        value.put("blockedRequests", refusals.size());
        value.put("adblocked", 0);
        return Reply.ok(value, pageUrl == null ? url : pageUrl);
    }

    /**
     * The sentence a failed load deserves — the pane's rule: when the hook
     * refused something during this load, the refusal is the story, because
     * {@code ERR_BLOCKED_BY_CLIENT} is indistinguishable from the outside.
     *
     * @param errorText what Chrome reported
     * @return the sentence
     */
    private String loadFailureSentence(String errorText) {
        List<Refusal> fenced = new ArrayList<>(refusals);
        if (fenced.isEmpty()) {
            return errorText;
        }
        String more = fenced.size() > 1 ? " (and " + (fenced.size() - 1) + " more)" : "";
        return "the net fence refused a hop on the way there: "
                + fenced.get(0).sentence() + more;
    }

    // ---- eval --------------------------------------------------------------

    private Reply eval(JsonNode args) {
        JsonNode result = evaluate(engine(), args.path("text").asText(""), true);
        if (result.has("exceptionDetails")) {
            return Reply.failed(exceptionText(result.path("exceptionDetails")), pageUrl);
        }
        JsonNode value = result.path("result").path("value");
        ObjectNode reply = JSON.createObjectNode();
        reply.set("value", value.isMissingNode() ? JSON.nullNode() : value);
        return Reply.ok(reply, pageUrl);
    }

    /**
     * {@code Runtime.evaluate} with the four pinned semantics spelled out. On
     * CDP two of the four are FLAGS — {@code awaitPromise} and
     * {@code returnByValue} — and forgetting either silently changes the
     * contract's shape, which is the exact hazard card 200 section 1 names.
     *
     * @param opened      the endpoint
     * @param expression  the script, running in the PAGE context
     * @param userGesture whether the page may treat this as a user action
     * @return the raw evaluate result
     */
    private static JsonNode evaluate(Cdp opened, String expression, boolean userGesture) {
        ObjectNode params = JSON.createObjectNode();
        params.put("expression", expression);
        params.put("awaitPromise", true);
        params.put("returnByValue", true);
        params.put("userGesture", userGesture);
        return opened.call("Runtime.evaluate", params);
    }

    private static String exceptionText(JsonNode details) {
        String description = details.path("exception").path("description").asText(null);
        return description != null ? description : details.path("text").asText("the eval threw");
    }

    private static String evalString(Cdp opened, String expression) {
        JsonNode result = evaluate(opened, expression, false);
        JsonNode value = result.path("result").path("value");
        return value.isTextual() ? value.asText() : null;
    }

    // ---- screenshot --------------------------------------------------------

    private Reply screenshot() {
        JsonNode result = engine().call("Page.captureScreenshot",
                JSON.createObjectNode().put("format", "png"));
        String base64 = result.path("data").asText("");
        if (base64.isBlank()) {
            return Reply.failed("the browser answered a screenshot with no image", pageUrl);
        }
        byte[] bytes;
        try {
            bytes = java.util.Base64.getDecoder().decode(base64);
        } catch (IllegalArgumentException notBase64) {
            return Reply.failed("the browser answered a screenshot that is not base64", pageUrl);
        }
        int[] size = pngSize(bytes);
        ObjectNode value = JSON.createObjectNode();
        value.put("mediaType", "image/png");
        value.put("dataBase64", base64);
        value.put("width", size[0]);
        value.put("height", size[1]);
        return Reply.ok(value, pageUrl);
    }

    /**
     * The dimensions out of the PNG itself — its IHDR chunk — rather than a
     * second question to the browser about what it just sent.
     *
     * @param png the image bytes
     * @return width and height, or zeros for something that is not a PNG
     */
    static int[] pngSize(byte[] png) {
        if (png.length < 24 || png[12] != 'I' || png[13] != 'H' || png[14] != 'D'
                || png[15] != 'R') {
            return new int[] {0, 0};
        }
        int width = ((png[16] & 0xFF) << 24) | ((png[17] & 0xFF) << 16)
                | ((png[18] & 0xFF) << 8) | (png[19] & 0xFF);
        int height = ((png[20] & 0xFF) << 24) | ((png[21] & 0xFF) << 16)
                | ((png[22] & 0xFF) << 8) | (png[23] & 0xFF);
        return new int[] {width, height};
    }

    // ---- input -------------------------------------------------------------

    private Reply input(JsonNode args) {
        Cdp opened = engine();
        String action = args.path("action").asText("").toLowerCase(Locale.ROOT);

        if ("wait".equals(action)) {
            long seconds = Math.max(0, Math.min(30, args.path("duration").asLong(1)));
            try {
                Thread.sleep(seconds * 1000);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
            return detail("waited " + seconds + " s");
        }

        int[] point = null;
        String ref = args.path("ref").asText("");
        if (!ref.isBlank()) {
            JsonNode resolved = evaluate(opened, PageScripts.refRect(ref), false)
                    .path("result").path("value");
            if (!resolved.isObject()) {
                return Reply.failed("no element carries the handle "
                        + ref.substring(0, Math.min(20, ref.length()))
                        + " — read the page again, it may have re-rendered", pageUrl);
            }
            point = new int[] {resolved.path("x").asInt(), resolved.path("y").asInt()};
        } else if (args.path("coordinate").isArray() && args.path("coordinate").size() == 2) {
            point = new int[] {args.path("coordinate").get(0).asInt(),
                    args.path("coordinate").get(1).asInt()};
        }

        switch (action) {
            case "type" -> {
                String text = args.path("text").asText("");
                if (point != null) {
                    click(opened, point, 1, "left");
                }
                opened.call("Input.insertText", JSON.createObjectNode().put("text", text));
                return detail("typed " + text.length() + " character(s)");
            }
            case "key" -> {
                String key = args.path("text").asText("");
                if (key.isBlank()) {
                    return Reply.failed("browser_computer action=key needs the key in `text`",
                            pageUrl);
                }
                pressKey(opened, key);
                return detail("pressed " + key);
            }
            case "scroll" -> {
                int amount = args.path("scroll_amount").asInt(3) * 100;
                String direction = args.path("scroll_direction").asText("down");
                // CDP wheel signs are the DOM's own: positive deltaY scrolls
                // down, positive deltaX scrolls right. The Electron pane's
                // sendInputEvent takes the opposite — do not copy it.
                int dx = "right".equals(direction) ? amount
                        : "left".equals(direction) ? -amount : 0;
                int dy = "down".equals(direction) ? amount
                        : "up".equals(direction) ? -amount : 0;
                int[] at = point == null ? new int[] {10, 10} : point;
                ObjectNode wheel = JSON.createObjectNode();
                wheel.put("type", "mouseWheel");
                wheel.put("x", at[0]);
                wheel.put("y", at[1]);
                wheel.put("deltaX", dx);
                wheel.put("deltaY", dy);
                opened.call("Input.dispatchMouseEvent", wheel);
                return detail("scrolled " + direction);
            }
            case "hover" -> {
                if (point == null) {
                    return Reply.failed(
                            "browser_computer action=hover needs a coordinate or a ref", pageUrl);
                }
                ObjectNode move = JSON.createObjectNode();
                move.put("type", "mouseMoved");
                move.put("x", point[0]);
                move.put("y", point[1]);
                opened.call("Input.dispatchMouseEvent", move);
                return detail("hovered " + point[0] + "," + point[1]);
            }
            case "left_click", "right_click", "double_click" -> {
                if (point == null) {
                    return Reply.failed("browser_computer action=" + action
                            + " needs a coordinate or a ref", pageUrl);
                }
                click(opened, point, "double_click".equals(action) ? 2 : 1,
                        "right_click".equals(action) ? "right" : "left");
                return detail(action + " at " + point[0] + "," + point[1]);
            }
            default -> {
                return Reply.failed("this browser does not know the input action \""
                        + action.substring(0, Math.min(40, action.length())) + "\"", pageUrl);
            }
        }
    }

    private Reply detail(String text) {
        return Reply.ok(JSON.createObjectNode().put("detail", text), pageUrl);
    }

    /** One synthetic press and release, preceded by the move a real hand makes. */
    private static void click(Cdp opened, int[] point, int clickCount, String button) {
        ObjectNode move = JSON.createObjectNode();
        move.put("type", "mouseMoved");
        move.put("x", point[0]);
        move.put("y", point[1]);
        opened.call("Input.dispatchMouseEvent", move);
        for (String type : List.of("mousePressed", "mouseReleased")) {
            ObjectNode event = JSON.createObjectNode();
            event.put("type", type);
            event.put("x", point[0]);
            event.put("y", point[1]);
            event.put("button", button);
            event.put("clickCount", clickCount);
            opened.call("Input.dispatchMouseEvent", event);
        }
    }

    /** The named keys the pane's callers actually press, mapped to CDP fields. */
    private record Key(String key, String code, int windowsVirtualKeyCode, String text) {
    }

    private static Key namedKey(String name) {
        return switch (name) {
            case "Enter" -> new Key("Enter", "Enter", 13, "\r");
            case "Tab" -> new Key("Tab", "Tab", 9, "\t");
            case "Backspace" -> new Key("Backspace", "Backspace", 8, null);
            case "Delete" -> new Key("Delete", "Delete", 46, null);
            case "Escape" -> new Key("Escape", "Escape", 27, null);
            case "ArrowUp" -> new Key("ArrowUp", "ArrowUp", 38, null);
            case "ArrowDown" -> new Key("ArrowDown", "ArrowDown", 40, null);
            case "ArrowLeft" -> new Key("ArrowLeft", "ArrowLeft", 37, null);
            case "ArrowRight" -> new Key("ArrowRight", "ArrowRight", 39, null);
            case "Home" -> new Key("Home", "Home", 36, null);
            case "End" -> new Key("End", "End", 35, null);
            case "PageUp" -> new Key("PageUp", "PageUp", 33, null);
            case "PageDown" -> new Key("PageDown", "PageDown", 34, null);
            default -> name.length() == 1 ? new Key(name, null, 0, name) : new Key(name, null, 0, null);
        };
    }

    private static void pressKey(Cdp opened, String name) {
        Key key = namedKey(name);
        ObjectNode down = JSON.createObjectNode();
        down.put("type", key.text() == null ? "rawKeyDown" : "keyDown");
        down.put("key", key.key());
        if (key.code() != null) {
            down.put("code", key.code());
        }
        if (key.windowsVirtualKeyCode() > 0) {
            down.put("windowsVirtualKeyCode", key.windowsVirtualKeyCode());
            down.put("nativeVirtualKeyCode", key.windowsVirtualKeyCode());
        }
        if (key.text() != null) {
            down.put("text", key.text());
        }
        opened.call("Input.dispatchKeyEvent", down);
        ObjectNode up = JSON.createObjectNode();
        up.put("type", "keyUp");
        up.put("key", key.key());
        if (key.code() != null) {
            up.put("code", key.code());
        }
        if (key.windowsVirtualKeyCode() > 0) {
            up.put("windowsVirtualKeyCode", key.windowsVirtualKeyCode());
            up.put("nativeVirtualKeyCode", key.windowsVirtualKeyCode());
        }
        opened.call("Input.dispatchKeyEvent", up);
    }

    // ---- read_page / find --------------------------------------------------

    private Reply readPage(JsonNode args) {
        String filter = args.path("filter").asText("interactive");
        int maxChars = args.path("maxChars").asInt(8000);
        JsonNode result = evaluate(engine(), PageScripts.readPage(filter, maxChars), false);
        if (result.has("exceptionDetails")) {
            return Reply.failed(exceptionText(result.path("exceptionDetails")), pageUrl);
        }
        String tree = result.path("result").path("value").asText("");
        return Reply.ok(JSON.createObjectNode().put("tree", tree), pageUrl);
    }

    private Reply find(JsonNode args) {
        JsonNode result = evaluate(engine(),
                PageScripts.find(args.path("query").asText("")), false);
        String matches = result.path("result").path("value").asText("");
        if ("NO_TREE".equals(matches)) {
            return Reply.failed("nothing has been read yet — call browser_read_page first, "
                    + "because find searches the tree that read produced", pageUrl);
        }
        return Reply.ok(JSON.createObjectNode().put("matches", matches), pageUrl);
    }

    // ---- console -----------------------------------------------------------

    private Reply console(JsonNode args) {
        boolean onlyErrors = args.path("onlyErrors").asBoolean(false);
        String pattern = args.hasNonNull("pattern")
                ? args.path("pattern").asText().toLowerCase(Locale.ROOT) : null;
        int limit = Math.max(1, Math.min(500, args.path("limit").asInt(50)));
        List<String> kept = new ArrayList<>();
        for (String line : consoleLines) {
            if (onlyErrors && !line.matches("(?i)^\\[(error|warn)[^]]*].*")) {
                continue;
            }
            if (pattern != null && !line.toLowerCase(Locale.ROOT).contains(pattern)) {
                continue;
            }
            kept.add(line);
        }
        if (kept.size() > limit) {
            kept = kept.subList(kept.size() - limit, kept.size());
        }
        String blocked = refusals.isEmpty() ? ""
                : "\n(" + refusals.size() + " request(s) refused since this page loaded: "
                        + "0 by the filter list, " + refusals.size() + " by the net fence)";
        return Reply.ok(JSON.createObjectNode()
                .put("lines", String.join("\n", kept) + blocked), pageUrl);
    }

    // ---- resize ------------------------------------------------------------

    /** The pane's own breakpoint: below this width, a phone is emulated. */
    @Governs(kind = Governs.Kind.FOREIGN_CONTRACT, unit = Governs.Unit.PIXELS)
    private static final int MOBILE_BREAKPOINT = 768;

    private Reply resize(JsonNode args) {
        Cdp opened = engine();
        int width = Math.max(200, args.path("width").asInt(1280));
        int height = Math.max(200, args.path("height").asInt(800));
        boolean mobile = width < MOBILE_BREAKPOINT;

        ObjectNode metrics = JSON.createObjectNode();
        metrics.put("width", width);
        metrics.put("height", height);
        metrics.put("deviceScaleFactor", mobile ? 3 : 0);
        metrics.put("mobile", mobile);
        metrics.put("screenWidth", width);
        metrics.put("screenHeight", height);
        opened.call("Emulation.setDeviceMetricsOverride", metrics);

        boolean touchApplied;
        try {
            ObjectNode touch = JSON.createObjectNode();
            touch.put("enabled", mobile);
            touch.put("maxTouchPoints", Math.max(1, mobile ? 5 : 0));
            opened.call("Emulation.setTouchEmulationEnabled", touch);
            ObjectNode emit = JSON.createObjectNode();
            emit.put("enabled", mobile);
            emit.put("configuration", mobile ? "mobile" : "desktop");
            opened.call("Emulation.setEmitTouchEventsForMouse", emit);
            touchApplied = true;
        } catch (RuntimeException touchFailed) {
            touchApplied = false;
        }

        boolean userAgentApplied;
        try {
            opened.call("Emulation.setUserAgentOverride", JSON.createObjectNode()
                    .put("userAgent", mobile
                            ? mobileUserAgent(desktopAgent(opened)) : desktopAgent(opened)));
            userAgentApplied = true;
        } catch (RuntimeException agentFailed) {
            userAgentApplied = false;
        }

        JsonNode measured = evaluate(opened, PageScripts.MEASURE, false)
                .path("result").path("value");
        ObjectNode value = JSON.createObjectNode();
        value.put("width", width);
        value.put("height", height);
        value.put("mobile", mobile);
        value.put("screenWidth", measured.path("screenWidth").asInt(0));
        value.put("screenHeight", measured.path("screenHeight").asInt(0));
        value.put("innerWidth", measured.path("innerWidth").asInt(0));
        value.put("innerHeight", measured.path("innerHeight").asInt(0));
        value.put("viewportMeta", measured.path("viewportMeta").asBoolean(false));
        value.put("maxTouchPoints", measured.path("maxTouchPoints").asInt(0));
        value.put("devicePixelRatio", measured.path("devicePixelRatio").asDouble(0));
        value.put("coarsePointer", measured.path("coarsePointer").asBoolean(false));
        value.put("touchApplied", touchApplied);
        value.put("userAgentApplied", userAgentApplied);
        return Reply.ok(value, pageUrl);
    }

    /** The engine's own agent, remembered on first sight so a second resize
     *  does not build a "desktop" out of a Pixel. */
    private String desktopAgent(Cdp opened) {
        String remembered = baseUserAgent;
        if (remembered != null) {
            return remembered;
        }
        String current = opened.call("Browser.getVersion", null).path("userAgent").asText("");
        // Headless Chrome announces itself; a page that sees "HeadlessChrome"
        // serves its bot fork, which is not the layout under test.
        String honest = current.replace("HeadlessChrome/", "Chrome/");
        baseUserAgent = honest;
        return honest;
    }

    /** The mobile agent, borrowing the engine's own major — a hard-coded
     *  version is true on the day it is written and wrong at the next bump. */
    static String mobileUserAgent(String desktopUserAgent) {
        java.util.regex.Matcher chrome =
                java.util.regex.Pattern.compile("Chrome/(\\d+)").matcher(desktopUserAgent);
        String major = chrome.find() ? chrome.group(1) : "0";
        return "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 "
                + "(KHTML, like Gecko) Chrome/" + major + ".0.0.0 Mobile Safari/537.36";
    }

    // ---- history -----------------------------------------------------------

    private Reply walkHistory(int direction) {
        Cdp opened = engine();
        JsonNode history = opened.call("Page.getNavigationHistory", null);
        int current = history.path("currentIndex").asInt(0);
        JsonNode entries = history.path("entries");
        int target = current + direction;
        if (target < 0) {
            return Reply.failed("there is nothing earlier in this session's history", pageUrl);
        }
        if (target >= entries.size()) {
            return Reply.failed("there is nothing later in this session's history", pageUrl);
        }
        JsonNode entry = entries.get(target);
        opened.call("Page.navigateToHistoryEntry",
                JSON.createObjectNode().put("entryId", entry.path("id").asInt()));
        String url = entry.path("url").asText("");
        pageUrl = url;
        ObjectNode value = JSON.createObjectNode();
        value.put("url", url);
        value.put("title", entry.path("title").asText(""));
        return Reply.ok(value, url);
    }

    /**
     * A reload (card 344, criterion 2): Chromium's own, never a fresh load of
     * the remembered address.
     *
     * <p>The distinction is the whole card. {@code Page.navigate} to the
     * address the bar is showing loses what was typed into a form and re-posts
     * what was posted; the desktop shell states that objection in writing for
     * back/forward, and the reload control did exactly the thing it names.
     */
    private Reply reload() {
        engine().call("Page.reload", JSON.createObjectNode().put("ignoreCache", false));
        return Reply.ok(JSON.createObjectNode().put("url", pageUrl == null ? "" : pageUrl),
                pageUrl);
    }

    /**
     * Closes the page and keeps the login (card 346).
     *
     * <p>The owner's call, 2026-08-30: "ja cookies behalten". Closing a tab in
     * a real browser does not sign you out, so the ENGINE, its profile and its
     * cookie jar all survive — what goes is the page. {@link #close()} is the
     * destructive neighbour and is deliberately not called from here.
     *
     * <p>The address goes with the page and {@link #hasPage()} goes back to
     * false, because "no page" has to mean the same thing here as it does
     * before the first navigate: the toolbar would otherwise serve the closed
     * address forever and the start page would never come back.
     */
    private Reply closePage() {
        stopScreencast();
        engine().call("Page.navigate", JSON.createObjectNode().put("url", "about:blank"));
        pageUrl = null;
        navigatedOnce = false;
        refusals.clear();
        consoleLines.clear();
        announceNavigation();
        return Reply.ok(JSON.createObjectNode().put("closed", true), null);
    }

    // ---- the picture channel (card 226's UI half consumes this) ------------

    /**
     * Starts the screencast into the given sink. One watcher at a time — the
     * newest wins, matching the desktop channel's rule for shells.
     *
     * @param sink    receives every {@code Page.screencastFrame} params object
     *                (already acked): {@code data} base64 jpeg, {@code metadata}
     * @param maxWidth  the widest frame worth sending, in CSS pixels
     * @param maxHeight the tallest
     */
    public void startScreencast(Consumer<JsonNode> sink, int maxWidth, int maxHeight) {
        frameSink = sink;
        ObjectNode params = JSON.createObjectNode();
        params.put("format", "jpeg");
        params.put("quality", 60);
        params.put("maxWidth", maxWidth);
        params.put("maxHeight", maxHeight);
        params.put("everyNthFrame", 1);
        engine().call("Page.startScreencast", params);
    }

    /** Stops the screencast and drops the sink. */
    public void stopScreencast() {
        frameSink = null;
        Cdp current = cdp;
        if (current != null) {
            try {
                current.call("Page.stopScreencast", null);
            } catch (RuntimeException gone) {
                // A cast on a dead engine is already stopped.
            }
        }
    }

    /** Closes the endpoint. The PROCESS is the directory's to kill, not ours. */
    @Override
    public void close() {
        Cdp current = cdp;
        cdp = null;
        if (current != null) {
            try {
                current.close();
            } catch (RuntimeException alreadyGone) {
                // Already gone is closed enough.
            }
        }
    }
}
