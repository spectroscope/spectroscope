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
 * <p>A fourth walk derives which clamp sites carry a notice: text the code
 * writes itself beside a clamped text. A notice joined with {@code +} in front
 * of or after a clamp call, or after what a {@code ShellCommand.Result} hands
 * back, sits outside the clamp and stays whole on every window. A notice handed
 * to {@code ToolOutput.clipBefore} stays whole because the text in front of it
 * gives way. A notice joined into the text a plain {@code clip} or
 * {@code clipTail} cuts could be cut by a smaller window, so the walk refuses
 * it. Every notice it finds has to be bound to the test that pins it on a
 * window of 8,192 tokens; a new one turns the walk red until it is.</p>
 *
 * <p>Comments are stripped before matching, so a sentence that quotes the
 * constant is not a use of it.</p>
 */
class ToolOutputClampDriftTest {

    private static final Pattern FIXED = Pattern.compile("\\bToolOutput\\.MAX_OUTPUT_CHARS\\b");
    private static final Pattern RULE = Pattern.compile("\\bToolOutput\\.maxOutputChars\\(");
    private static final Pattern CLIP = Pattern.compile("\\bToolOutput\\.clip(?:Tail|Before)?\\(");
    private static final Pattern SHELL_RESULT = Pattern.compile(
            "\\bShellCommand\\.Result\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*=");

    /** The rule as a tool hands it the window, whitespace removed. */
    private static final String WINDOW_RULE = "ToolOutput.maxOutputChars(context.contextWindow())";

    /**
     * Files that ask the rule with another argument than the tool context's
     * window, each with the argument and its reason.
     *
     * <p>{@code HookRunner}: a hook runs around a tool call and has no tool
     * context. {@code Agent.runGuarded} hands {@code preToolUse} the window it
     * hands the tool, pinned by {@code HookReasonFollowsTheWindowTest}.</p>
     */
    private static final Map<String, String> RULE_ALLOWED = Map.of(
            "spectro-core/src/main/java/dev/spectroscope/core/hooks/HookRunner.java", "window");

