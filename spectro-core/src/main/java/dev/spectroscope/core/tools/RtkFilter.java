package dev.spectroscope.core.tools;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.config.governing.Governs;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Card 379: the rtk seam. {@code rtk} is a CLI proxy that runs a developer
 * command and prints less of its output, so a noisy line costs a fraction of
 * the context it costs raw.
 *
 * <p><b>Spectro asks rtk. Spectro does not model rtk.</b> The set of lines rtk
 * can filter is rtk's, is 79 subcommands wide on 0.45.0, and changes with every
 * release. {@code rtk rewrite} calls itself the "single source of truth for
 * hooks" in its own help text, so that is the oracle, and the only list this
 * class owns is {@link #DENIED_VERBS}: spectro's own policy, read by the code
 * and by its test from this one constant.</p>
 *
 * <p><b>The exit code is not the answer.</b> Measured against rtk 0.45.0 on
 * 2026-09-21: {@code rtk rewrite "git status"} prints {@code rtk git status}
 * and exits <b>3</b>; six of eight lines tried came back rewritten with exit 3
 * and two with exit 1 and no output. Exit 0 was never seen. The binary's own
 * help text promises exit 0 and prints the recipe
 * {@code REWRITTEN=$(rtk rewrite "$CMD") || exit 0}, which tests the code, sees
 * 3, calls it failure and throws away the line rtk just produced. Anyone
 * following that instruction ships a feature that is wired correctly, tests
 * green and silently never fires. So the decision here is made on stdout:
 * a rewrite counts when the output is one non-empty line that differs from the
 * input, and codes 0, 1 and 3 are all expected.</p>
 *
 * <p><b>Off from the factory.</b> rtk swallows failures. Measured the same day:
 * {@code rtk test sh -c 'exit 7'} returns 0 in silence, {@code rtk err sh -c
 * 'exit 3'} returns 0 and prints {@code [ok] Command completed successfully (no
 * errors)}, a success line the child never wrote, and {@code rtk find} turns a
 * missing directory into exit 0 with no message where native find gives exit 1
 * with a reason. For a product whose promise is that you can watch what
 * happened, a wrapper that invents success is the thing we sell being wrong.</p>
 */
public final class RtkFilter {

    private static final Logger log = LoggerFactory.getLogger(RtkFilter.class);

    /** The only tool this filter touches. Goal checks and operator hooks run as
     *  the operator wrote them (Owner call 5). */
    public static final String TOOL = "run_command";

    /** The shell line, before and after: this field always holds the line that
     *  will actually run, so the permission gate and the shell read the same
     *  string (Owner call 1). */
    public static final String COMMAND_FIELD = "command";

    /** The line the model wrote, added beside {@link #COMMAND_FIELD} when a
     *  rewrite happened. A rewrite the operator cannot see is the one outcome
     *  this product cannot accept. */
    public static final String ORIGINAL_FIELD = "originalCommand";

    /** Who changed the line. Present only on a rewritten call. */
    public static final String REWRITER_FIELD = "rewrittenBy";

    /** The value of {@link #REWRITER_FIELD}: the rewrite is spectro's act, taken
     *  on rtk's advice. */
    public static final String REWRITER = "rtk";

    /** Owner call 7: spectro never answers rtk's telemetry consent prompt for
     *  the operator, and says so to every rtk process it starts. */
    public static final String TELEMETRY_ENV = "RTK_TELEMETRY_DISABLED";

    /**
     * The rtk verbs spectro refuses, whatever {@code rtk rewrite} offers. Each
     * one was measured on 2026-09-21 against rtk 0.45.0 to lose the exit code,
     * the reason, or the answer itself:
     *
     * <ul>
     *   <li>{@code gradlew}: {@code rtk gradlew --version} returns 43 bytes
     *       against 568 raw and drops the {@code Gradle 9.6.1} line the command
     *       exists to print. rtk's own help calls the subcommand an "Android
     *       Gradle wrapper", and {@code rtk rewrite "./gradlew test"} routes
     *       this repo's heaviest command straight into it, so the refusal is
     *       built rather than hoped for.</li>
     *   <li>{@code test}: {@code rtk test sh -c 'exit 7'} returns 0 in
     *       silence.</li>
     *   <li>{@code err}: {@code rtk err sh -c 'exit 3'} returns 0 and prints
     *       {@code [ok] Command completed successfully (no errors)}.</li>
     *   <li>{@code find}: {@code rtk find /nonexistent -name x} returns 0 with
     *       empty stdout and empty stderr; native find returns 1 and says
     *       why.</li>
     * </ul>
     *
     * <p>The card's Owner call 8 phrased the same policy as an allowlist of two
     * verbs, and its criterion 4 requires that a verb spectro has never seen is
     * used without a source change. Those two cannot both hold. This is the
     * denylist reading, because criterion 4 is the one with a bite attached and
     * because an allowlist would be the verb table the card forbids.</p>
     */
    public static final Set<String> DENIED_VERBS = Set.of("gradlew", "test", "err", "find");

    /** How long one oracle call may take before spectro stops waiting and runs
     *  the raw line.
     *
     *  <p>Measured 2026-09-21 on this machine, 30 calls of {@code rtk rewrite}
     *  across six shell lines: median 10.6 ms, p95 14.1 ms, slowest 14.3 ms.
     *  Five seconds is therefore roughly 350 times the slowest observed call,
     *  which is a deadline for a hung process and not a budget anything normal
     *  runs into. It is not tuned to the measurement and does not need to be: a
     *  rewrite is an optimisation, so overshooting the deadline costs the
     *  saving on one call and never the call itself.</p> */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.SECONDS)
    private static final long ORACLE_TIMEOUT_SECONDS = 5;

    /**
     * What spectro asks about a shell line. The real implementation is
     * {@link #binaryOracle()}; tests hand in a scripted one so a claim about
     * spectro's behaviour is not also a claim about rtk's.
     */
    public interface Oracle {

        /**
         * @param line the shell line the model wrote
         * @return the rewritten line, or null when rtk has no equivalent, is not
         *         installed, or did not answer in time
         */
        String rewrite(String line);

        /**
         * @return what {@code rtk --version} printed, or null when rtk does not
         *         resolve on PATH
         */
        String version();
    }

    private final BooleanSupplier enabled;
    private final Oracle oracle;

    /**
     * @param enabled read on EVERY call, never snapshotted: a session that is
     *                already open has to see the switch on its next tool call,
     *                not on its next session
     * @param oracle  what to ask about a line
     */
    public RtkFilter(BooleanSupplier enabled, Oracle oracle) {
        this.enabled = enabled;
        this.oracle = oracle;
    }

    /**
     * The seam. Runs before the permission gate, so the gate is asked about the
     * line that will actually be executed and the event carries both.
     *
     * @param toolName the tool the model called
     * @param input    the model-supplied input
     * @return the same node when nothing changed, or a copy whose
     *         {@link #COMMAND_FIELD} is the rewritten line and which carries the
     *         original beside it
     */
    public JsonNode apply(String toolName, JsonNode input) {
        if (!TOOL.equals(toolName) || input == null || !input.hasNonNull(COMMAND_FIELD)) {
            return input;
        }
        if (!enabled.getAsBoolean()) {
            return input; // off: byte identical, and no rtk process is started
        }
        String original = input.path(COMMAND_FIELD).asText();
        String rewritten;
        try {
            rewritten = oracle.rewrite(original);
        } catch (RuntimeException failure) {
            log.debug("rtk oracle failed for [{}], running the raw line", original, failure);
            return input;
        }
        if (!usable(original, rewritten)) {
            return input;
        }
        ObjectNode out = input.deepCopy();
        out.put(COMMAND_FIELD, rewritten);
        out.put(ORIGINAL_FIELD, original);
        out.put(REWRITER_FIELD, REWRITER);
        return out;
    }

    /**
     * Whether rtk's answer may be used. Deliberately says nothing about the exit
     * code: see the class comment for why the code is the wrong oracle.
     *
     * @param original   the line the model wrote
     * @param rewritten  what rtk answered, possibly null
     * @return true when the answer is a single line, differs from the input, and
     *         names no verb {@link #DENIED_VERBS} refuses anywhere in it
     */
    private static boolean usable(String original, String rewritten) {
        if (rewritten == null) {
            return false;
        }
        String answer = rewritten.strip();
        if (answer.isEmpty() || answer.equals(original.strip()) || answer.contains("\n")) {
            return false;
        }
        for (String verb : rtkVerbs(answer)) {
            if (DENIED_VERBS.contains(verb)) {
                return false;
            }
        }
        return true;
    }

    /** One rtk invocation inside a shell line: the word {@code rtk}, at the
     *  start, after whitespace, after a shell operator or after a path slash,
     *  followed by its subcommand. */
    private static final Pattern RTK_INVOCATION =
            Pattern.compile("(?:^|[\\s;&|(){}`/])rtk\\s+([^\\s;&|(){}`]+)");

    /**
     * Every rtk subcommand an answer names, read off the answer rather than off
     * a table of our own. rtk rewrites each segment of a compound line: on
     * 0.45.0 {@code cd sub && ./gradlew test} comes back as
     * {@code cd sub && rtk gradlew test} (measured 2026-09-24), so the verb
     * that matters is often not the first word. A match inside a quoted string
     * counts too; refusing there only costs the saving on that one call.
     *
     * @param answer one rewritten line
     * @return the subcommands in the order they appear, empty when the line
     *         invokes no rtk
     */
    static List<String> rtkVerbs(String answer) {
        List<String> verbs = new ArrayList<>();
        Matcher m = RTK_INVOCATION.matcher(answer);
        while (m.find()) {
            verbs.add(m.group(1));
        }
        return verbs;
    }

    /**
     * The environment a rewritten line runs in.
     *
     * @param input the tool input, after {@link #apply}
     * @return the telemetry refusal when this call was rewritten, empty otherwise
     *         (an untouched line must not carry a variable that says rtk was
     *         involved)
     */
    public static Map<String, String> shellEnvFor(JsonNode input) {
        boolean rewritten = input != null
                && REWRITER.equals(input.path(REWRITER_FIELD).asText(null));
        return rewritten ? Map.of(TELEMETRY_ENV, "1") : Map.of();
    }

    /**
     * @return the environment every rtk process spectro starts inherits on top of
     *         its own
     */
    public static Map<String, String> oracleEnvironment() {
        return Map.of(TELEMETRY_ENV, "1");
    }

    /** @return an oracle backed by the rtk binary on PATH */
    public static Oracle binaryOracle() {
        return binaryOracleInheriting(() -> System.getenv("PATH"));
    }

    /**
     * The real oracle over an inherited PATH the caller names. The seam for the
     * Finder case: a test cannot scrub the JVM's own environment.
     *
     * @param inheritedPath the PATH as this process inherited it
     * @return an oracle backed by the rtk binary that search finds
     */
    static Oracle binaryOracleInheriting(Supplier<String> inheritedPath) {
        return new BinaryOracle(() -> resolveOnToolPath(inheritedPath.get()),
                TimeUnit.SECONDS.toMillis(ORACLE_TIMEOUT_SECONDS));
    }

    /**
     * The real oracle over one named binary and a deadline the caller picks.
     * The seam for the hung-process cases: a test cannot wait five seconds per
     * case, and cannot put a fake rtk ahead of the toolchain directories.
     *
     * @param binary         the executable to run as rtk
     * @param deadlineMillis how long one call may take
     * @return an oracle backed by that executable
     */
    static Oracle binaryOracleAt(Path binary, long deadlineMillis) {
        return new BinaryOracle(() -> binary, deadlineMillis);
    }

    /**
     * Looks where the agent's shell looks. {@link ShellCommand} runs every
     * line on {@link ToolPath}'s PATH, which prepends the toolchain
     * directories a Finder-launched app does not inherit. Searching the raw
     * PATH instead told the operator rtk was missing while the shell could
     * run it (fix round 2026-09-24).
     *
     * @param inheritedPath the PATH as this process inherited it
     * @return the first executable named {@code rtk} on the tool shell's
     *         PATH, or null
     */
    private static Path resolveOnToolPath(String inheritedPath) {
        return resolveIn(ToolPath.resolve(inheritedPath,
                Path.of(System.getProperty("user.home", "")), Files::isDirectory).path());
    }

    /**
     * @param searchPath a PATH string
     * @return the first executable named {@code rtk} on it, or null
     */
    static Path resolveIn(String searchPath) {
        if (searchPath == null || searchPath.isEmpty()) {
            return null;
        }
        for (String entry : searchPath.split(java.io.File.pathSeparator)) {
            if (entry.isEmpty()) {
                continue;
            }
            try {
                Path candidate = Path.of(entry).resolve("rtk");
                if (Files.isRegularFile(candidate) && Files.isExecutable(candidate)) {
                    return candidate;
                }
            } catch (RuntimeException ignored) {
                // an unparsable PATH entry is not this feature's problem
            }
        }
        return null;
    }

    /**
     * What the operator's window prints beside the switch. Criterion 11: the
     * version is what the binary SAID, never a literal, because a literal is
     * right on the day it is typed and wrong on the day rtk updates.
     *
     * @return the version string rtk printed, or null when it does not resolve
     *         on PATH, in which case the row renders disabled and says so
     */
    public static String installedVersion() {
        return binaryOracle().version();
    }

    /** The real rtk. Resolves once per call rather than caching, so installing
     *  rtk while the server runs does not need a restart. */
    private static final class BinaryOracle implements Oracle {

        private static final java.io.File NULL_DEVICE = new java.io.File(
                System.getProperty("os.name", "").startsWith("Windows") ? "NUL" : "/dev/null");

        private final Supplier<Path> binary;
        private final long deadlineMillis;

        BinaryOracle(Supplier<Path> binary, long deadlineMillis) {
            this.binary = binary;
            this.deadlineMillis = deadlineMillis;
        }

        public String rewrite(String line) {
            Path binary = this.binary.get();
            if (binary == null) {
                return null;
            }
            // The trap this card exists for: rtk rewrite's help promises exit 0
            // and prints REWRITTEN=$(rtk rewrite "$CMD") || exit 0. Measured
            // 2026-09-21 on 0.45.0 it exits 3 on every hit, so that recipe
            // discards every answer it gets. The exit code is ignored here on
            // purpose; stdout decides.
            return run(binary, List.of(binary.toString(), "rewrite", line), deadlineMillis);
        }

        public String version() {
            Path binary = this.binary.get();
            return binary == null ? null
                    : run(binary, List.of(binary.toString(), "--version"), deadlineMillis);
        }

        /**
         * One rtk call, bounded by the deadline from start to finish. stdout is
         * read on its own thread so that a process which keeps it open cannot
         * hold the caller past the deadline; stdin is the null device so that
         * a question rtk asks sees end of input instead of waiting; stderr is
         * discarded so a full pipe cannot stall the child. On expiry the
         * process and everything it forked are killed (review round
         * 2026-09-24: all three used to be able to hang run_command and
         * /api/config).
         *
         * @param binary         the resolved rtk, only used for the error line
         * @param command        the full argv
         * @param deadlineMillis how long the whole call may take
         * @return stripped stdout, or null when the process did not start, did
         *         not finish in time, or printed nothing
         */
        private static String run(Path binary, List<String> command, long deadlineMillis) {
            Process process = null;
            try {
                ProcessBuilder builder = new ProcessBuilder(command)
                        .redirectInput(ProcessBuilder.Redirect.from(NULL_DEVICE))
                        .redirectError(ProcessBuilder.Redirect.DISCARD);
                builder.environment().putAll(oracleEnvironment());
                long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(deadlineMillis);
                process = builder.start();
                InputStream out = process.getInputStream();
                FutureTask<byte[]> stdout = new FutureTask<>(() -> drain(out));
                Thread reader = new Thread(stdout, "rtk-oracle-stdout");
                reader.setDaemon(true);
                reader.start();
                if (!process.waitFor(deadlineMillis, TimeUnit.MILLISECONDS)) {
                    return null;
                }
                byte[] bytes = stdout.get(Math.max(0, deadline - System.nanoTime()),
                        TimeUnit.NANOSECONDS);
                String text = new String(bytes, StandardCharsets.UTF_8).strip();
                return text.isEmpty() ? null : text;
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                return null;
            } catch (TimeoutException late) {
                log.debug("rtk at {} kept its output open past the deadline", binary);
                return null;
            } catch (Exception failure) {
                log.debug("rtk at {} did not answer", binary, failure);
                return null;
            } finally {
                if (process != null && process.isAlive()) {
                    process.descendants().forEach(ProcessHandle::destroyForcibly);
                    process.destroyForcibly();
                }
            }
        }

        /**
         * @param in the child's stdout
         * @return everything it wrote, bounded by rtk answering with one line
         */
        private static byte[] drain(InputStream in) throws java.io.IOException {
            try (in) {
                ByteArrayOutputStream buffer = new ByteArrayOutputStream();
                byte[] chunk = new byte[4096];
                int n;
                while ((n = in.read(chunk)) != -1 && buffer.size() < 64 * 1024) {
                    buffer.write(chunk, 0, n);
                }
                return buffer.toByteArray();
            }
        }
    }
}
