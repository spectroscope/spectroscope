package dev.spectroscope.core.browser;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.image.ImageStore;
import dev.spectroscope.core.net.NetFence;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.tools.ToolOutput;

import java.util.Base64;
import java.util.List;
import java.util.Locale;
import java.util.function.Supplier;

/**
 * The seven browser tools of card 201 — the MVP family, and the family is
 * <b>measured, not guessed</b>: 3,447 real browser calls across 35 sessions in
 * the owner's own transcripts, with {@code javascript_exec} alone at 1,413 of
 * them (41 %), ahead of computer (1,099) and navigate (346). Runs of up to
 * twelve consecutive evals between two navigations say what the loop really is:
 * eval is the verification mode, actuator and sensor at once.
 *
 * <p>The tools sit on {@link BrowserFace} and know nothing about Electron. What
 * they own is everything the model can see: the schemas, the tiers, the fence at
 * the entry, the image path, and the sentence a failure comes back as.
 *
 * <p>They also know nothing about SESSIONS, and that is card 218's isolation
 * argument in one sentence. The face they are handed is already the calling
 * session's own ({@link BrowserFaces} does the keying, in the object that owns
 * the control channel), so there is no argument here that could address another
 * one — which is why {@code tab_id} is refused rather than repurposed.
 *
 * <h2>The three rules these tools may not relax</h2>
 *
 * <ol>
 *   <li><b>The fence judges the address before the browser is asked</b> (card 199).
 *       This is the entry check and it is not the whole fence: the engine's own
 *       request hook judges every redirect hop and every subresource, which is
 *       the hole {@code browse_page} documents and cannot close. Both are needed
 *       — this one so a refused address never reaches a browser process at all.</li>
 *   <li><b>Pictures travel the image path, never the text</b> (card 198). A
 *       screenshot lands in the {@link ImageStore} as a content-addressed blob,
 *       is announced as an {@code image_generated} reference event, and is
 *       attached for the model to SEE. Base64 in a {@code tool_result} would
 *       blow the flat 10k output and arrive as characters rather than as an
 *       image.</li>
 *   <li><b>Every failure sentence names the address it tried</b> (cards 193 and
 *       203). For {@code browser_navigate} that is its own argument; for the six
 *       that act on whatever is open it is {@link BrowserFace#pageUrl()}; and
 *       when no browser is attached at all, the sentence says that too and still
 *       names what was asked for.</li>
 * </ol>
 *
 * <h2>Why {@code browser_eval} is {@code eval-execute} and the readers are not</h2>
 *
 * <p>The tier is a deliberate decision, written down because card 199's whole
 * point is that a wildcard must not approve more than a reader meant. An eval
 * runs model-authored JavaScript <b>in the page's own context</b>: it holds that
 * origin's cookies, its {@code localStorage}, its session and its {@code fetch}
 * credentials, and it can act — click, submit, navigate — with the authority of
 * whoever is logged in there. That is code execution, and the page it executes
 * against is attacker-influenced input. So it sits at {@code eval-execute} with
 * {@code run_command}, and a {@code :read} ceiling can never approve it.
 *
 * <p>{@code browser_read_page}, {@code browser_find} and {@code browser_read_console}
 * look and never touch, so they are {@code read}. {@code browser_computer} carries
 * a screenshot (read) and input injection (write) in one tool, and a tool's tier
 * is its widest capability, so it is {@code write} — a reader who wants
 * screenshots without clicks asks for {@code browser_read_page} instead.
 */
public final class BrowserTools {

    private static final ObjectMapper JSON = new ObjectMapper();

