package dev.spectroscope.core;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.net.NetFence;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.tools.HttpFetcher;
import dev.spectroscope.core.tools.StandardTools;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.tools.ToolRegistry;
import dev.spectroscope.core.tools.WebFetchTool;
import dev.spectroscope.core.web.BrowsePageTool;
import dev.spectroscope.core.web.WebSearchTool;
import dev.spectroscope.core.web.WebSearcher;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.io.InputStream;
import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.TimeUnit;
import java.util.stream.IntStream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 489: the clamp on one tool result follows the window the loop hands the
 * tool, the same window read_file is judged against.
 *
 * <p>A scripted run drives the five tools that share the clamp ({@code grep},
 * {@code run_command}, {@code web_fetch}, {@code web_search},
 * {@code browse_page}) through the real loop. Every fixture is local: grep and
 * run_command work in a temporary directory, the three web tools get an
 * in-memory fetcher, searcher and Chrome runner behind a fence with a fixed
 * resolver. Eight calls: one large result per tool, two medium results (8,000
 * characters, between the new limit at 8,192 tokens and the old one) and one
 * small one.</p>
 *
 * <p>At a window of 200,000 tokens the outputs are compared with a digest per
 * call captured from v0.14.4 ({@code tool-output-clamp/v0.14.4-window-200000.txt}).
 * Each run prints one line per call ({@code clamp-run ...}) into the test's
 * standard output, which is where the card's before and after counts come
 * from.</p>
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS)
class ToolOutputFollowsTheWindowTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** The small window of the card and the bundled model catalogue. */
    private static final int SMALL_WINDOW = 8_192;

    /** A large window, where the clamp must stay where v0.14.4 had it. */
    private static final int LARGE_WINDOW = 200_000;

    /** The clamp v0.14.4 applied at every window. */
    private static final int OLD_CLAMP = 10_000;

    /** 25 % of 8,192 tokens at 3 characters per token. */
    private static final int SMALL_CLAMP = 6_144;

    /** One planned call: a label (also the call id) and the tool input. */
    private record Planned(String label, String tool, JsonNode input) {}

    /** Issues every planned call in one turn, then answers with text. */
    private static final class ScriptedRun implements LlmProvider {
        private final int window;
        private final List<Planned> calls;
        private boolean issued;

        ScriptedRun(int window, List<Planned> calls) {
            this.window = window;
            this.calls = calls;
        }

        @Override
        public int contextWindow() {
            return window;
        }

        @Override
        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            if (!issued) {
                issued = true;
                List<ProviderEvent> events = new ArrayList<>();
                for (Planned call : calls) {
                    events.add(new PToolCall(call.label(), call.tool(), call.input()));
                }
                events.add(new PStop(PStop.StopReason.TOOL_USE));
                return events;
            }
            return List.of(new PTextDelta("ok"), new PStop(PStop.StopReason.END_TURN));
        }
    }

    private static ObjectNode input() {
        return JSON.createObjectNode();
    }

    /** A text of exactly {@code size} characters, lines of readable words. */
    private static String text(String word, int size) {
        StringBuilder out = new StringBuilder();
        int line = 0;
        while (out.length() < size) {
            out.append(word).append(' ').append(line++).append(" of the fixture text\n");
        }
        return out.substring(0, size);
    }

    /** grep fixtures: a large file and a medium one, each in its own folder. */
    private static void writeGrepFixtures(Path cwd) throws IOException {
        Files.createDirectories(cwd.resolve("large"));
        Files.createDirectories(cwd.resolve("medium"));
        Files.writeString(cwd.resolve("large/notes.txt"), lines("needle", 400));
        Files.writeString(cwd.resolve("medium/notes.txt"), lines("needle", 160));
    }

    private static String lines(String word, int count) {
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < count; i++) {
            out.append("a ").append(word).append(" on line ").append(i)
                    .append(" with some padding text\n");
        }
        return out.toString();
    }

    private static List<Planned> plan() {
        String yes = "yes 0123456789abcdefghijklmnopqrstuvwxyz | head -c ";
        return List.of(
                new Planned("grep-large", "grep",
                        input().put("pattern", "needle").put("path", "large")),
                new Planned("grep-medium", "grep",
                        input().put("pattern", "needle").put("path", "medium")),
                new Planned("run_command-large", "run_command",
                        input().put("command", yes + "20000")),
                new Planned("run_command-medium", "run_command",
                        input().put("command", yes + "8000")),
                new Planned("run_command-small", "run_command",
                        input().put("command", yes + "3000")),
                new Planned("web_fetch-large", "web_fetch",
                        input().put("url", "https://fixture.example/page")),
                new Planned("web_search-large", "web_search",
                        input().put("query", "fixture")),
                new Planned("browse_page-large", "browse_page",
                        input().put("url", "https://fixture.example/app")));
    }

    /** A fence that resolves every host to one public documentation address. */
    private static NetFence fence() {
        return new NetFence(false, host -> List.of(
                InetAddress.getByAddress(host, new byte[] {(byte) 203, 0, (byte) 113, 7})));
    }

    private static List<Tool> tools() {
        List<Tool> belt = new ArrayList<>();
        for (Tool tool : StandardTools.all(30)) {
            if (tool.name().equals("grep") || tool.name().equals("run_command")) {
                belt.add(tool);
            }
        }
        HttpFetcher fetcher = url -> new HttpFetcher.Fetched(200, "text/plain",
                text("fetched", 20_000));
        belt.add(new WebFetchTool(fetcher, fence()));
        List<WebSearcher.Hit> hits = IntStream.rangeClosed(1, 10)
                .mapToObj(i -> new WebSearcher.Hit("Result " + i, "https://fixture.example/" + i,
                        text("snippet", 2_000)))
                .toList();
        belt.add(new WebSearchTool(new WebSearcher() {
            @Override
            public String tier() {
                return "tavily";
            }

            @Override
            public List<Hit> search(String query, int maxResults) {
                return hits;
            }
        }));
        belt.add(new BrowsePageTool(() -> Optional.of(Path.of("/fixture/chrome")),
                (argv, timeoutSeconds, signal) -> new BrowsePageTool.ChromeRunner.Result(0,
                        "<html><body><p>" + text("rendered", 20_000) + "</p></body></html>",
                        "", false, null),
                fence()));
        return belt;
    }

    /** Runs the scripted turn at this window; output per call label, in plan order. */
    private static Map<String, String> run(int window, Path cwd) throws IOException {
        writeGrepFixtures(cwd);
        ToolRegistry registry = new ToolRegistry();
        tools().forEach(registry::register);
        List<Planned> calls = plan();
        Agent agent = new Agent(AgentOptions.builder()
                .provider(new ScriptedRun(window, calls))
                .systemPrompt("test")
                .registry(registry)
                .cwd(cwd)
                .onPermission(request -> true)
                .build());
        Map<String, String> byCall = new LinkedHashMap<>();
        try (EventStream stream = agent.run("go", new RunOptions(new CancelSignal(), null))) {
            stream.forEach(event -> {
                if (event instanceof RunEvent.ToolResult result) {
                    byCall.put(result.callId(), result.output());
                }
            });
        }
        Map<String, String> ordered = new LinkedHashMap<>();
        for (Planned call : calls) {
            String output = byCall.get(call.label());
            assertNotNull(output, "no result for " + call.label());
            ordered.put(call.label(), output);
        }
        for (Map.Entry<String, String> entry : ordered.entrySet()) {
            System.out.println("clamp-run window=" + window + " call=" + entry.getKey()
                    + " chars=" + entry.getValue().length()
                    + " sha256=" + sha256(entry.getValue()));
        }
        return ordered;
    }

    private static String sha256(String text) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(text.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    @Test
    void onAnEightKilotokenWindowNoResultIsLongerThanTheWindowShareAllows(@TempDir Path cwd)
            throws IOException {
        Map<String, String> outputs = run(SMALL_WINDOW, cwd);

        for (Map.Entry<String, String> entry : outputs.entrySet()) {
            assertTrue(entry.getValue().length() <= SMALL_CLAMP, entry.getKey() + " kept "
                    + entry.getValue().length() + " characters on a window of " + SMALL_WINDOW
                    + " tokens, over " + SMALL_CLAMP);
        }
        // The positive side: the large and medium results reach the new limit
        // exactly, so the test cannot pass on outputs that came back empty.
        for (String label : List.of("grep-large", "grep-medium", "run_command-large",
                "run_command-medium", "web_fetch-large", "web_search-large",
                "browse_page-large")) {
            assertEquals(SMALL_CLAMP, outputs.get(label).length(), label);
        }
        assertEquals(3_000, outputs.get("run_command-small").length(),
                "a result under the limit is untouched");
    }

    @Test
    void onALargeWindowEveryResultIsByteIdenticalWithVersionZeroFourteenFour(@TempDir Path cwd)
            throws IOException {
        Map<String, String> outputs = run(LARGE_WINDOW, cwd);
        Map<String, String> captured = capturedFromVersionZeroFourteenFour();

        assertEquals(captured.keySet(), outputs.keySet(), "the capture covers every call");
        for (Map.Entry<String, String> entry : outputs.entrySet()) {
            String line = entry.getValue().length() + " " + sha256(entry.getValue());
            assertEquals(captured.get(entry.getKey()), line, entry.getKey());
        }
        // The positive side: the large results still reach the old clamp.
        for (String label : List.of("grep-large", "run_command-large", "web_fetch-large",
                "web_search-large", "browse_page-large")) {
            assertEquals(OLD_CLAMP, outputs.get(label).length(), label);
        }
    }

    /** label to "length sha256", as captured from v0.14.4. */
    private static Map<String, String> capturedFromVersionZeroFourteenFour() throws IOException {
        Map<String, String> captured = new LinkedHashMap<>();
        try (InputStream in = ToolOutputFollowsTheWindowTest.class.getResourceAsStream(
                "/tool-output-clamp/v0.14.4-window-200000.txt")) {
            assertNotNull(in, "the v0.14.4 capture is on the test classpath");
            for (String line : new String(in.readAllBytes(), StandardCharsets.UTF_8).split("\n")) {
                if (line.isBlank() || line.startsWith("#")) {
                    continue;
                }
                String[] parts = line.trim().split(" ");
                captured.put(parts[0], parts[1] + " " + parts[2]);
            }
        }
        return captured;
    }
}
