package dev.spectroscope.core.config;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Path;
import dev.spectroscope.core.GuideExit;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Card 504, hub and spoke review round 1: chapter 4 of the guide says at which
 * exits the goal's check runs and at which it does not. Each of those
 * sentences is tied here to the test that pins the exit in the agent loop, so
 * a sentence that goes or a test that is renamed or removed turns this red,
 * and whoever changes one sees the other.
 *
 * <p>The table is written by hand. It does not read the exits out of
 * {@code Agent.java}: a new exit in the loop does not turn this red on its
 * own. What it holds is that every exit the guide names has a test, in the
 * part and in both built editions.</p>
 *
 * <p>Review round 2: the tie is written on the test side too. Each pinning
 * test carries {@link GuideExit} with the sentence's id; the marker must sit
 * on the test the table names, every marker in the test tree must name a row
 * of the table once, and the marked test's own body must call an assertion.
 * A test that still asserts something but no longer drives its exit stays
 * green here; that is left to whoever reads the test.</p>
 */
class GoalCheckGuideDriftTest {

    private static final Path PART = Path.of("docs/guide-assets/parts/04-web-chat.html");
    private static final List<Path> EDITIONS =
            List.of(Path.of("docs/USER-GUIDE.html"), Path.of("docs/USER-GUIDE-LIGHT.html"));

    /** A sentence of the guide, its id, and the test of the exit it describes. */
    record Exit(String id, String sentence, String testClass, String testMethod) {
    }

    static final List<Exit> EXITS = List.of(
            new Exit("goal-check.turn-end",
                    "The harness runs the check when the model ends a turn without a tool call and nothing"
                    + " else waits for it", "AgentGoalTest", "aPassingCheckEndsTheRunDoneAndNamesTheCheck"),
            new Exit("goal-check.waiting-sentence",
                    "no sentence you typed during the turn", "AgentSteeringTest",
                    "aWaitingSentenceKeepsARunWithAStatedGoalAliveAndTheNextRequestCarriesIt"),
            new Exit("goal-check.waiting-message",
                    "no message from another agent", "AgentPeerInboxTest",
                    "aWaitingAgentMessageKeepsARunWithAStatedGoalAliveAndTheCheckRunsOnceAtTheLastExit"),
            new Exit("goal-check.background-child",
                    "no result of a background child", "AgentBackgroundJoinTest",
                    "aGoalRunWaitsOnlyUpToTheCheckInAndThenAppendsTheCheckIn"),
            new Exit("goal-check.turn-cap",
                    "It also runs when the run reaches the turn cap", "AgentGoalTest",
                    "aCeilingKeepsItsOwnNameAndTheRecordStillSaysWhetherTheOutcomeWasReached"),
            new Exit("goal-check.output-limit",
                    "or the reply stops at the output limit", "AgentGoalTest", "theTokenCeilingIsTheSameCase"),
            new Exit("goal-check.stop",
                    "It does not run when you press Stop", "AgentGoalTest", "anAbortedRunIsNeverGraded"),
            new Exit("goal-check.error",
                    "when the run ends with an error", "AgentSteeringTest",
                    "aGoalRunThatEndsByAbortOrErrorAfterASentenceKeptItOpenRunsNoCheck"),
            new Exit("goal-check.progress-guard",
                    "when the progress guard ends the run", "AgentGoalTest",
                    "aRunTheGuardEndedIsNotGradedAndSaysSoByItsStopReason"),
            new Exit("goal-check.schedule-wakeup",
                    "or after a call to <code>schedule_wakeup</code>, which ends the run at once", "AgentLoopToolTest",
                    "aGoalIsNotCheckedOnTheRoundThatArmedTheWakeup"),
            new Exit("goal-check.failing-check",
                    "If the check fails at a turn end below the cap, the run goes on with the check's output",
                    "AgentGoalTest", "aFailingCheckContinuesTheRunWithTheFailureAsTheGuidance"),
            new Exit("goal-check.loop-tick",
                    "In a loop the goal is checked only on a tick whose run ends without"
                    + " <code>schedule_wakeup</code>", "AgentLoopToolTest",
                    "aGoalIsCheckedWhenALoopTickEndsWithoutAWakeup"));

    private static Path root() {
        for (Path candidate = Path.of("").toAbsolutePath();
                candidate != null; candidate = candidate.getParent()) {
            if (Files.isRegularFile(candidate.resolve("settings.gradle.kts"))) {
                return candidate;
            }
        }
        return null;
    }

    private static String flat(String text) {
        return text.replaceAll("\\s+", " ");
    }