    /**
     * What {@code tab_id} means, said on every schema — and it is still a
     * refusal, for a reason that changed on card 218.
     *
     * <p>Card 201 advertised it on all seven tools, let it travel the wire and
     * had the shell drop it without a word, so a model that addressed a second
     * tab silently drove the first one. It was then refused, and its meaning was
     * recorded as "the per-session browser the owner asked for". That work is
     * done: there IS a browser per session now.
     *
     * <p>It did not turn {@code tab_id} into a session selector, and it must not.
     * A tool argument that could name a session would be a way for one session's
     * agent to reach another session's page, cookies and logins — the exact thing
     * card 218 was written to prevent. Which browser a call drives is decided by
     * the SERVER, from the calling session's own store id, and there is no
     * argument on any schema that can change it.
     *
     * <p>So the parameter now means what it always looked like it meant: a second
     * tab INSIDE this session's browser. There is one page per session today, so
     * an id is refused, naming the id and the page. A schema that advertises what
     * the implementation ignores is the same dishonesty cards 193, 199 and 203
     * were each written against.
     */
    static final String TAB_ID_DESCRIPTION =
            "Optional tab id. This browser belongs to YOUR session — one browser per session, "
                    + "with its own cookies and storage — and it holds exactly one page, so a "
                    + "tab id is refused rather than silently ignored. Omit it. It can never "
                    + "name another session's browser.";

    /**
     * The provider-side wire limit for one image, shared with the MCP path.
     * A pane screenshot measured 10.8 KB at 1100x760 in the card 200 spike, so
     * this is a guard rather than a routine cost.
     */
    static final long MAX_SCREENSHOT_BYTES = 5L * 1024 * 1024;

    private final Supplier<BrowserFace> face;
    private final Supplier<NetFence> fence;
    private final ImageStore images;

    /**
     * Builds the family against a browser, a fence and an image store.
     *
     * @param face   where the browser is, read per call — the desktop shell can
     *               attach, detach and restart between two tool calls
     * @param fence  the net fence, read per call so an {@code allowLocalhost}
     *               opt-in saved mid-session reaches the next call
     * @param images the content-addressed store screenshots land in (card 198)
     */
    public BrowserTools(Supplier<BrowserFace> face, Supplier<NetFence> fence, ImageStore images) {
        this.face = face;
        this.fence = fence;
        this.images = images;
    }

    /**
     * The family, in the order the measurement ranks them.
     *
     * @return the seven tools
     */
    public List<Tool> all() {
        return List.of(navigate(), computer(), eval(), readPage(), find(), readConsole(), resize());
    }

    // ---- browser_navigate ----------------------------------------------------

    /**
     * Builds {@code browser_navigate}: points the visible pane at an address.
     *
     * @return the navigate tool
     */
    private Tool navigate() {
        return new BrowserTool("browser_navigate",
                "Points the visible browser pane at a URL and waits for the page to load. "
                        + "The pane is a real browser inside the spectroscope desktop app — the "
                        + "operator watches the same page you are driving. The page PERSISTS "
                        + "between tool calls, so navigate once and then read, eval and click. "
                        + "Private addresses (RFC-1918, the tailnet, link-local) and file:// are "
                        + "refused; localhost needs the operator's allowLocalhost opt-in.",
                schema(properties -> {
                    properties.set("url", string("The absolute http(s) URL to open."));
                    properties.set("tab_id", string(TAB_ID_DESCRIPTION));
                }, "url"),
                true) {

            @Override
            String run(JsonNode input, ToolContext context, BrowserFace browser) {
                String url = text(input, "url");
                if (url.isBlank()) {
                    return "ERROR: browser_navigate needs a url.";
                }
                NetFence.Refusal refusal = fence.get().refuse(url);
                if (refusal != null) {
                    return "ERROR: browser_navigate " + refusal.sentence()
                            + " The address it was given: " + safeUrl(url) + ".";
                }
                ObjectNode args = JSON.createObjectNode().put("url", url);
                BrowserFace.Reply reply = browser.send("navigate", args);
                if (!reply.ok()) {
                    return "ERROR: browser_navigate could not open " + safeUrl(url)
                            + " — " + reply.error();
                }
                String landed = reply.pageUrl() == null ? url : reply.pageUrl();
                String title = reply.value().path("title").asText("");
                return "Opened " + landed + (title.isBlank() ? "" : " — \"" + title + "\"")
                        + ". The pane is showing it now.";
            }

            @Override
            String detachedNoun(JsonNode input) {
                return safeUrl(text(input, "url"));
            }
        };
    }

    // ---- browser_computer ----------------------------------------------------

