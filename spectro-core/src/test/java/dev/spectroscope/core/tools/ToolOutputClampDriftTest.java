package dev.spectroscope.core.tools;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
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
 * <p>Comments are stripped before matching, so a sentence that quotes the
 * constant is not a use of it.</p>
 */
class ToolOutputClampDriftTest {

    private static final Pattern FIXED = Pattern.compile("\\bToolOutput\\.MAX_OUTPUT_CHARS\\b");
    private static final Pattern RULE = Pattern.compile("\\bToolOutput\\.maxOutputChars\\(");

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
        // The positive side: the five tools the card names are among the users.
        for (String file : List.of(
                "spectro-core/src/main/java/dev/spectroscope/core/tools/StandardTools.java",
                "spectro-core/src/main/java/dev/spectroscope/core/tools/WebFetchTool.java",
                "spectro-core/src/main/java/dev/spectroscope/core/web/WebSearchTool.java",
                "spectro-core/src/main/java/dev/spectroscope/core/web/BrowsePageTool.java")) {
            assertTrue(calls.containsKey(file), file + " no longer asks the window's clamp");
        }
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