    static List<String> missing(String page, List<Exit> exits) {
        String flat = flat(page);
        List<String> out = new ArrayList<>();
        for (Exit exit : exits) {
            if (!flat.contains(exit.sentence())) {
                out.add(exit.sentence());
            }
        }
        return out;
    }

    @Test
    void everyExitTheGuideNamesIsInThePartAndBothEditions() throws IOException {
        Path root = root();
        assumeTrue(root != null && Files.isRegularFile(root.resolve(PART)), "not running from a source checkout");
        assertEquals(List.of(), missing(Files.readString(root.resolve(PART)), EXITS), PART.toString());
        for (Path edition : EDITIONS) {
            assertEquals(List.of(), missing(Files.readString(root.resolve(edition)), EXITS), edition.toString());
        }
    }

    @Test
    void everyExitHasItsTest() {
        List<String> absent = new ArrayList<>();
        for (Exit exit : EXITS) {
            try {
                Class<?> type = Class.forName("dev.spectroscope.core." + exit.testClass());
                Method method = type.getDeclaredMethod(exit.testMethod());
                if (!method.isAnnotationPresent(Test.class)) {
                    absent.add(exit.testClass() + "." + exit.testMethod() + " is not a @Test");
                }
                GuideExit marker = method.getAnnotation(GuideExit.class);
                if (marker == null || !marker.value().equals(exit.id())) {
                    absent.add(exit.testClass() + "." + exit.testMethod() + " does not carry @GuideExit(\""
                            + exit.id() + "\")");
                }
            } catch (ClassNotFoundException | NoSuchMethodException e) {
                absent.add(exit.testClass() + "." + exit.testMethod());
            }
        }
        assertEquals(List.of(), absent);
    }

    @Test
    void eachSentenceAndEachTestStandsOnce() {
        Set<String> sentences = new HashSet<>();
        Set<String> tests = new HashSet<>();
        Set<String> ids = new HashSet<>();
        for (Exit exit : EXITS) {
            assertTrue(sentences.add(exit.sentence()), "twice: " + exit.sentence());
            assertTrue(tests.add(exit.testClass() + "." + exit.testMethod()), "twice: " + exit.testMethod());
            assertTrue(ids.add(exit.id()), "twice: " + exit.id());
        }
        assertEquals(12, EXITS.size(), "positive: the twelve exits of chapter 4");
    }

    private static final Pattern MARKER = Pattern.compile("@GuideExit\\(\\s*\"([^\"]*)\"\\s*\\)");
    private static final Path TESTS = Path.of("src/test/java");
    private static final Pattern ASSERTION = Pattern.compile("\\bassert\\w*\\(");

    /** Every {@code @GuideExit} id in the test tree, with the files it stands in. */
    static Map<String, List<String>> markers(Path tree) throws IOException {
        Map<String, List<String>> out = new TreeMap<>();
        try (Stream<Path> files = Files.walk(tree)) {
            for (Path file : files.filter(f -> f.toString().endsWith(".java")).sorted().toList()) {
                if (file.getFileName().toString().equals("GuideExit.java")
                        || file.getFileName().toString().equals("GoalCheckGuideDriftTest.java")) {
                    continue;
                }
                Matcher m = MARKER.matcher(Files.readString(file));
                while (m.find()) {
                    out.computeIfAbsent(m.group(1), k -> new ArrayList<>()).add(file.getFileName().toString());
                }
            }
        }
        return out;
    }

    /** The body of {@code method} in a Java source, braces included, or null. */
    static String body(String source, String method) {
        int at = source.indexOf("void " + method + "(");
        if (at < 0) {
            return null;
        }
        int open = source.indexOf('{', at);
        int depth = 0;
        for (int i = open; i < source.length(); i++) {
            char c = source.charAt(i);
            if (c == '{') {
                depth++;
            } else if (c == '}' && --depth == 0) {
                return source.substring(open, i + 1);
            }
        }
        return null;
    }

    /**
     * Whether the body of {@code method} calls an {@code assert...} method.
     * Comments and the inside of string, text block and char literals are
     * blanked first, so neither an assertion there nor a brace there counts.
     */
    static boolean callsAnAssertion(String source, String method) {
        String body = body(code(source), method);
        return body != null && ASSERTION.matcher(body).find();
    }