    /** The input actions the pane understands, advertised to the model verbatim. */
    private static final List<String> COMPUTER_ACTIONS = List.of(
            "screenshot", "left_click", "right_click", "double_click", "type", "key",
            "scroll", "hover", "wait");

    /**
     * Builds {@code browser_computer}: the screenshot plus the input verbs, the
     * second-busiest tool in the measurement (1,099 calls).
     *
     * @return the computer tool
     */
    private Tool computer() {
        return new BrowserTool("browser_computer",
                "Screenshot the visible pane, or click, type, press a key, scroll or hover in "
                        + "it. Coordinates are CSS pixels inside the page, top-left origin, as "
                        + "reported by the last screenshot; a ref_N handle from browser_read_page "
                        + "or browser_find works instead and is steadier than a coordinate. A "
                        + "screenshot comes back as an IMAGE you can see, not as text.",
                schema(properties -> {
                    ObjectNode action = JSON.createObjectNode().put("type", "string");
                    ArrayNode allowed = JSON.createArrayNode();
                    COMPUTER_ACTIONS.forEach(allowed::add);
                    action.set("enum", allowed);
                    action.put("description", "What to do in the pane.");
                    properties.set("action", action);
                    properties.set("coordinate", JSON.createObjectNode()
                            .put("type", "array")
                            .put("description", "[x, y] in CSS pixels, for the pointer actions.")
                            .set("items", JSON.createObjectNode().put("type", "integer")));
                    properties.set("ref", string("A ref_N handle instead of a coordinate."));
                    properties.set("text", string("The text to type, or the key to press."));
                    properties.set("scroll_direction",
                            string("up, down, left or right, for action=scroll."));
                    properties.set("scroll_amount", integer("Wheel clicks, for action=scroll."));
                    properties.set("duration", integer("Seconds, for action=wait."));
                    properties.set("tab_id", string(TAB_ID_DESCRIPTION));
                }, "action"),
                true) {

            @Override
            String run(JsonNode input, ToolContext context, BrowserFace browser) {
                String action = text(input, "action").toLowerCase(Locale.ROOT);
                if (!COMPUTER_ACTIONS.contains(action)) {
                    return "ERROR: browser_computer does not know the action \""
                            + clean(action) + "\" — it does "
                            + String.join(", ", COMPUTER_ACTIONS) + ".";
                }
                if ("screenshot".equals(action)) {
                    return screenshot(input, context, browser);
                }
                ObjectNode args = input.deepCopy();
                BrowserFace.Reply reply = browser.send("input", args);
                if (!reply.ok()) {
                    return "ERROR: browser_computer could not " + clean(action) + " on "
                            + where(browser, reply) + " — " + reply.error();
                }
                return "Did " + clean(action) + " on " + where(browser, reply) + ". "
                        + reply.value().path("detail").asText("");
            }
        };
    }