    /**
     * Every notice beside a clamped text, as the notice walk keys it (file, how
     * the notice is attached, the code just in front of the clamped text or the
     * start of the notice), bound to the test that pins it on a window of 8,192
     * tokens. The playbook command check (card 482) has no window: it keeps a
     * fixed tail of 4,000 characters, and its pin shows the exit line stays
     * whole in front of that tail.
     */
    private static final Map<String, String> NOTICE_PINS = Map.of(
            "spectro-core/src/main/java/dev/spectroscope/core/tools/StandardTools.java|joined|r+\"\\n\"+CUT_OUTPUT_MARKER+\"\\n\"+",
            "dev.spectroscope.core.tools.ClampedOutputKeepsItsNoticeTest"
                    + "#aCommandCutByItsTimeLimitKeepsItsNoticeOnASmallWindow",
            "spectro-core/src/main/java/dev/spectroscope/core/tools/StandardTools.java|joined|lt.output().isBlank()?\"\":\"\\n\"+",
            "dev.spectroscope.core.tools.ClampedOutputKeepsItsNoticeTest"
                    + "#aCommandThatFailedKeepsItsExitLineOnASmallWindow",
            "spectro-core/src/main/java/dev/spectroscope/core/tools/StandardTools.java|clipBefore|\"(notsearched,overthefixedfuse",
            "dev.spectroscope.core.tools.ClampedOutputKeepsItsNoticeTest"
                    + "#grepKeepsItsUnsearchedFilesNoticeOnASmallWindow",
            "spectro-core/src/main/java/dev/spectroscope/core/launch/LaunchTools.java|clipBefore|skipped",
            "dev.spectroscope.core.launch.LaunchToolsTest"
                    + "#aSkippedEntryIsStillNamedWhenTheListingIsClampedToTheWindow",
            "spectro-core/src/main/java/dev/spectroscope/core/launch/LaunchTools.java|joined|)){said+=\"\\nWhatitprinted:\\n\"+",
            "dev.spectroscope.core.launch.LaunchToolsTest"
                    + "#aPortThatNeverComesUpNamesTheConfigurationAndThePort",
            "spectro-core/src/main/java/dev/spectroscope/core/launch/LaunchTools.java|joined|swhatitprintedbeforeitdid:\\n\"+",
            "dev.spectroscope.core.launch.LaunchToolsTest"
                    + "#aLongLogIsClampedToTheWindowWhileUpAndAfterItExited",
            "spectro-core/src/main/java/dev/spectroscope/core/browser/BrowserTools.java|joined|\"#\"+where(browser,reply)+\"\\n\"+",
            "dev.spectroscope.core.browser.BrowserToolsTest"
                    + "#theFourReadersClampTheirResultToTheWindow",
            "spectro-core/src/main/java/dev/spectroscope/core/hooks/HookRunner.java|joined|ult.stdout().isBlank()?\"\":\":\"+",
            "dev.spectroscope.core.hooks.HookRunnerTest"
                    + "#aBlockingHooksReasonFollowsTheWindow",
            "spectro-core/src/main/java/dev/spectroscope/core/playbook/run/CommandCheck.java|joined|t.exitCode()+\":\"+command+\"\\n\"+",
            "dev.spectroscope.core.playbook.run.CommandCheckTest"
                    + "#aLongFailingCheckKeepsItsExitLineAndTheTail");

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
     * <p>{@code HookRunner}: it captures a hook's output at the upper bound, as
     * {@code run_command} captures at the clamp. What it hands back as a block
     * reason is clamped to the window afterwards, by the rule.</p>
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
                assertEquals(RULE_ALLOWED.getOrDefault(file, "context.contextWindow()"), argument,
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
                "spectro-core/src/main/java/dev/spectroscope/core/launch/LaunchTools.java",
                "spectro-core/src/main/java/dev/spectroscope/core/hooks/HookRunner.java")) {
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
                int expected = matcher.group().contains("Before") ? 3 : 2;
                assertEquals(expected, arguments.size(), name + " calls clip with " + arguments);
                String bound = arguments.get(expected - 1);
                sites.add(name + "|" + bound);
                String rule = ruleFor(name);
                if (bound.contains(WINDOW_RULE) || bound.contains(rule)
                        || takenFromTheRule(code, bound, rule)) {
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

    @Test
    void everyNoticeBesideAClampedTextStaysWholeAndIsPinned() throws Exception {
        Set<String> notices = new TreeSet<>();
        Set<String> inside = new TreeSet<>();
        for (Path file : mainSources()) {
            String name = relative(file);
            if (name.endsWith("/core/tools/ToolOutput.java")) {
                continue;
            }
            String code = code(file);
            Matcher clip = CLIP.matcher(code);
            while (clip.find()) {
                List<String> arguments = arguments(code, clip.end());
                if (clip.group().contains("Before")) {
                    notices.add(name + "|clipBefore|" + head(arguments.get(1)));
                    continue;
                }
                String text = arguments.get(0);
                if (joinsALiteral(text) || appendsANoticeAfterItsLoops(code, text, clip.start())) {
                    inside.add(name + "|" + text);
                }
                if (joinedOutside(code, clip.start(), closing(code, clip.end()))) {
                    notices.add(name + "|joined|" + tail(code, clip.start()));
                }
            }
            Matcher declared = SHELL_RESULT.matcher(code);
            while (declared.find()) {
                Matcher output = Pattern.compile("\\b" + declared.group(1) + "\\.output\\(\\)")
                        .matcher(code);
                while (output.find()) {
                    if (joinedOutside(code, output.start(), output.end())) {
                        notices.add(name + "|joined|" + tail(code, output.start()));
                    }
                }
            }
        }
        System.out.println("clamp-notices " + notices.size() + " " + notices);
        assertEquals(Set.of(), inside,
                "a notice is joined into the text a clip cuts, so a smaller window cuts the"
                        + " notice; hand it to ToolOutput.clipBefore (card 489)");
        assertEquals(new TreeSet<>(NOTICE_PINS.keySet()), notices,
                "the notices beside a clamped text and their pins differ; bind a new notice to"
                        + " the test that pins it on a window of 8,192 tokens, drop a gone one");
        for (String pin : NOTICE_PINS.values()) {
            String[] parts = pin.split("#");
            boolean found = false;
            for (java.lang.reflect.Method method : Class.forName(parts[0]).getDeclaredMethods()) {
                found |= method.getName().equals(parts[1])
                        && method.isAnnotationPresent(Test.class);
            }
            assertTrue(found, "no test " + pin);
        }
        // The positive side: the walk sees both kinds of notice.
        assertTrue(notices.stream().filter(key -> key.contains("|joined|")).count() >= 5,
                "the walk found too few notices joined outside a clamp: " + notices);
        assertTrue(notices.stream().anyMatch(key -> key.contains("|clipBefore|")),
                "the walk found no notice handed to clipBefore: " + notices);
    }

    /** The rule in the form this file asks it, whitespace removed. */
    private static String ruleFor(String file) {
        String argument = RULE_ALLOWED.get(file);
        return argument == null ? WINDOW_RULE : "ToolOutput.maxOutputChars(" + argument + ")";
    }

    /** Whether a string or char literal is joined with {@code +} into this text. */
    private static boolean joinsALiteral(String text) {
        return text.contains("+\"") || text.contains("\"+")
                || text.contains("+'") || text.contains("'+");
    }

    /**
     * Whether {@code text} is a builder's {@code toString()} and the builder is
     * appended a literal outside every loop after its declaration and before the
     * clip: a line written once after the output, which the clip can cut.
     */
    private static boolean appendsANoticeAfterItsLoops(String code, String text, int clipAt) {
        Matcher builder = Pattern.compile("([A-Za-z_][A-Za-z0-9_]*)\\.toString\\(\\)").matcher(text);
        if (!builder.matches()) {
            return false;
        }
        String id = builder.group(1);
        Matcher declaration = Pattern.compile("\\bStringBuilder\\s+" + id + "\\s*=").matcher(code);
        int from = -1;
        while (declaration.find() && declaration.start() < clipAt) {
            from = declaration.end();
        }
        if (from < 0) {
            return false;
        }
        List<Boolean> blocks = new ArrayList<>();
        int loops = 0;
        int statement = from;
        String append = id + ".append(";
        for (int i = from; i < clipAt; i++) {
            char c = code.charAt(i);
            if (c == '"') {
                i = endOfString(code, i);
                continue;
            }
            if (c == '{') {
                String header = code.substring(statement, i).strip();
                boolean loop = header.matches("(?s)(for|while|do)\\b.*");
                blocks.add(loop);
                loops += loop ? 1 : 0;
                statement = i + 1;
            } else if (c == '}') {
                if (!blocks.isEmpty() && blocks.remove(blocks.size() - 1)) {
                    loops--;
                }
                statement = i + 1;
            } else if (c == ';') {
                statement = i + 1;
            } else if (loops == 0 && code.startsWith(append, i)) {
                int end = code.indexOf(';', i);
                if (code.substring(i, end).contains("\"")) {
                    return true;
                }
            }
        }
        return false;
    }

    /** The index of the closing quote of the string literal opening at {@code at}. */
    private static int endOfString(String code, int at) {
        for (int i = at + 1; i < code.length(); i++) {
            if (code.charAt(i) == '\\') {
                i++;
            } else if (code.charAt(i) == '"') {
                return i;
            }
        }
        return code.length();
    }

    /** Whether the expression from {@code start} to {@code end} is joined with
     *  {@code +} to the code in front of it or after it. */
    private static boolean joinedOutside(String code, int start, int end) {
        int before = start - 1;
        while (before >= 0 && Character.isWhitespace(code.charAt(before))) {
            before--;
        }
        int after = end;
        while (after < code.length() && Character.isWhitespace(code.charAt(after))) {
            after++;
        }
        return (before >= 0 && code.charAt(before) == '+')
                || (after < code.length() && code.charAt(after) == '+');
    }

    /** The index just after the parenthesis that closes the call opened at {@code from}. */
    private static int closing(String code, int from) {
        int depth = 1;
        for (int i = from; i < code.length(); i++) {
            char c = code.charAt(i);
            if (c == '"') {
                i = endOfString(code, i);
            } else if (c == '(') {
                depth++;
            } else if (c == ')' && --depth == 0) {
                return i + 1;
            }
        }
        throw new IllegalStateException("unbalanced call at " + from);
    }

    /** The last 30 characters of code in front of {@code at}, whitespace removed. */
    private static String tail(String code, int at) {
        String flat = code.substring(Math.max(0, at - 200), at).replaceAll("\\s+", "");
        return flat.substring(Math.max(0, flat.length() - 30));
    }

    /** The first 30 characters of a notice argument, whitespace already removed. */
    private static String head(String argument) {
        return argument.substring(0, Math.min(30, argument.length()));
    }

    /** Whether {@code bound} is a plain name that the same file assigns from the
     *  window's rule, as grep does with its local {@code clamp}. */
    private static boolean takenFromTheRule(String code, String bound, String rule) {
        if (!bound.matches("[A-Za-z_][A-Za-z0-9_]*")) {
            return false;
        }
        String flat = code.replaceAll("\\s+", "");
        return Pattern.compile("(?:^|[^A-Za-z0-9_]|final)int" + Pattern.quote(bound) + "="
                + Pattern.quote(rule) + ";").matcher(flat).find();
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
