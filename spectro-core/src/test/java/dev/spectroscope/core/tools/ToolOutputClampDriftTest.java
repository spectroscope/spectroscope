package dev.spectroscope.core.tools;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 489, criterion 6: every user of the shared clamp takes it from the
 * window, so a further tool joins the rule without a list somebody updates.
 *
 * <p>The test walks the main sources of every module and finds each file that
 * names the clamp. A file may name the fixed {@code ToolOutput.MAX_OUTPUT_CHARS}
 * only when it is listed below with its reason. Every other file has to ask
 * {@code ToolOutput.maxOutputChars(...)} with the window its tool context
 * carries. A new tool that reaches for the fixed constant turns this red; one
 * that asks the rule is found and checked by the same walk.</p>
 *
 * <p>A third walk keys on the clamp sites themselves: every call of
 * {@code ToolOutput.clip(...)} and {@code ToolOutput.clipTail(...)}. Its bound
 * has to be the rule with the tool context's window, a local value assigned from
 * exactly that, or one of the sites listed below with its reason. A literal or a
 * private constant handed to {@code clip} is therefore found too, which the two
 * walks over the names alone could not see. What the bound does to a result is
 * pinned by behaviour, per tool: {@code ToolOutputFollowsTheWindowTest} for the
 * five tools the card names, {@code BrowserToolsTest} and {@code LaunchToolsTest}
 * for the browser and launch readers.</p>
 *
 * <p>Comments are stripped before matching, so a sentence that quotes the
 * constant is not a use of it.</p>
 */
class ToolOutputClampDriftTest {

    private static final Pattern FIXED = Pattern.compile("\\bToolOutput\\.MAX_OUTPUT_CHARS\\b");
    private static final Pattern RULE = Pattern.compile("\\bToolOutput\\.maxOutputChars\\(");
    private static final Pattern CLIP = Pattern.compile("\\bToolOutput\\.clip(?:Tail)?\\(");

    /** The rule as a tool hands it the window, whitespace removed. */
    private static final String WINDOW_RULE = "ToolOutput.maxOutputChars(context.contextWindow())";

    /**
     * Clamp sites whose bound is not the window's rule, keyed by file and the
     * bound as written (whitespace removed), each with its reason.
     */
    private static final Map<String, String> CLIP_ALLOWED = Map.of(
            "spectro-core/src/main/java/dev/spectroscope/core/tools/ShellCommand.java|maxOutputChars",
            "the caller's bound: run_command hands it the rule (StandardTools), the hook"
                    + " runner and the goal check hand their own",
            "spectro-core/src/main/java/dev/spectroscope/core/launch/LaunchTools.java|2_000",
            "launch_start quotes at most 2,000 characters of a failed start's last lines"
                    + " inside its error sentence",
            "spectro-core/src/main/java/dev/spectroscope/core/goal/GoalVerdict.java|MAX_OUTPUT_CHARS",
            "the goal check's own 4,000 characters of a check command's tail, not a tool result");

    /**
     * Files that may keep the fixed clamp, each with its reason.
     *
     * <p>{@code HookRunner}: a hook runs around a tool call, not inside one. Its
     * runner is handed no tool context and therefore no window.</p>
     */
    private static final Set<String> FIXED_ALLOWED = Set.of(
            "spectro-core/src/main/java/dev/spectroscope/core/hooks/HookRunner.java");

    @Test
    void onlyTheListedFilesNameTheFixedClamp() throws IOException {
        Set<String> users = new TreeSet<>();
        for (Path file : mainSources()) {
            if (FIXED.matcher(code(file)).find()) {
                users.add(relative(file));
            }
        }
        assertEquals(new TreeSet<>(FIXED_ALLOWED), users,
                "a file names ToolOutput.MAX_OUTPUT_CHARS; a tool result takes its clamp from"
                        + " ToolOutput.maxOutputChars(context.contextWindow()) (card 489)");
    }

    @Test
    void everyUserOfTheRuleHandsItTheToolContextsWindow() throws IOException {
        TreeMap<String, List<String>> calls = new TreeMap<>();
        for (Path file : mainSources()) {
            String code = code(file);
            Matcher matcher = RULE.matcher(code);
            while (matcher.find()) {
                calls.computeIfAbsent(relative(file), key -> new ArrayList<>())
                        .add(argument(code, matcher.end()));
            }
        }
        System.out.println("clamp-users " + calls);
        calls.forEach((file, arguments) -> arguments.forEach(argument ->
                assertEquals("context.contextWindow()", argument,
                        file + " asks the clamp with \"" + argument + "\", not with the window"
                                + " of its tool context")));
        // The positive side: the five tools the card names and the browser and
        // launch readers of its blast radius are among the users.
        for (String file : List.of(
                "spectro-core/src/main/java/dev/spectroscope/core/tools/StandardTools.java",
                "spectro-core/src/main/java/dev/spectroscope/core/tools/WebFetchTool.java",
                "spectro-core/src/main/java/dev/spectroscope/core/web/WebSearchTool.java",
                "spectro-core/src/main/java/dev/spectroscope/core/web/BrowsePageTool.java",
                "spectro-core/src/main/java/dev/spectroscope/core/browser/BrowserTools.java",
                "spectro-core/src/main/java/dev/spectroscope/core/launch/LaunchTools.java")) {
            assertTrue(calls.containsKey(file), file + " no longer asks the window's clamp");
        }
    }