    /**
     * One screenshot, all the way down card 198's path.
     *
     * <p>Order matters and is the whole point: the media type is canonicalized
     * <b>first</b>, against exactly the set {@code GET /api/images/{file}} can
     * serve back, so a picture the session could never show is refused rather
     * than stored, announced and put on the provider wire. Then the size, decided
     * on the encoded payload so an oversized image never gets a decoded copy.
     * Only then does anything get written.
     *
     * @param input   the model's arguments
     * @param context the run's attach and emit sinks
     * @param browser the attached face
     * @return the one-line note that stands where the picture stood
     */
    private String screenshot(JsonNode input, Tool.ToolContext context, BrowserFace browser) {
        ObjectNode args = JSON.createObjectNode();
        BrowserFace.Reply reply = browser.send("screenshot", args);
        if (!reply.ok()) {
            return "ERROR: browser_computer could not screenshot " + where(browser, reply)
                    + " — " + reply.error();
        }
        String page = where(browser, reply);
        String declared = reply.value().path("mediaType").asText(null);
        String mediaType = ImageStore.servableMediaType(declared);
        if (mediaType == null) {
            return "ERROR: browser_computer got a screenshot of " + page + " typed "
                    + clean(String.valueOf(declared)) + ", and spectroscope carries only "
                    + String.join(", ", ImageStore.servableMediaTypes()) + ".";
        }
        String base64 = reply.value().path("dataBase64").asText("");
        // The size is decided on the ENCODED payload, which is what the javadoc
        // above promises: decoding first would give an oversized image a
        // decoded copy in this heap before anything refused it. A review found
        // the two in the wrong order on 2026-08-13.
        long encodedBytes = decodedLength(base64);
        if (encodedBytes > MAX_SCREENSHOT_BYTES) {
            return "ERROR: browser_computer got a " + encodedBytes
                    + " byte screenshot of " + page + ", over the " + MAX_SCREENSHOT_BYTES
                    + " byte limit for one image — resize the pane and try again.";
        }
        byte[] bytes;
        try {
            bytes = Base64.getDecoder().decode(base64);
        } catch (IllegalArgumentException notBase64) {
            return "ERROR: browser_computer got a screenshot of " + page
                    + " whose payload is not base64.";
        }
        ImageStore.Ref ref;
        try {
            ref = images.put(bytes, mediaType);
        } catch (RuntimeException notStored) {
            return "ERROR: browser_computer could not store the screenshot of " + page
                    + ": " + notStored.getMessage();
        }
        context.emit().accept(new RunEvent.ImageGenerated(context.agentId(), context.callId(),
                "browser_computer screenshot of " + page, "browser", "webcontentsview",
                mediaType, ref.blobPath(), ref.sha256(), System.currentTimeMillis()));
        context.attach().accept(new Tool.AttachedImage(mediaType, base64));
        int width = reply.value().path("width").asInt(0);
        int height = reply.value().path("height").asInt(0);
        return "Screenshot of " + page + " (" + width + "x" + height + ", " + mediaType + ", "
                + bytes.length + " bytes) — attached for you to see.";
    }

    // ---- browser_eval --------------------------------------------------------

    /**
     * Builds {@code browser_eval}, the busiest tool in the measurement and the
     * one whose semantics the owner pinned from his own reference call.
     *
     * <p>The four are the engine's to keep and the description's to promise:
     * page context, actuator and sensor in one call, a returned Promise awaited
     * before serializing, and the resolved value handed back JSON-serialized.
     * Electron's {@code webContents.executeJavaScript} does all four natively —
     * on raw CDP two of them are flags you can forget, which is the argument
     * card 200 section 1 makes.
     *
     * @return the eval tool
     */
    private Tool eval() {
        return new BrowserTool("browser_eval",
                "Runs JavaScript IN THE PAGE and returns what it evaluates to. This is the "
                        + "verification tool: act and sense in one call — click something, write "
                        + "an input through the native value setter plus a dispatched event, then "
                        + "read the result back and return a verdict. A returned Promise is "
                        + "awaited before the value comes back, and the resolved value is "
                        + "JSON-serialized. document, window and localStorage are the page's own. "
                        + "Keep the returned value small: it shares the 10k tool-result budget.",
                schema(properties -> {
                    ObjectNode action = JSON.createObjectNode().put("type", "string");
                    ArrayNode allowed = JSON.createArrayNode();
                    allowed.add("javascript_exec");
                    action.set("enum", allowed);
                    action.put("description", "The single action: javascript_exec.");
                    properties.set("action", action);
                    properties.set("text", string("The JavaScript expression to evaluate."));
                    properties.set("tab_id", string(TAB_ID_DESCRIPTION));
                }, "action", "text"),
                true) {

            @Override
            String run(JsonNode input, ToolContext context, BrowserFace browser) {
                String action = text(input, "action");
                if (!action.isBlank() && !"javascript_exec".equals(action)) {
                    return "ERROR: browser_eval has one action, javascript_exec — not \""
                            + clean(action) + "\".";
                }
                String script = text(input, "text");
                if (script.isBlank()) {
                    return "ERROR: browser_eval needs a text to evaluate on "
                            + where(browser, null) + ".";
                }
                ObjectNode args = JSON.createObjectNode().put("text", script);
                BrowserFace.Reply reply = browser.send("eval", args);
                if (!reply.ok()) {
                    return "ERROR: browser_eval failed on " + where(browser, reply)
                            + " — " + reply.error();
                }
                JsonNode value = reply.value().path("value");
                if (value.isMissingNode() || value.isNull()) {
                    return "undefined";
                }
                return ToolOutput.clip(value.toString(), ToolOutput.MAX_OUTPUT_CHARS);
            }
        };
    }

