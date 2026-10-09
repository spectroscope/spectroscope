package dev.spectroscope.core.scheduler;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 476, criterion 1: no test source builds a {@link HeadlessRunner} that
 * would show a real desktop notification.
 *
 * <p>The runtime half lives in {@link HeadlessRunner}: its provider-override
 * constructor, the one tests use, defaults to {@link DesktopNotifier#logOnly()}.
 * This file is the textual half, read over the test sources of all five Java
 * modules, because the two production entries (the public constructor and the
 * CLI bridge {@code HeadlessRunners.withProvider}) do reach the desktop and a
 * test could call either of them.</p>
 *
 * <p>The rules, each of which a test source can break on its own:</p>
 * <ol>
 *   <li>a construction through a production entry is followed directly by
 *       {@code .withNotifier(} or by {@code .notifier()} (reading which
 *       notifier it holds, without running anything);</li>
 *   <li>{@code HeadlessRunner.notify(}, the deprecated static that starts
 *       {@code osascript}, is never called;</li>
 *   <li>{@code DesktopNotifier.system()} appears only as an argument of
 *       {@code assertSame} or {@code assertNotSame};</li>
 *   <li>a source that calls {@code .runJob(} injects a notifier and reads what
 *       it recorded ({@code .withNotifier(} and {@code .shown()}).</li>
 * </ol>
 */
class TestsNeverReachTheDesktopDriftTest {

    private static final List<String> MODULES = List.of("spectro-core", "spectro-cli",
            "spectro-server", "spectro-mcp-notes", "spectro-orchestrator");

    @Test
    void noTestSourceBuildsARunnerThatShowsOnTheDesktop() {
        Map<Path, String> sources = testSources();
        List<String> offenders = new ArrayList<>();
        int constructions = 0;
        int jobRunners = 0;
        for (Map.Entry<Path, String> entry : sources.entrySet()) {
            String name = entry.getKey().toString();
            String src = entry.getValue();
            for (int at : occurrences(src, "new HeadlessRunner(")) {
                constructions++;
                int open = at + "new HeadlessRunner".length();
                int close = closingParen(src, open);
                if (topLevelArguments(src, open, close) == 2 && !chainsANotifier(src, close + 1)) {
                    offenders.add(name + ":" + line(src, at)
                            + " builds a runner with the public constructor and no .withNotifier(");
                }
            }
            for (int at : occurrences(src, "HeadlessRunners.withProvider(")) {
                constructions++;
                int open = at + "HeadlessRunners.withProvider".length();
                if (!chainsANotifier(src, closingParen(src, open) + 1)) {
                    offenders.add(name + ":" + line(src, at)
                            + " builds a runner through the CLI bridge and no .withNotifier(");
                }
            }
            for (int at : occurrences(src, "HeadlessRunner.notify(")) {
                offenders.add(name + ":" + line(src, at) + " calls the static osascript notifier");
            }
            for (int at : occurrences(src, "DesktopNotifier.system()")) {
                String text = lineText(src, at);
                if (!text.contains("assertSame(") && !text.contains("assertNotSame(")) {
                    offenders.add(name + ":" + line(src, at)
                            + " uses the system notifier outside an identity assertion");
                }
            }
            if (src.contains(".runJob(")) {
                jobRunners++;
                if (!src.contains(".withNotifier(") || !src.contains(".shown()")) {
                    offenders.add(name + " runs a job without injecting a notifier and"
                            + " asserting on what it recorded");
                }
            }
        }
        assertTrue(offenders.isEmpty(), "test sources that can reach the desktop: " + offenders);
        // The positive half: a walk that found nothing would pass every rule above.
        assertTrue(constructions >= 40,
                "the walk found only " + constructions + " runner constructions in "
                        + sources.size() + " test sources; it is not reading the tree");
        assertTrue(jobRunners >= 5, "only " + jobRunners + " test sources run a job");
    }

    @Test
    void theCliBridgeKeepsTheSystemNotifier() {
        // HeadlessRunners.withProvider builds through the provider-override
        // constructor, whose default is the log-only notifier. It serves
        // spectro run and the fleet nodes, so it must say what it ships with.
        Path bridge = repoRoot().resolve(
                "spectro-cli/src/main/java/dev/spectroscope/core/scheduler/HeadlessRunners.java");
        String src = read(bridge);
        assertTrue(src.contains(".withNotifier(DesktopNotifier.system())"),
                "HeadlessRunners.withProvider no longer chains the system notifier");
    }

    @Test
    void theArgumentCounterReadsNestedCalls() {
        String src = "new HeadlessRunner(JSON, config(List.of(a, b)), x(\"(,)\"))\n    .withNotifier(n)";
        int open = "new HeadlessRunner".length();
        int close = closingParen(src, open);
        assertEquals(3, topLevelArguments(src, open, close));
        assertTrue(chainsANotifier(src, close + 1));
        String two = "new HeadlessRunner(mapper, config).runJob(job, log)";
        int twoClose = closingParen(two, open);
        assertEquals(2, topLevelArguments(two, open, twoClose));
        assertTrue(!chainsANotifier(two, twoClose + 1));
    }

    private static Map<Path, String> testSources() {
        Path root = repoRoot();
        Map<Path, String> out = new LinkedHashMap<>();
        for (String module : MODULES) {
            Path tests = root.resolve(module).resolve("src/test/java");
            if (!Files.isDirectory(tests)) {
                continue;
            }
            try (Stream<Path> walk = Files.walk(tests)) {
                walk.filter(p -> p.toString().endsWith(".java"))
                        .filter(p -> !p.getFileName().toString()
                                .equals("TestsNeverReachTheDesktopDriftTest.java"))
                        .sorted()
                        .forEach(p -> out.put(root.relativize(p), read(p)));
            } catch (IOException e) {
                throw new UncheckedIOException(e);
            }
        }
        return out;
    }

    private static List<Integer> occurrences(String src, String needle) {
        List<Integer> at = new ArrayList<>();
        for (int i = src.indexOf(needle); i >= 0; i = src.indexOf(needle, i + 1)) {
            at.add(i);
        }
        return at;
    }

    /** Index of the parenthesis that closes the one at {@code open}, skipping
     *  string and char literals. */
    static int closingParen(String src, int open) {
        int depth = 0;
        for (int i = open; i < src.length(); i++) {
            char c = src.charAt(i);
            if (c == '"' || c == '\'') {
                i = endOfLiteral(src, i);
                continue;
            }
            if (c == '(') {
                depth++;
            } else if (c == ')') {
                depth--;
                if (depth == 0) {
                    return i;
                }
            }
        }
        throw new IllegalStateException("unbalanced call at " + open);
    }

    static int topLevelArguments(String src, int open, int close) {
        if (src.substring(open + 1, close).isBlank()) {
            return 0;
        }
        int depth = 0;
        int commas = 0;
        for (int i = open + 1; i < close; i++) {
            char c = src.charAt(i);
            if (c == '"' || c == '\'') {
                i = endOfLiteral(src, i);
            } else if (c == '(' || c == '[' || c == '{') {
                depth++;
            } else if (c == ')' || c == ']' || c == '}') {
                depth--;
            } else if (c == ',' && depth == 0) {
                commas++;
            }
        }
        return commas + 1;
    }

    static boolean chainsANotifier(String src, int from) {
        String rest = src.substring(from).stripLeading();
        return rest.startsWith(".withNotifier(") || rest.startsWith(".notifier()");
    }

    private static int endOfLiteral(String src, int start) {
        char quote = src.charAt(start);
        for (int i = start + 1; i < src.length(); i++) {
            char c = src.charAt(i);
            if (c == '\\') {
                i++;
            } else if (c == quote) {
                return i;
            }
        }
        return src.length() - 1;
    }

    private static int line(String src, int at) {
        return (int) src.substring(0, at).chars().filter(c -> c == '\n').count() + 1;
    }

    private static String lineText(String src, int at) {
        int start = src.lastIndexOf('\n', at) + 1;
        int end = src.indexOf('\n', at);
        return src.substring(start, end < 0 ? src.length() : end);
    }

    private static Path repoRoot() {
        Path dir = Path.of(System.getProperty("user.dir")).toAbsolutePath();
        while (dir != null && !Files.isRegularFile(dir.resolve("settings.gradle.kts"))) {
            dir = dir.getParent();
        }
        if (dir == null) {
            throw new IllegalStateException("no settings.gradle.kts above " + System.getProperty("user.dir"));
        }
        return dir;
    }

    private static String read(Path file) {
        try {
            return Files.readString(file, StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }
}
