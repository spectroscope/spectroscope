package dev.spectroscope.core.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.tools.ToolOutput;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.function.Supplier;

/**
 * The {@code browse_page} tool: renders a page in the SYSTEM Chrome headless
 * ({@code --dump-dom}) and returns the readable text — JavaScript executes,
 * so SPA pages that come back empty from web_fetch read here. Zero new
 * dependencies: no bundled browser, just the Chrome/Chromium already on the
 * machine (an honest hint when none is found; SPECTRO_CHROME overrides the
 * discovery). The URL is model output, so Chrome is exec'd with an ARGV —
 * never through a shell line — and only http/https schemes pass (a file://
 * URL would dump local files). Permission-gated like web_fetch.
 */
public final class BrowsePageTool implements Tool {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final int MAX_OUTPUT_CHARS = ToolOutput.MAX_OUTPUT_CHARS;

    /** Wall-clock kill budget for the Chrome process. */
    static final long CHROME_TIMEOUT_SECONDS = 25;

    /** Chrome-side page-load cap (ms) — Chrome gives up on the page before we kill it. */
    private static final int CHROME_PAGE_TIMEOUT_MS = 15_000;

    /** Virtual time granted to page JavaScript (ms) — this is what makes SPAs render. */
    private static final int CHROME_VIRTUAL_TIME_BUDGET_MS = 8_000;

    /** How much of Chrome's stderr an error answer quotes. */
    private static final int STDERR_TAIL_CHARS = 300;

