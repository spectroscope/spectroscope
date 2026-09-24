package dev.spectroscope.core.tools;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.CancelSignal;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTimeoutPreemptively;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Card 379: the rtk seam. Spectro asks rtk what a line could become and owns
 * the refusal; it never models rtk's verb list.
 *
 * <p>The cases that drive the real binary skip where rtk does not resolve,
 * because CI has no rtk. Those skips are counted and named in the card's report
 * rather than passing as a green run that never happened.</p>
 */
@Timeout(value = 90, unit = TimeUnit.SECONDS)
class RtkFilterTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static JsonNode call(String command) {
        ObjectNode node = JSON.createObjectNode();
        node.put(RtkFilter.COMMAND_FIELD, command);
        return node;
    }

    private static String commandOf(JsonNode node) {
        return node.path(RtkFilter.COMMAND_FIELD).asText();
    }

    /** An oracle that answers from a fixed line, and counts what it was asked. */
    private static final class ScriptedOracle implements RtkFilter.Oracle {
        private final String answer;
        final List<String> asked = new ArrayList<>();

        ScriptedOracle(String answer) {
            this.answer = answer;
        }

        public String rewrite(String line) {
            asked.add(line);
            return answer;
        }

        public String version() {
            return "rtk 0.0.0-scripted";
        }
    }

    // ---- criterion 3: off means byte identical and no rtk process ----------

    @Test
    void offHandsTheModelsLineThroughUntouchedAndNeverAsksRtk() {
        ScriptedOracle oracle = new ScriptedOracle("rtk ls -la");
        RtkFilter filter = new RtkFilter(() -> false, oracle);

        JsonNode sent = call("ls -la");
        JsonNode out = filter.apply("run_command", sent);

        assertEquals("ls -la", commandOf(out));
        assertFalse(out.has(RtkFilter.REWRITER_FIELD), "an untouched line carries no rewriter mark");
        assertTrue(oracle.asked.isEmpty(), "off must start no rtk process at all");
    }

    @Test
    void anotherToolIsNeverTouchedEvenWithTheSwitchOn() {
        ScriptedOracle oracle = new ScriptedOracle("rtk ls -la");
        RtkFilter filter = new RtkFilter(() -> true, oracle);

        ObjectNode input = JSON.createObjectNode();
        input.put("path", "ls -la");
        JsonNode out = filter.apply("read_file", input);

        assertSame(input, out);
        assertTrue(oracle.asked.isEmpty());
    }

    // ---- criterion 4: no verb table, and the denylist is read once ---------

    @Test
    void aVerbSpectroHasNeverSeenIsUsedBecauseRtkAndNotSpectroDecides() {
        ScriptedOracle oracle = new ScriptedOracle("rtk zzzfoo --deep");
        RtkFilter filter = new RtkFilter(() -> true, oracle);

        JsonNode out = filter.apply("run_command", call("zzzfoo --deep"));

        assertEquals("rtk zzzfoo --deep", commandOf(out));
        assertEquals("zzzfoo --deep", out.path(RtkFilter.ORIGINAL_FIELD).asText());
        assertEquals(RtkFilter.REWRITER, out.path(RtkFilter.REWRITER_FIELD).asText());
        assertEquals(List.of("zzzfoo --deep"), oracle.asked);
    }

    /** Criterion 4, second bite: the refusal is DERIVED from the constant. Put a
     *  new entry there and this case covers it without being edited, which is
     *  what a hand list guarded by a copy of itself cannot do. */
    @Test
    void everyDeniedVerbIsRefusedAlthoughRtkOffersARewrite() {
        assertFalse(RtkFilter.DENIED_VERBS.isEmpty(), "the denylist is spectro's only list");
        for (String verb : RtkFilter.DENIED_VERBS) {
            ScriptedOracle oracle = new ScriptedOracle("rtk " + verb + " whatever");
            RtkFilter filter = new RtkFilter(() -> true, oracle);

            JsonNode out = filter.apply("run_command", call("something " + verb));

            assertEquals("something " + verb, commandOf(out),
                    "denied verb " + verb + " must reach the shell unchanged");
            assertFalse(out.has(RtkFilter.REWRITER_FIELD),
                    "denied verb " + verb + " must not be marked as rewritten");
        }
    }

    /** Review round 2026-09-24. rtk rewrites every segment of a compound line,
     *  so a denied verb can sit after a {@code cd}, a pipe or a {@code ;}. The
     *  refusal used to read only the first token. Each shape here is what rtk
     *  0.45.0 printed for a real line that day, with the verb swapped for every
     *  entry of the constant. */
    @Test
    void aDeniedVerbAnywhereInACompoundAnswerIsRefused() {
        for (String verb : RtkFilter.DENIED_VERBS) {
            List<String> answers = List.of(
                    "cd sub && rtk " + verb + " x",
                    "rtk ls -la && rtk " + verb + " x",
                    "rtk git status; rtk " + verb + " x",
                    "rtk git status || rtk " + verb + " x",
                    "ls | rtk " + verb + " x",
                    "(cd sub; rtk " + verb + " x)");
            for (String answer : answers) {
                RtkFilter filter = new RtkFilter(() -> true, new ScriptedOracle(answer));

                JsonNode out = filter.apply("run_command", call("the model's line"));

                assertEquals("the model's line", commandOf(out),
                        "rtk answered [" + answer + "], which runs the denied verb " + verb);
                assertFalse(out.has(RtkFilter.REWRITER_FIELD));
            }
        }
    }

    /** The positive half of the case above: a compound answer that names no
     *  denied verb is still used, so the refusal is not "refuse every compound
     *  line". */
    @Test
    void aCompoundAnswerWithoutADeniedVerbIsUsed() {
        RtkFilter filter = new RtkFilter(() -> true,
                new ScriptedOracle("rtk ls -la && rtk git status"));

        JsonNode out = filter.apply("run_command", call("ls -la && git status"));

        assertEquals("rtk ls -la && rtk git status", commandOf(out));
        assertEquals(RtkFilter.REWRITER, out.path(RtkFilter.REWRITER_FIELD).asText());
    }

    // ---- criterion 6: gradlew is refused, and it is the one that hurts -----

    @Test
    void gradlewReachesTheShellUnchangedAlthoughRtkRewritesIt() {
        ScriptedOracle oracle = new ScriptedOracle("rtk gradlew test");
        RtkFilter filter = new RtkFilter(() -> true, oracle);

        JsonNode out = filter.apply("run_command", call("./gradlew test"));

        assertEquals("./gradlew test", commandOf(out));
        assertFalse(out.has(RtkFilter.REWRITER_FIELD));
    }

    /** The two lines the review named, as scripted answers: rtk's own output
     *  for {@code cd sub && ./gradlew test} on 0.45.0, and a line where the
     *  swallowing {@code err} form sits second. */
    @Test
    void gradlewAfterACdAndErrAfterAnLsAreRefused() {
        for (String answer : List.of("cd sub && rtk gradlew test",
                "rtk ls && rtk err sh -c 'exit 3'")) {
            JsonNode out = new RtkFilter(() -> true, new ScriptedOracle(answer))
                    .apply("run_command", call("raw"));
            assertEquals("raw", commandOf(out), "rtk answered [" + answer + "]");
        }
    }

    /** The same fact against the real binary: rtk 0.45.0 rewrites
     *  {@code cd sub && ./gradlew test} to {@code cd sub && rtk gradlew test}
     *  (measured 2026-09-24), and that must not run. */
    @Test
    void theRealBinarysGradlewAfterACdIsRefused() {
        RtkFilter.Oracle real = RtkFilter.binaryOracle();
        assumeTrue(real.version() != null, "rtk does not resolve on PATH");

        JsonNode out = new RtkFilter(() -> true, real)
                .apply("run_command", call("cd sub && ./gradlew test"));

        assertEquals("cd sub && ./gradlew test", commandOf(out));
        assertFalse(out.has(RtkFilter.REWRITER_FIELD));
    }

    // ---- criterion 8: a missing binary never fails a tool call -------------

    @Test
    void aMissingBinaryLeavesTheLineAloneAndRaisesNothing() {
        RtkFilter.Oracle absent = new RtkFilter.Oracle() {
            public String rewrite(String line) {
                return null;
            }

            public String version() {
                return null;
            }
        };
        RtkFilter filter = new RtkFilter(() -> true, absent);

        JsonNode out = filter.apply("run_command", call("ls -la"));

        assertEquals("ls -la", commandOf(out));
        assertFalse(out.has(RtkFilter.REWRITER_FIELD));
    }

    @Test
    void anOracleThatThrowsStillLeavesARunnableLine() {
        RtkFilter.Oracle broken = new RtkFilter.Oracle() {
            public String rewrite(String line) {
                throw new IllegalStateException("rtk fell over");
            }

            public String version() {
                return "rtk 0.0.0-broken";
            }
        };
        JsonNode out = new RtkFilter(() -> true, broken).apply("run_command", call("ls -la"));

        assertEquals("ls -la", commandOf(out));
    }

    // ---- criterion 8, the Finder case: rtk is looked up where the shell looks

    /** The PATH launchd hands a GUI app, read off the owner's running app on
     *  2026-08-17 and recorded in {@link ToolPath}. The server JVM of the
     *  desktop app carries exactly this, so {@code /opt/homebrew/bin} is not
     *  on it. */
    private static final String FINDER_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

    /** Fix round 2026-09-24. The oracle used to search the JVM's raw PATH while
     *  {@link ShellCommand} runs every line on {@link ToolPath}'s PATH. In the
     *  Finder-launched app those two differ, so a homebrew rtk was reported as
     *  missing to the operator while the agent's own shell could run it. The
     *  oracle has to search where the shell searches. */
    @Test
    void aFinderLaunchedAppFindsRtkWhereTheAgentsShellFindsIt() {
        Path homebrewRtk = Path.of("/opt/homebrew/bin/rtk");
        assumeTrue(Files.isExecutable(homebrewRtk), "rtk is not installed under /opt/homebrew/bin");

        RtkFilter.Oracle finder = RtkFilter.binaryOracleInheriting(() -> FINDER_PATH);

        assertNotNull(finder.version(),
                "the tool shell of a Finder-launched app searches "
                        + ToolPath.resolve(FINDER_PATH, Path.of(System.getProperty("user.home", "")),
                                Files::isDirectory).path()
                        + " and finds " + homebrewRtk + " there, so the switch must not call rtk missing");
        assertEquals("rtk git status", finder.rewrite("git status"));
    }

    /** The lookup itself, on a directory this test owns: an executable named
     *  rtk is found there, and an empty directory or an empty PATH finds
     *  nothing, which is the "rtk missing" answer the switch renders. */
    @Test
    void rtkIsSoughtOnTheSearchPathItIsGivenAndNowhereElse(@TempDir Path dir) throws Exception {
        Path fake = dir.resolve("rtk");
        Files.writeString(fake, "#!/bin/sh\necho 'rtk 9.9.9-fake'\n");
        Files.setPosixFilePermissions(fake, PosixFilePermissions.fromString("rwxr-xr-x"));

        assertEquals(fake, RtkFilter.resolveIn(dir.toString()));
        assertNull(RtkFilter.resolveIn(dir.resolve("empty").toString()));
        assertNull(RtkFilter.resolveIn(""));
    }

    // ---- criterion 8, the hung process: the deadline really holds ----------

    private static Path fakeRtk(Path dir, String body) throws Exception {
        Path fake = dir.resolve("rtk");
        Files.writeString(fake, "#!/bin/sh\n" + body + "\n");
        Files.setPosixFilePermissions(fake, PosixFilePermissions.fromString("rwxr-xr-x"));
        return fake;
    }

    private static boolean deadWithin(long pid, Duration grace) throws InterruptedException {
        long until = System.nanoTime() + grace.toNanos();
        while (System.nanoTime() < until) {
            if (ProcessHandle.of(pid).map(h -> !h.isAlive()).orElse(true)) {
                return true;
            }
            Thread.sleep(50);
        }
        return false;
    }

    /** Review round 2026-09-24. The oracle read stdout to the end BEFORE it
     *  started the clock, so a process that keeps its stdout open (here a
     *  child it forked) was waited on for as long as it lived. /api/config asks
     *  for the version on every page boot, so that hang reached the endpoint the
     *  UI boots from, and run_command with it. The deadline has to hold, and
     *  the process and what it forked have to be gone afterwards. */
    @Test
    void anRtkThatHangsWithItsOutputOpenIsGivenUpOnAtTheDeadline(@TempDir Path dir)
            throws Exception {
        Path fake = fakeRtk(dir, "echo $$ > \"" + dir.resolve("sh.pid") + "\"\n"
                + "sleep 30 &\n"
                + "echo $! > \"" + dir.resolve("child.pid") + "\"\n"
                + "wait");
        RtkFilter.Oracle oracle = RtkFilter.binaryOracleAt(fake, 500);

        String answer = assertTimeoutPreemptively(Duration.ofSeconds(4),
                () -> oracle.rewrite("ls -la"),
                "a 500 ms deadline must hold although the process never closes its stdout");

        assertNull(answer, "no answer in time means the raw line runs");
        long sh = Long.parseLong(Files.readString(dir.resolve("sh.pid")).strip());
        long child = Long.parseLong(Files.readString(dir.resolve("child.pid")).strip());
        assertTrue(deadWithin(sh, Duration.ofSeconds(2)), "the hung rtk is killed at the deadline");
        assertTrue(deadWithin(child, Duration.ofSeconds(2)), "and so is what it forked");
    }

    /** Review round 2026-09-24, the other half: stdin was an open pipe nobody
     *  wrote to or closed, so an rtk that asks a question (a consent prompt, for
     *  example) waited for an answer that never came. stdin is now the null
     *  device, so a read sees end of input at once and rtk carries on. */
    @Test
    void anRtkThatReadsItsInputSeesEndOfInputAndAnswers(@TempDir Path dir) throws Exception {
        Path fake = fakeRtk(dir, "read reply\necho 'rtk ls -la'");
        RtkFilter.Oracle oracle = RtkFilter.binaryOracleAt(fake, 2_000);

        String answer = assertTimeoutPreemptively(Duration.ofSeconds(6),
                () -> oracle.rewrite("ls -la"),
                "an oracle call must never wait on its own stdin");

        assertEquals("rtk ls -la", answer);
    }

    // ---- criterion 9: telemetry consent is not ours to answer --------------

    @Test
    void aRewrittenLineRunsWithTelemetryDisabledInItsEnvironment(@TempDir Path cwd) {
        ObjectNode marked = JSON.createObjectNode();
        marked.put(RtkFilter.COMMAND_FIELD, "printenv " + RtkFilter.TELEMETRY_ENV);
        marked.put(RtkFilter.ORIGINAL_FIELD, "printenv " + RtkFilter.TELEMETRY_ENV);
        marked.put(RtkFilter.REWRITER_FIELD, RtkFilter.REWRITER);

        assertEquals("1", RtkFilter.shellEnvFor(marked).get(RtkFilter.TELEMETRY_ENV));

        ShellCommand.Result result = ShellCommand.run(commandOf(marked),
                RtkFilter.shellEnvFor(marked), cwd, 20, new CancelSignal(), 10_000);
        assertEquals("1", result.output().strip(),
                "the variable has to reach the child, not just the map");

        // The other half of the pair: an untouched line must NOT carry it, or
        // this assertion would be green on a variable set for every command.
        assertFalse(RtkFilter.shellEnvFor(call("ls")).containsKey(RtkFilter.TELEMETRY_ENV));
    }

    @Test
    void theOracleItselfAsksRtkWithTelemetryDisabled() {
        assertEquals("1", RtkFilter.oracleEnvironment().get(RtkFilter.TELEMETRY_ENV));
    }

    // ---- criterion 5: the answer is read off stdout, never off the code ----

    /** rtk 0.45.0 returns exit 3 for every rewrite measured on 2026-09-21, and
     *  its own help text prints {@code REWRITTEN=$(rtk rewrite "$CMD") || exit 0},
     *  which throws that answer away. This case drives the real binary, so the
     *  claim is about rtk and not about a stub that agrees with me. */
    @Test
    void theRealBinarysRewriteIsUsedAlthoughItExitsNonZero() {
        RtkFilter.Oracle real = RtkFilter.binaryOracle();
        assumeTrue(real.version() != null, "rtk does not resolve on PATH");

        JsonNode out = new RtkFilter(() -> true, real).apply("run_command", call("git status"));

        assertEquals("rtk git status", commandOf(out),
                "rtk rewrite answers on stdout and exits 3; the answer must survive");
        assertEquals("git status", out.path(RtkFilter.ORIGINAL_FIELD).asText());
    }

    @Test
    void theRealBinaryHavingNoAnswerLeavesTheLineAlone() {
        RtkFilter.Oracle real = RtkFilter.binaryOracle();
        assumeTrue(real.version() != null, "rtk does not resolve on PATH");

        JsonNode out = new RtkFilter(() -> true, real).apply("run_command", call("echo hi"));

        assertEquals("echo hi", commandOf(out));
        assertFalse(out.has(RtkFilter.REWRITER_FIELD));
    }

    /** The exit code rtk rewrite really returns for a line it rewrites, read
     *  here rather than remembered. It is the fact the whole seam is built on,
     *  so it is measured by the suite and not by a note in a card. */
    @Test
    void rtkRewriteReturnsANonZeroCodeForALineItRewrites() throws Exception {
        RtkFilter.Oracle real = RtkFilter.binaryOracle();
        assumeTrue(real.version() != null, "rtk does not resolve on PATH");

        Process process = new ProcessBuilder("rtk", "rewrite", "git status")
                .redirectErrorStream(false).start();
        String stdout = new String(process.getInputStream().readAllBytes(),
                java.nio.charset.StandardCharsets.UTF_8).strip();
        int code = process.waitFor();

        assertEquals("rtk git status", stdout);
        assertTrue(code != 0,
                "rtk rewrite promised exit 0 in its help and returned " + code
                        + "; the recipe it prints would discard this answer");
    }

    // ---- criterion 7: the exit code and the reason survive the wrapper -----

    /** The named sample, and it is named rather than claimed to be "every verb":
     *  the two the card measured to keep code and reason, plus the one it
     *  measured to lose both. {@code find} is in {@link RtkFilter#DENIED_VERBS},
     *  so it passes here by being refused. Take it out of that constant and
     *  this case goes red, which is criterion 7's first bite. */
    @Test
    void aWrappedCommandKeepsTheExitCodeAndTheReasonOfTheUnwrappedOne(@TempDir Path cwd)
            throws Exception {
        RtkFilter.Oracle real = RtkFilter.binaryOracle();
        assumeTrue(real.version() != null, "rtk does not resolve on PATH");
        RtkFilter filter = new RtkFilter(() -> true, real);

        Path missing = cwd.resolve("nonexistent-dir-xyz");
        Path a = Files.writeString(cwd.resolve("a.txt"), "alpha\n");
        Path b = Files.writeString(cwd.resolve("b.txt"), "beta\n");
        List<String> lines = List.of(
                "ls " + missing,
                "find " + missing + " -name x",
                "git status",
                // The SILENT failures, added in the fix round of 2026-09-24:
                // each exits 1 and prints nothing, raw and through rtk 0.45.0
                // alike (measured that day). A wrapper that turns silence into
                // exit 0 is the one criterion 7 exists for.
                "grep -q zzz " + a,
                "git diff --quiet --no-index " + a + " " + b,
                // rtk has no rewrite for this one, so it must run untouched. It
                // is the shape rtk err turns into exit 0 and "[ok] Command
                // completed successfully (no errors)" on 0.45.0, which is what
                // a filter that forced lines through a generic form would ship.
                "sh -c 'exit 3'");

        for (String line : lines) {
            ShellCommand.Result raw = ShellCommand.run(line, Map.of(), cwd,
                    30, new CancelSignal(), 10_000);
            JsonNode filtered = filter.apply("run_command", call(line));
            ShellCommand.Result wrapped = ShellCommand.run(commandOf(filtered),
                    RtkFilter.shellEnvFor(filtered), cwd, 30, new CancelSignal(), 10_000);

            assertEquals(raw.exitCode(), wrapped.exitCode(),
                    "exit code of [" + line + "]: rtk ran [" + commandOf(filtered)
                            + "] and printed [" + wrapped.output().strip() + "]");
            if (raw.exitCode() != 0 && !raw.output().isBlank()) {
                assertFalse(wrapped.output().isBlank(),
                        "the reason line of [" + line + "] must survive the wrapper");
            }
        }
    }

    /** Criterion 7's second bite in its permanent form: the two generic forms
     *  that fabricate success are named in the constant the refusal derives
     *  from. Take one out and the derived case above stops refusing it. */
    @Test
    void theFormsThatSwallowAFailureAreNamedInTheDenylist() {
        assertTrue(RtkFilter.DENIED_VERBS.containsAll(List.of("err", "test", "gradlew", "find")),
                "measured 2026-09-21 on rtk 0.45.0 to lose the exit code, the reason, or both");
    }

    // ---- criterion 12, the per-call half: the switch is read every time ----

    @Test
    void theSwitchIsReadPerCallSoAnOpenSessionSeesItOnTheNextToolCall() {
        AtomicBoolean on = new AtomicBoolean(false);
        RtkFilter filter = new RtkFilter(on::get, new ScriptedOracle("rtk ls -la"));

        assertEquals("ls -la", commandOf(filter.apply("run_command", call("ls -la"))));
        on.set(true);
        assertEquals("rtk ls -la", commandOf(filter.apply("run_command", call("ls -la"))));
    }
}