    // ---- browser_read_page ---------------------------------------------------

    /**
     * Builds {@code browser_read_page}: the accessibility tree with {@code ref_N}
     * handles, and the reason vision is opt-in rather than the default. A tree is
     * a few hundred tokens; a screenshot is a picture per turn.
     *
     * @return the read_page tool
     */
    private Tool readPage() {
        return new BrowserTool("browser_read_page",
                "Reads the current page as a YAML-style accessibility tree. Every interactive "
                        + "element carries a [ref_N] handle you can pass to browser_computer or "
                        + "browser_find. Prefer this over a screenshot for checking text and "
                        + "structure — it is cheaper and it does not go stale on a repaint.",
                schema(properties -> {
                    properties.set("filter",
                            string("\"interactive\" (default) or \"all\"."));
                    properties.set("max_chars", integer("Cap on the tree, default 8000."));
                    properties.set("tab_id", string(TAB_ID_DESCRIPTION));
                }),
                false) {

            @Override
            String run(JsonNode input, ToolContext context, BrowserFace browser) {
                ObjectNode args = JSON.createObjectNode();
                args.put("filter", text(input, "filter").isBlank()
                        ? "interactive" : text(input, "filter"));
                args.put("maxChars", input.path("max_chars").asInt(8000));
                BrowserFace.Reply reply = browser.send("read_page", args);
                if (!reply.ok()) {
                    return "ERROR: browser_read_page could not read " + where(browser, reply)
                            + " — " + reply.error();
                }
                return "# " + where(browser, reply) + "\n"
                        + ToolOutput.clip(reply.value().path("tree").asText(""),
                                ToolOutput.MAX_OUTPUT_CHARS - 200);
            }
        };
    }

    // ---- browser_find --------------------------------------------------------

    /**
     * Builds {@code browser_find}: searches the last tree for elements and hands
     * back their {@code ref_N} handles.
     *
     * @return the find tool
     */
    private Tool find() {
        return new BrowserTool("browser_find",
                "Finds elements in the page by a plain-language description (\"the search "
                        + "box\", \"submit button\") and returns their ref_N handles. Read the "
                        + "page first — this searches the tree that read produced.",
                schema(properties -> {
                    properties.set("query", string("What to look for."));
                    properties.set("tab_id", string(TAB_ID_DESCRIPTION));
                }, "query"),
                false) {

            @Override
            String run(JsonNode input, ToolContext context, BrowserFace browser) {
                String query = text(input, "query");
                if (query.isBlank()) {
                    return "ERROR: browser_find needs a query for " + where(browser, null) + ".";
                }
                ObjectNode args = JSON.createObjectNode().put("query", query);
                BrowserFace.Reply reply = browser.send("find", args);
                if (!reply.ok()) {
                    return "ERROR: browser_find could not search " + where(browser, reply)
                            + " — " + reply.error();
                }
                String matches = reply.value().path("matches").asText("");
                return matches.isBlank()
                        ? "Nothing on " + where(browser, reply) + " matches \"" + clean(query)
                                + "\" — read the page again, it may have changed."
                        : ToolOutput.clip(matches, ToolOutput.MAX_OUTPUT_CHARS);
            }
        };
    }

    // ---- browser_read_console ------------------------------------------------