    /** macOS application-bundle binaries, most common first. */
    private static final List<String> MAC_BUNDLE_BINARIES = List.of(
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser");

    /** PATH binary names (Linux and friends), most common first. */
    private static final List<String> PATH_BINARIES = List.of(
            "google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome");

    /**
     * The process seam — a scripted fake in tests, {@link DefaultChromeRunner}
     * in production. Argv-based on purpose: the URL is untrusted model output
     * and must never pass through a shell line.
     */
    @FunctionalInterface
    public interface ChromeRunner {

        /** Runs one Chrome invocation to completion, timeout or cancellation.
         *  @param argv           the full command line, binary first, URL last
         *  @param timeoutSeconds kill-after budget for the process
         *  @param signal         cooperative cancel forwarded from the run
         *  @return exit code, captured streams and the failure flags */
        Result run(List<String> argv, long timeoutSeconds, CancelSignal signal);

        /** What the Chrome process came back with — every failure mode is data.
         *  @param exitCode the process exit status, or -1 when it never produced one
         *  @param stdout   the dumped DOM (capped by the runner)
         *  @param stderr   Chrome's diagnostics (capped by the runner)
         *  @param timedOut true when the deadline killed the process
         *  @param failure  exception message when the spawn/wait itself failed, else null */
        record Result(int exitCode, String stdout, String stderr, boolean timedOut, String failure) {}
    }

    private final Supplier<Optional<Path>> chromeLocator;
    private final ChromeRunner runner;

    /** The production tool: discover the system Chrome per call, run it for real. */
    public BrowsePageTool() {
        this(() -> findChrome(System.getenv()), new DefaultChromeRunner());
    }

    /**
     * Full wiring — tests inject a fake locator and a scripted runner.
     *
     * @param chromeLocator yields the browser binary, or empty when none is installed;
     *                      consulted per call so a Chrome installed mid-session is found
     * @param runner        the process seam that actually executes Chrome
     */
    public BrowsePageTool(Supplier<Optional<Path>> chromeLocator, ChromeRunner runner) {
        this.chromeLocator = chromeLocator;
        this.runner = runner;
    }

    /**
     * The system-Chrome discovery: the SPECTRO_CHROME override wins when it is
     * executable, then the macOS application bundles, then the PATH names.
     *
     * Public because {@code spectroscope doctor} reports the same discovery.
     *
     * @param env the process environment (System.getenv() in production)
     * @return the first executable browser binary, or empty when none exists
     */
    public static Optional<Path> findChrome(Map<String, String> env) {
        String override = env.get("SPECTRO_CHROME");
        if (override != null && !override.isBlank()) {
            Path binary = Path.of(override);
            if (Files.isExecutable(binary)) {
                return Optional.of(binary);
            }
        }
        for (String bundle : MAC_BUNDLE_BINARIES) {
            Path binary = Path.of(bundle);
            if (Files.isExecutable(binary)) {
                return Optional.of(binary);
            }
        }
        String path = env.get("PATH");
        if (path != null) {
            for (String dir : path.split(java.io.File.pathSeparator)) {
                if (dir.isBlank()) {
                    continue;
                }
                for (String name : PATH_BINARIES) {
                    Path binary = Path.of(dir, name);
                    if (Files.isExecutable(binary)) {
                        return Optional.of(binary);
                    }
                }
            }
        }
        return Optional.empty();
    }

    /** Wire name: {@code browse_page}. */
    @Override
    public String name() {
        return "browse_page";
    }

    /** The model-facing one-liner — says when to prefer it over web_fetch. */
    @Override
    public String description() {
        return "Renders a web page in headless Chrome and returns its readable text "
                + "with JavaScript executed — use when web_fetch returns an empty or "
                + "script-only page. Network egress — guarded by permission.";
    }

    /** One required string: {@code url}. */
    @Override
    public JsonNode inputSchema() {
        ObjectNode schema = JSON.createObjectNode();
        schema.put("type", "object");
        ObjectNode properties = JSON.createObjectNode();
        properties.set("url", JSON.createObjectNode().put("type", "string"));
        schema.set("properties", properties);
        schema.set("required", JSON.createArrayNode().add("url"));
        return schema;
    }

    /** Untrusted input reaching the network through a real browser — the human stays in the loop. */
    @Override
    public boolean needsPermission() {
        return true;
    }

    /** Vets the scheme, locates Chrome, dumps the DOM and reduces it to clipped readable text — every failure path is an "ERROR: " string. */
    @Override
    public String execute(JsonNode input, ToolContext context) {
        String url = input.path("url").asText().strip();
        if (url.isBlank()) {
            return "ERROR: browse_page needs a non-empty url.";
        }
        String lower = url.toLowerCase(Locale.ROOT);
        if (!lower.startsWith("http://") && !lower.startsWith("https://")) {
            return "ERROR: browse_page only supports http and https URLs.";
        }
        Optional<Path> chrome = chromeLocator.get();
        if (chrome.isEmpty()) {
            return "ERROR: browse_page needs a system Chrome/Chromium and none was found — "
                    + "install Google Chrome, or point SPECTRO_CHROME at a browser binary.";
        }

        try {
            ChromeRunner.Result result = runner.run(argv(chrome.get(), url),
                    CHROME_TIMEOUT_SECONDS, context.signal());
            if (result.timedOut()) {
                return "ERROR: browse_page timed out after " + CHROME_TIMEOUT_SECONDS + " s.";
            }
            if (result.failure() != null) {
                return "ERROR: browse_page failed: " + result.failure();
            }
            if (result.exitCode() != 0) {
                String tail = result.stderr() == null ? "" : result.stderr().strip();
                if (tail.length() > STDERR_TAIL_CHARS) {
                    tail = tail.substring(tail.length() - STDERR_TAIL_CHARS);
                }
                return "ERROR: chrome failed with exit code " + result.exitCode()
                        + (tail.isBlank() ? "." : ": " + tail);
            }
            String text = HtmlText.strip(result.stdout() == null ? "" : result.stdout());
            text = ToolOutput.clip(text, MAX_OUTPUT_CHARS);
            return text.isBlank() ? "(no readable text)" : text;
        } catch (RuntimeException failure) {
            return "ERROR: browse_page failed: " + failure.getMessage();
        }
    }

    /**
     * The full Chrome command line: headless dump-dom with a virtual-time
     * budget (JavaScript gets simulated time to render before the dump) and a
     * Chrome-side page timeout under our process kill budget. Binary first,
     * URL last — and the URL stays one argv element, never shell-parsed.
     *
     * @param chrome the located browser binary
     * @param url    the vetted http/https URL
     * @return the argv for the runner
     */
    private static List<String> argv(Path chrome, String url) {
        List<String> argv = new ArrayList<>(List.of(
                chrome.toString(),
                "--headless",
                "--disable-gpu",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-extensions",
                "--hide-scrollbars",
                "--virtual-time-budget=" + CHROME_VIRTUAL_TIME_BUDGET_MS,
                "--timeout=" + CHROME_PAGE_TIMEOUT_MS,
                "--dump-dom"));
        argv.add(url);
        return argv;
    }
}