    /** {@code source} with comments and the inside of literals replaced by spaces. */
    static String code(String source) {
        StringBuilder out = new StringBuilder(source);
        int i = 0;
        while (i < source.length()) {
            int stop;
            int from;
            int closer;
            if (source.startsWith("//", i)) {
                stop = source.indexOf('\n', i);
                stop = stop < 0 ? source.length() : stop;
                from = i;
                closer = 0;
            } else if (source.startsWith("/*", i)) {
                stop = source.indexOf("*/", i + 2);
                stop = stop < 0 ? source.length() : stop + 2;
                from = i;
                closer = 0;
            } else if (source.startsWith("\"\"\"", i)) {
                stop = source.indexOf("\"\"\"", i + 3);
                stop = stop < 0 ? source.length() : stop;
                from = i + 3;
                closer = 3;
            } else if (source.charAt(i) == '"' || source.charAt(i) == '\'') {
                char quote = source.charAt(i);
                stop = i + 1;
                while (stop < source.length() && source.charAt(stop) != quote && source.charAt(stop) != '\n') {
                    stop += source.charAt(stop) == '\\' ? 2 : 1;
                }
                stop = Math.min(stop, source.length());
                from = i + 1;
                closer = 1;
            } else {
                i++;
                continue;
            }
            for (int k = from; k < stop; k++) {
                if (out.charAt(k) != '\n') {
                    out.setCharAt(k, ' ');
                }
            }
            i = Math.max(stop + closer, i + 1);
        }
        return out.toString();
    }

    @Test
    void everyMarkerNamesOneRowOfTheTableAndEveryRowHasOneMarker() throws IOException {
        assumeTrue(Files.isDirectory(TESTS), "not running from the module directory");
        Map<String, List<String>> found = markers(TESTS);
        List<String> wrong = new ArrayList<>();
        Set<String> ids = new HashSet<>();
        for (Exit exit : EXITS) {
            ids.add(exit.id());
            List<String> where = found.getOrDefault(exit.id(), List.of());
            if (where.size() != 1) {
                wrong.add(exit.id() + " is marked " + where.size() + " times: " + where);
            }
        }
        for (String id : found.keySet()) {
            if (!ids.contains(id)) {
                wrong.add(id + " names no row of the table: " + found.get(id));
            }
        }
        assertEquals(List.of(), wrong);
        assertEquals(12, found.size(), "positive: the twelve markers are read off the test tree");
    }

    @Test
    void eachMarkedTestCallsAnAssertionInItsOwnBody() throws IOException {
        assumeTrue(Files.isDirectory(TESTS), "not running from the module directory");
        List<String> empty = new ArrayList<>();
        for (Exit exit : EXITS) {
            String source = Files.readString(TESTS.resolve("dev/spectroscope/core/" + exit.testClass() + ".java"));
            if (!callsAnAssertion(source, exit.testMethod())) {
                empty.add(exit.testClass() + "." + exit.testMethod());
            }
        }
        assertEquals(List.of(), empty);
    }

    @Test
    void aGuttedTestAndAStrayMarkerAreReported(@org.junit.jupiter.api.io.TempDir Path dir) throws IOException {
        String source = String.join("\n",
                "class Sample {",
                "    @Test @GuideExit(\"goal-check.stop\") void kept() { assertTrue(true); }",
                "    @Test @GuideExit(\"goal-check.gone\") void gutted() { }",
                "}", "");
        assertEquals(null, body(source, "missing"));
        assertEquals("{ }", body(source, "gutted"));
        Files.writeString(dir.resolve("Sample.java"), source);
        assertEquals(Map.of("goal-check.gone", List.of("Sample.java"), "goal-check.stop", List.of("Sample.java")),
                markers(dir));
        // Last fix round: an assertion in a comment or a string literal is no assertion.
        String hollow = String.join("\n",
                "class Sample {",
                "    @Test void kept() { assertTrue(true); }",
                "    @Test void gutted() { }",
                "    @Test void hollow() {",
                "        if (true) { return; } // assertTrue(old);",
                "    }",
                "    @Test void parked() { /* assertEquals(1, 2); } */ }",
                "    @Test void quoted() { log(\"assertTrue(x) }\"); }",
                "}", "");
        assertTrue(callsAnAssertion(hollow, "kept"), "positive: a real assertion counts");
        for (String method : List.of("gutted", "hollow", "parked", "quoted", "missing")) {
            assertFalse(callsAnAssertion(hollow, method), method);
        }
    }

    @Test
    void aSentenceThatIsGoneIsReported() {
        String page = "<p>The harness runs the check when the model\n ends a turn without a tool call.</p>";
        assertEquals(1, missing(page, List.of(EXITS.getFirst())).size());
        String whole = "<p>" + EXITS.getFirst().sentence().replace(" ", "\n  ") + "</p>";
        assertEquals(List.of(), missing(whole, List.of(EXITS.getFirst())), "line breaks in the page do not matter");
    }
}