    /**
     * Builds {@code browser_read_console}: what the page logged, which is where a
     * broken local build says so first.
     *
     * @return the read_console tool
     */
    private Tool readConsole() {
        return new BrowserTool("browser_read_console",
                "Returns the console output (log, info, warn, error, debug) the page has "
                        + "produced since it loaded, newest last. The first place a broken local "
                        + "build says what is wrong.",
                schema(properties -> {
                    properties.set("limit", integer("How many lines, newest first, default 50."));
                    properties.set("only_errors", bool("Errors and warnings only."));
                    properties.set("pattern", string("Keep only lines containing this text."));
                    properties.set("tab_id", string(TAB_ID_DESCRIPTION));
                }),
                false) {

            @Override
            String run(JsonNode input, ToolContext context, BrowserFace browser) {
                ObjectNode args = JSON.createObjectNode();
                args.put("limit", input.path("limit").asInt(50));
                args.put("onlyErrors", input.path("only_errors").asBoolean(false));
                if (!text(input, "pattern").isBlank()) {
                    args.put("pattern", text(input, "pattern"));
                }
                BrowserFace.Reply reply = browser.send("console", args);
                if (!reply.ok()) {
                    return "ERROR: browser_read_console could not read " + where(browser, reply)
                            + " — " + reply.error();
                }
                String lines = reply.value().path("lines").asText("");
                return lines.isBlank()
                        ? "The console of " + where(browser, reply) + " is empty."
                        : ToolOutput.clip(lines, ToolOutput.MAX_OUTPUT_CHARS);
            }
        };
    }

    // ---- browser_resize ------------------------------------------------------

    /** The three presets, and the width below which the pane emulates a phone. */
    private static final int MOBILE_WIDTH = 375;

    /**
     * Builds {@code browser_resize}: the viewport the page believes it has, which
     * is how a responsive layout gets checked without a second machine.
     *
     * @return the resize tool
     */
    private Tool resize() {
        return new BrowserTool("browser_resize",
                "Resizes the page viewport. Presets: mobile (375x812), tablet (768x1024), "
                        + "desktop (1280x800). A viewport under 768 wide is emulated as a "
                        + "phone: device metrics, touch points and a mobile user agent. The "
                        + "answer reports what the PAGE measured afterwards, which is not "
                        + "always what was asked for. Reload the page so load-time device "
                        + "checks and navigator.userAgent see the change.",
                schema(properties -> {
                    properties.set("preset", string("mobile, tablet or desktop."));
                    properties.set("width", integer("Viewport width in CSS pixels."));
                    properties.set("height", integer("Viewport height in CSS pixels."));
                    properties.set("tab_id", string(TAB_ID_DESCRIPTION));
                }),
                true) {

            @Override
            String run(JsonNode input, ToolContext context, BrowserFace browser) {
                int width = input.path("width").asInt(0);
                int height = input.path("height").asInt(0);
                String preset = text(input, "preset").toLowerCase(Locale.ROOT);
                switch (preset) {
                    case "mobile" -> { width = MOBILE_WIDTH; height = 812; }
                    case "tablet" -> { width = 768; height = 1024; }
                    case "desktop" -> { width = 1280; height = 800; }
                    case "" -> { /* explicit width/height below */ }
                    default -> {
                        return "ERROR: browser_resize does not know the preset \"" + clean(preset)
                                + "\" — it has mobile, tablet and desktop.";
                    }
                }
                if (width <= 0 || height <= 0) {
                    return "ERROR: browser_resize needs a preset, or a width and a height, for "
                            + where(browser, null) + ".";
                }
                ObjectNode args = JSON.createObjectNode().put("width", width).put("height", height);
                BrowserFace.Reply reply = browser.send("resize", args);
                if (!reply.ok()) {
                    return "ERROR: browser_resize could not resize " + where(browser, reply)
                            + " — " + reply.error();
                }
                return resized(where(browser, reply), width, height, reply.value());
            }
        };
    }

