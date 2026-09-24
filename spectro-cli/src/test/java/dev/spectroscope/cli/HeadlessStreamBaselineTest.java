package dev.spectroscope.cli;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fasterxml.jackson.databind.node.TextNode;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.scheduler.HeadlessRunner;
import dev.spectroscope.core.scheduler.HeadlessRunners;
import dev.spectroscope.core.session.SessionStore;
import dev.spectroscope.orchestrator.BusEnvelope;
import dev.spectroscope.orchestrator.ProcessBusHub;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.Queue;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 380, criterion 14: a headless stream compared against a file recorded on
 * {@code main} at {@code 301f6e69}.
 *
 * <p>Two faces, driven the way their commands drive them, with one scripted
 * provider. {@code spectro run} is {@link HeadlessRunners#withProvider} plus
 * {@code runOnce}, which is what {@code RunCommand} calls with
 * {@code --verbose}; the NDJSON lines are serialized the way
 * {@code RunCommand.emitNdjson} serializes them. A fleet node is
 * {@link NodeCommand#execute} against an in-process hub, the same path
 * {@code NodeCommandTest} drives. Each face is read twice: the session file it
 * leaves, and the stream it hands out (stdout NDJSON for the run, the payloads
 * the hub received for the node).</p>
 *
 * <p>The fixtures under {@code src/test/resources/steering-baseline/} were
 * written by this same class on a {@code git archive} of {@code 301f6e69}. When
 * a fixture is missing, the test writes what it saw to
 * {@code build/steering-baseline/} and fails, so a missing file is never green.</p>
 *
 * <p><b>What is set to fixed values before the comparison.</b> Fields that come
 * from the clock ({@code ts}, {@code durationMs}, {@code gateWaitMs},
 * {@code waitMs}), the random {@code runId}, and the machine's own paths (the
 * workspace, its real path, the test home). Everything else, including field
 * order and the order of the lines, is compared as written.</p>
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS)
class HeadlessStreamBaselineTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static final SpectroConfig CONFIG = new SpectroConfig(
            "anthropic", "claude-opus-4-8", "http://localhost:11434", 100_000, "ask",
            List.of(), "gemini", true, List.of(), 2, true,
            List.of(), null, "info", null, null, "auto", "auto", null, null, null, null, null,
            null, false, false);

    private static final String PROMPT = "Summarise notes.txt";

    private static final Set<String> CLOCK_FIELDS = Set.of("ts", "durationMs", "gateWaitMs", "waitMs");

    private static final String FIXTURES = "/steering-baseline/";

    /** Three turns: reasoning, text, a free tool and usage; then a free read
     *  and a write the readonly policy refuses, with cache counts; then the
     *  answer. Every call a fresh copy, so two runs never share a queue. */
    private static LlmProvider scripted() {
        Queue<List<LlmProvider.ProviderEvent>> turns = new ArrayDeque<>();
        turns.add(List.of(
                new LlmProvider.PThinkingDelta("Look at the folder first."),
                new LlmProvider.PTextDelta("Let me look."),
                new LlmProvider.PToolCall("c1", "list_dir", JSON.createObjectNode().put("path", ".")),
                new LlmProvider.PUsage(120, 18),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE)));
        turns.add(List.of(
                new LlmProvider.PToolCall("c2", "read_file",
                        JSON.createObjectNode().put("path", "notes.txt")),
                new LlmProvider.PToolCall("c3", "write_file",
                        JSON.createObjectNode().put("path", "summary.txt").put("content", "two lines")),
                new LlmProvider.PUsage(180, 22, 64, 16),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE)));
        turns.add(List.of(
                new LlmProvider.PTextDelta("Two lines, "),
                new LlmProvider.PTextDelta("nothing written."),
                new LlmProvider.PUsage(200, 9),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN)));
        return request -> {
            List<LlmProvider.ProviderEvent> turn = turns.poll();
            if (turn == null) {
                throw new IllegalStateException("no scripted turn left");
            }
            return turn;
        };
    }

    private static Path workspace(Path dir) throws IOException {
        Files.writeString(dir.resolve("notes.txt"), "alpha\nbeta\n", StandardCharsets.UTF_8);
        return dir;
    }

    @Test
    void spectroRunWritesTheStreamMainWrote(@TempDir Path dir) throws IOException {
        Path cwd = workspace(dir);
        List<String> ndjson = new ArrayList<>();
        SessionStore store = new SessionStore();

        HeadlessRunner.Outcome outcome = HeadlessRunners.withProvider(JSON, CONFIG, scripted())
                .runOnce(PROMPT, cwd, false, null, event -> ndjson.add(ndjsonLine(event)),
                        line -> { }, store, List.of());

        assertTrue(outcome.exitOk(), "the scripted run ends on end_turn: " + outcome.stopReason());
        List<String> scrub = scrubPaths(cwd);
        List<String> missing = new ArrayList<>();
        compare("run-ndjson.jsonl", normalize(ndjson, scrub), missing);
        compare("run-session.jsonl", normalize(Files.readAllLines(store.file()), scrub), missing);
        assertTrue(missing.isEmpty(), "no baseline, this run's stream was written instead: " + missing);
    }

    @Test
    void aFleetNodeWritesTheStreamMainWrote(@TempDir Path dir) throws Exception {
        Path cwd = workspace(dir);
        try (ProcessBusHub hub = new ProcessBusHub(0)) {
            List<String> payloads = Collections.synchronizedList(new ArrayList<>());
            CountDownLatch runEnd = new CountDownLatch(1);
            hub.subscribe(BusEnvelope.topicFor("fleet-baseline"), env -> {
                payloads.add(ndjsonLine((RunEvent) env.payload()));
                if (env.payload() instanceof RunEvent.RunEnd) {
                    runEnd.countDown();
                }
            });

            SessionStore store = new SessionStore();
            AtomicInteger exit = new AtomicInteger(-1);
            Thread node = Thread.ofVirtual().start(() -> exit.set(NodeCommand.execute(JSON, CONFIG,
                    scripted(), new NodeCommand.NodeSpec("127.0.0.1", hub.port(), "node-1", 7L,
                            "fleet-baseline", "reviewer", PROMPT, cwd, false, null),
                    store, line -> { })));
            node.join(30_000);
            assertEquals(0, exit.get(), "the node's scripted run ends on end_turn");
            assertTrue(runEnd.await(10, TimeUnit.SECONDS), "the hub received the run's end");

            List<String> scrub = scrubPaths(cwd);
            List<String> missing = new ArrayList<>();
            compare("node-session.jsonl", normalize(Files.readAllLines(store.file()), scrub), missing);
            List<String> received;
            synchronized (payloads) {
                received = List.copyOf(payloads);
            }
            compare("node-bus.jsonl", normalize(received, scrub), missing);
            assertTrue(missing.isEmpty(), "no baseline, this run's stream was written instead: " + missing);
        }
    }

    /** One event the way {@code RunCommand.emitNdjson} prints it. */
    private static String ndjsonLine(RunEvent event) {
        try {
            return new ObjectMapper().writeValueAsString(event);
        } catch (IOException serialization) {
            throw new IllegalStateException(serialization);
        }
    }

    /** The machine's own paths, longest first so a real path is replaced
     *  before the shorter link that points at it. */
    private static List<String> scrubPaths(Path cwd) throws IOException {
        List<String> paths = new ArrayList<>(List.of(
                cwd.toRealPath().toString(), cwd.toAbsolutePath().toString(),
                System.getProperty("user.home")));
        paths.sort(Comparator.comparingInt(String::length).reversed());
        return paths;
    }

    private static List<String> normalize(List<String> lines, List<String> paths) throws IOException {
        List<String> out = new ArrayList<>();
        for (String line : lines) {
            if (line.isBlank()) {
                continue;
            }
            JsonNode tree = JSON.readTree(line);
            scrub(tree, paths);
            out.add(JSON.writeValueAsString(tree));
        }
        return out;
    }

    private static void scrub(JsonNode node, List<String> paths) {
        if (node instanceof ObjectNode object) {
            List<String> names = new ArrayList<>();
            object.fieldNames().forEachRemaining(names::add);
            for (String name : names) {
                JsonNode value = object.get(name);
                if (CLOCK_FIELDS.contains(name) && value.isNumber()) {
                    object.put(name, 0L);
                } else if ("runId".equals(name) && value.isTextual()) {
                    object.put(name, "<run>");
                } else if (value.isTextual()) {
                    object.put(name, replacePaths(value.asText(), paths));
                } else {
                    scrub(value, paths);
                }
            }
        } else if (node instanceof ArrayNode array) {
            for (int i = 0; i < array.size(); i++) {
                if (array.get(i).isTextual()) {
                    array.set(i, new TextNode(replacePaths(array.get(i).asText(), paths)));
                } else {
                    scrub(array.get(i), paths);
                }
            }
        }
    }

    private static String replacePaths(String text, List<String> paths) {
        String out = text;
        for (String path : paths) {
            out = out.replace(path, "<path>");
        }
        return out;
    }

    /**
     * Compares one capture with its fixture. A missing fixture is not a pass:
     * the capture is written under {@code build/steering-baseline/} and its
     * path is added to {@code missing}, which the caller asserts empty after
     * every capture of the run has been written.
     */
    private static void compare(String fixture, List<String> actual, List<String> missing)
            throws IOException {
        // The positive half: the stream under comparison is a whole run, so an
        // empty or truncated capture cannot pass by matching an empty file.
        assertTrue(actual.size() >= 10, fixture + ": the capture holds a whole run: " + actual);
        assertTrue(actual.getFirst().contains("\"type\":\"run_start\""), fixture + ": " + actual.getFirst());
        assertTrue(actual.getLast().contains("\"type\":\"run_end\""), fixture + ": " + actual.getLast());

        try (InputStream in = HeadlessStreamBaselineTest.class.getResourceAsStream(FIXTURES + fixture)) {
            if (in == null) {
                Path written = Path.of("build", "steering-baseline", fixture);
                Files.createDirectories(written.getParent());
                Files.write(written, actual, StandardCharsets.UTF_8);
                missing.add(written.toAbsolutePath().toString());
                return;
            }
            List<String> expected = new String(in.readAllBytes(), StandardCharsets.UTF_8).lines().toList();
            assertEquals(expected, actual, fixture + ": the stream differs from the one main recorded");
        }
    }
}