    @Test
    void everyClampSiteTakesTheWindowsRuleOrIsListedWithItsReason() throws IOException {
        List<String> sites = new ArrayList<>();
        Set<String> unexplained = new TreeSet<>();
        Set<String> listedAndSeen = new TreeSet<>();
        for (Path file : mainSources()) {
            String name = relative(file);
            if (name.endsWith("/core/tools/ToolOutput.java")) {
                continue;
            }
            String code = code(file);
            Matcher matcher = CLIP.matcher(code);
            while (matcher.find()) {
                List<String> arguments = arguments(code, matcher.end());
                assertEquals(2, arguments.size(), name + " calls clip with " + arguments);
                String bound = arguments.get(1);
                sites.add(name + "|" + bound);
                if (bound.contains(WINDOW_RULE) || takenFromTheRule(code, bound)) {
                    continue;
                }
                String key = name + "|" + bound;
                if (CLIP_ALLOWED.containsKey(key)) {
                    listedAndSeen.add(key);
                } else {
                    unexplained.add(key);
                }
            }
        }
        System.out.println("clamp-sites " + sites.size() + " " + sites);
        assertEquals(Set.of(), unexplained,
                "a clamp site takes a bound that is not ToolOutput.maxOutputChars("
                        + "context.contextWindow()); a tool result follows the window (card 489)");
        assertEquals(new TreeSet<>(CLIP_ALLOWED.keySet()), listedAndSeen,
                "a listed exception no longer exists; drop it from CLIP_ALLOWED");
        // The positive side: the walk does see the window's clamp sites.
        assertTrue(sites.stream().filter(site -> site.contains(WINDOW_RULE)).count() >= 10,
                "the walk found too few clamp sites on the rule: " + sites);
    }

    /** Whether {@code bound} is a plain name that the same file assigns from the
     *  window's rule, as grep does with its local {@code clamp}. */
    private static boolean takenFromTheRule(String code, String bound) {
        if (!bound.matches("[A-Za-z_][A-Za-z0-9_]*")) {
            return false;
        }
        String flat = code.replaceAll("\\s+", "");
        return Pattern.compile("(?:^|[^A-Za-z0-9_]|final)int" + Pattern.quote(bound) + "="
                + Pattern.quote(WINDOW_RULE) + ";").matcher(flat).find();
    }

    /** The top-level comma-separated arguments of the call whose opening
     *  parenthesis ends at {@code from}, whitespace removed. */
    private static List<String> arguments(String code, int from) {
        List<String> arguments = new ArrayList<>();
        int depth = 1;
        int start = from;
        boolean inString = false;
        for (int i = from; i < code.length(); i++) {
            char c = code.charAt(i);
            if (inString) {
                if (c == '\\') {
                    i++;
                } else if (c == '"') {
                    inString = false;
                }
                continue;
            }
            if (c == '"') {
                inString = true;
            } else if (c == '(') {
                depth++;
            } else if (c == ',' && depth == 1) {
                arguments.add(code.substring(start, i).replaceAll("\\s+", ""));
                start = i + 1;
            } else if (c == ')' && --depth == 0) {
                arguments.add(code.substring(start, i).replaceAll("\\s+", ""));
                return arguments;
            }
        }
        throw new IllegalStateException("unbalanced call at " + from);
    }

    /** The text between the opening parenthesis that ends at {@code from} and
     *  its matching closing one, trimmed. */
    private static String argument(String code, int from) {
        int depth = 1;
        for (int i = from; i < code.length(); i++) {
            char c = code.charAt(i);
            if (c == '(') {
                depth++;
            } else if (c == ')' && --depth == 0) {
                return code.substring(from, i).replaceAll("\\s+", "");
            }
        }
        throw new IllegalStateException("unbalanced call at " + from);
    }

    private static String code(Path file) throws IOException {
        return Files.readString(file, StandardCharsets.UTF_8)
                .replaceAll("(?s)/\\*.*?\\*/", "")
                .replaceAll("(?m)//.*$", "");
    }

    /** Every Java file under a module's {@code src/main/java}, modules being the
     *  repository root's direct children. */
    private static List<Path> mainSources() throws IOException {
        List<Path> files = new ArrayList<>();
        try (Stream<Path> modules = Files.list(repoRoot())) {
            for (Path module : modules.filter(Files::isDirectory).sorted().toList()) {
                Path main = module.resolve("src/main/java");
                if (!Files.isDirectory(main)) {
                    continue;
                }
                try (Stream<Path> walk = Files.walk(main)) {
                    walk.filter(path -> path.toString().endsWith(".java")).forEach(files::add);
                }
            }
        }
        assertTrue(files.size() > 100, "the walk found " + files.size() + " sources");
        return files;
    }

    private static String relative(Path file) {
        return repoRoot().relativize(file).toString().replace('\\', '/');
    }

    private static Path repoRoot() {
        Path dir = Path.of(System.getProperty("user.dir")).toAbsolutePath();
        while (dir != null && !Files.isRegularFile(dir.resolve("settings.gradle.kts"))) {
            dir = dir.getParent();
        }
        if (dir == null) {
            throw new IllegalStateException("no settings.gradle.kts above "
                    + System.getProperty("user.dir"));
        }
        return dir;
    }
}