    /**
     * What {@code browser_resize} says it did, built out of what the pane
     * MEASURED in the page.
     *
     * <p>The first version returned its own arguments: {@code "The viewport of …
     * is now 375x812 (mobile emulation on)."} A review measured the page
     * afterwards — {@code innerWidth} 800, {@code maxTouchPoints} 0, a Macintosh
     * user agent — so the sentence was false in three ways and could not have
     * been anything else, because a tool that answers with its own argument can
     * never be wrong and is therefore worthless as evidence.
     *
     * <p>So every number below comes off the reply, and where the pane did not
     * deliver what was asked, the sentence says both.
     *
     * @param page   the address the pane is showing
     * @param width  the width that was asked for
     * @param height the height that was asked for
     * @param value  what the pane reported back
     * @return the model-facing sentence
     */
    private static String resized(String page, int width, int height, JsonNode value) {
        int deviceWidth = value.path("screenWidth").asInt(0);
        int deviceHeight = value.path("screenHeight").asInt(0);
        if (deviceWidth <= 0 || deviceHeight <= 0) {
            return "browser_resize set the viewport of " + page + " to " + width + "x" + height
                    + ", and the page did not report its own size back — check it with "
                    + "browser_eval before trusting the layout you see.";
        }
        StringBuilder said = new StringBuilder("The viewport of ").append(page)
                .append(" is now ").append(deviceWidth).append("x").append(deviceHeight);
        if (deviceWidth != width || deviceHeight != height) {
            said.append(" (browser_resize asked for ").append(width).append("x")
                    .append(height).append(")");
        }
        int touch = value.path("maxTouchPoints").asInt(0);
        said.append(touch > 0
                ? ", touch emulation is on with " + touch + " points"
                : ", touch emulation is off");
        if (value.path("mobile").asBoolean(false)
                && value.path("userAgentApplied").asBoolean(false)) {
            said.append(", and a mobile user agent applies from the next load");
        }
        said.append(".");

        // The device and the layout viewport are two numbers, and on a phone
        // they routinely differ: a page with no viewport meta tag lays out at
        // the legacy 980 CSS pixels however small the screen is. Measured on
        // this Chromium — a 375-wide device gave innerWidth 981. Saying so is
        // the most useful thing a responsive check can report, and hiding it
        // would be the same kind of smoothing this sentence was rewritten for.
        int layoutWidth = value.path("innerWidth").asInt(0);
        int layoutHeight = value.path("innerHeight").asInt(0);
        if (layoutWidth > 0 && layoutWidth != deviceWidth) {
            said.append(" The page itself lays out at ").append(layoutWidth).append("x")
                    .append(layoutHeight)
                    .append(value.path("viewportMeta").asBoolean(false)
                            ? ", which is its own viewport meta tag's doing."
                            : ": it declares no <meta name=\"viewport\">, so it gets the legacy "
                                    + "980-pixel layout a real phone would give it too.");
        }
        return said.append(" Reload the page so load-time device checks run again.").toString();
    }

    /**
     * How many bytes a base64 payload decodes to, without decoding it.
     *
     * <p>Four encoded characters carry three bytes; padding carries none. The
     * count skips whitespace so a wrapped payload is measured as what it is.
     *
     * @param base64 the encoded payload
     * @return the decoded size in bytes
     */
    static long decodedLength(String base64) {
        long units = 0;
        for (int i = 0; i < base64.length(); i++) {
            char c = base64.charAt(i);
            if (c != '=' && !Character.isWhitespace(c)) {
                units++;
            }
        }
        return units * 3 / 4;
    }

    // ---- the shared shape ----------------------------------------------------

    /**
     * What every browser tool does the same way: check the face is there, say so
     * with the address named when it is not, and never throw.
     */
    private abstract class BrowserTool implements Tool {

        private final String name;
        private final String description;
        private final JsonNode schema;
        private final boolean gated;

        BrowserTool(String name, String description, JsonNode schema, boolean gated) {
            this.name = name;
            this.description = description;
            this.schema = schema;
            this.gated = gated;
        }

        /** @return the wire name the model addresses this tool by */
        @Override
        public final String name() {
            return name;
        }

        /** @return the model-facing manual */
        @Override
        public final String description() {
            return description;
        }

        /** @return the JSON Schema advertised to the provider */
        @Override
        public final JsonNode inputSchema() {
            return schema;
        }

        /** @return whether this tool passes the permission gate first */
        @Override
        public final boolean needsPermission() {
            return gated;
        }

        /**
         * The one call. Attachment first, then the tool's own work, and any
         * escaped runtime failure becomes an "ERROR: " sentence rather than a
         * stack trace in the transcript.
         *
         * @param input   the model's arguments
         * @param context the run's per-call environment
         * @return the tool result
         */
        @Override
        public final String execute(JsonNode input, ToolContext context) {
            BrowserFace browser = face.get();
            if (browser == null || !browser.attached()) {
                return "ERROR: " + name + " could not reach " + detachedNoun(input)
                        + " — " + BrowserFace.DETACHED + ".";
            }
            String tab = text(input, "tab_id");
            if (!tab.isBlank()) {
                // Silently serving the only page to a model that asked for
                // another one is a lie the transcript never records. See
                // TAB_ID_DESCRIPTION for why the parameter stays and why it is
                // not a session selector.
                return "ERROR: " + name + " was given the tab id \"" + clean(tab)
                        + "\", and this session's browser holds exactly one page, on "
                        + where(browser, null) + " — omit tab_id. It cannot name another "
                        + "session's browser: which browser you drive is your session's, "
                        + "decided by the server.";
            }
            try {
                return run(input, context, browser);
            } catch (RuntimeException failure) {
                return "ERROR: " + name + " failed on " + where(browser, null) + " — "
                        + failure.getMessage();
            }
        }

        /**
         * What this tool was trying to reach, for the no-browser sentence.
         *
         * @param input the model's arguments
         * @return the address or noun the failure names; the open page by default
         */
        String detachedNoun(JsonNode input) {
            return "the browser pane";
        }

        /**
         * The tool's own work, with a live face in hand.
         *
         * @param input   the model's arguments
         * @param context the run's per-call environment
         * @param browser the attached face
         * @return the tool result
         */
        abstract String run(JsonNode input, ToolContext context, BrowserFace browser);
    }

    /**
     * The address a sentence names: what the reply says it happened on, else what
     * the pane is showing, else the honest admission that nothing is open.
     *
     * @param browser the face
     * @param reply   the reply in hand, or null when there is none yet
     * @return a printable address, never null
     */
    private static String where(BrowserFace browser, BrowserFace.Reply reply) {
        String fromReply = reply == null ? null : reply.pageUrl();
        String url = fromReply != null ? fromReply : browser.pageUrl();
        return url == null || url.isBlank() ? "the pane (no page is open yet)" : safeUrl(url);
    }

    /**
     * A URL inside a model-facing sentence. The model wrote it, so it is
     * untrusted text in a sentence the harness appears to be speaking: it is
     * clipped and stripped of anything that could break the line.
     *
     * @param url the address as it was given
     * @return the address, bounded and single-line
     */
    private static String safeUrl(String url) {
        return clean(url == null ? "(no address)" : url);
    }

    /** Untrusted text inside our own sentence: one line, bounded, no controls. */
    private static String clean(String raw) {
        String flat = raw.replaceAll("[\\p{Cntrl}]", " ").strip();
        return flat.length() <= 300 ? flat : flat.substring(0, 300) + "…";
    }

    /** Reads a string field, never null. */
    private static String text(JsonNode input, String field) {
        JsonNode node = input.path(field);
        return node.isTextual() ? node.asText() : "";
    }

    /** A schema with a properties block and an optional required list. */
    private static JsonNode schema(java.util.function.Consumer<ObjectNode> fill,
            String... required) {
        ObjectNode root = JSON.createObjectNode().put("type", "object");
        ObjectNode properties = JSON.createObjectNode();
        fill.accept(properties);
        root.set("properties", properties);
        if (required.length > 0) {
            ArrayNode names = JSON.createArrayNode();
            for (String name : required) {
                names.add(name);
            }
            root.set("required", names);
        }
        return root;
    }

    /** A string property with a description. */
    private static ObjectNode string(String description) {
        return JSON.createObjectNode().put("type", "string").put("description", description);
    }

    /** An integer property with a description. */
    private static ObjectNode integer(String description) {
        return JSON.createObjectNode().put("type", "integer").put("description", description);
    }

    /** A boolean property with a description. */
    private static ObjectNode bool(String description) {
        return JSON.createObjectNode().put("type", "boolean").put("description", description);
    }
}
