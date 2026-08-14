package dev.spectroscope.core.scheduler;

import com.fasterxml.jackson.core.JsonFactory;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.mcp.McpServerConfig;
import dev.spectroscope.core.mcp.McpServerRegistry;
import dev.spectroscope.core.mcp.MuteMcpServerFixture;
import dev.spectroscope.core.mcp.StdioTransport;
import dev.spectroscope.core.provider.LlmProvider;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.File;
import java.net.URISyntaxException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Optional;
import java.util.Queue;
import java.util.Set;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Card 220, honesty item 7, on the path card 221 never walked: the HEADLESS
 * face. Card 221 proved the teardown against doctor, the REPL and the web
 * session — the three faces that mounted. Now that a headless run can mount
 * too, the same real-process proof runs through {@link HeadlessRunner}: a
 * server that spawns and never speaks fails the run's load within the bound,
 * the run itself still answers on the standard belt, a cron fire returns and
 * records its state, and nothing is left running.
 *
 * <p>Every test carries {@code @Timeout} on
 * {@link Timeout.ThreadMode#SEPARATE_THREAD}, for card 221's own reason: the
 * hang this guards against parks on a lock, not on anything interruptible, and
 * under the default interrupt-driven mode a hung test becomes an infinite one
 * (the lesson of 2026-08-13, written into the house rules).
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class HeadlessMcpMuteServerRealProcessTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** Short stand-in for the shipped 20 s read bound, so the suite stays quick. */
    private static final Duration BOUND = Duration.ofSeconds(2);

    /** The load's whole budget in the shape the shipped one has — read bound
     *  plus teardown tail — with headroom for the fixture JVM's own start and
     *  the scripted run around it. A hang blows the class-level timeout either
     *  way; this pins the load to the BOUND, not to luck. */
    private static final long RUN_BUDGET_MS =
            BOUND.plus(StdioTransport.TEARDOWN_TAIL).toMillis() + 8_000;

    private static SpectroConfig config(List<McpServerConfig> servers) {
        return new SpectroConfig(
                "anthropic", "claude-opus-4-8", "http://localhost:11434", 100_000, "ask",
                List.of(), "gemini", true, servers, 2, true,
                List.of(), null, "info", null, null, "auto", "auto", null, null, null, null, null,
                null, false, true); // headlessMcp ON — the mount under test
    }

    private static final class ScriptedProvider implements LlmProvider {
        final Queue<List<ProviderEvent>> turns = new ArrayDeque<>();

        @Override
        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            List<ProviderEvent> turn = turns.poll();
            if (turn == null) {
                throw new IllegalStateException("no scripted turn left");
            }
            return turn;
        }

        static ScriptedProvider oneAnswer(String text) {
            ScriptedProvider provider = new ScriptedProvider();
            provider.turns.add(List.of(
                    new LlmProvider.PTextDelta(text),
                    new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN)));
            return provider;
        }
    }

    /** The card-221-shaped loader: the same registry funnel, the read bound
     *  shortened so the suite does not wait twenty real seconds. */
    private static HeadlessRunner.McpLoader shortBoundLoader(Path cwd) {
        return (servers, dir) -> McpServerRegistry.load(
                servers, dir, config -> new StdioTransport(config, cwd, BOUND));
    }

    @Test
    void aMuteServerFailsTheLoadWithinTheBoundAndTheRunStillAnswers(@TempDir Path cwd)
            throws Exception {
        Path pidFile = cwd.resolve("mute.pid");
        List<String> command = fixtureCommand(pidFile, "mute");
        assumeTrue(command != null, "cannot locate the fixture classpath; skipping");
        McpServerConfig mute = new McpServerConfig(
                "mute", command.getFirst(), command.subList(1, command.size()), null, null, null);
        List<String> log = new ArrayList<>();

        long startedAt = System.nanoTime();
        HeadlessRunner.Outcome outcome =
                new HeadlessRunner(JSON, config(List.of(mute)), ScriptedProvider.oneAnswer("ok"))
                        .withMcpLoader(shortBoundLoader(cwd))
                        .runOnce("say ok", cwd, false, null, null, log::add);
        long elapsedMs = (System.nanoTime() - startedAt) / 1_000_000;

        assertTrue(elapsedMs < RUN_BUDGET_MS,
                "the run must come back inside the bound card 221 established; it took "
                        + elapsedMs + " ms against a budget of " + RUN_BUDGET_MS);
        assertTrue(outcome.exitOk(),
                "an unreachable server never fails the run into a different posture — the"
                        + " run continues on the standard belt (stop=" + outcome.stopReason() + ")");
        assertTrue(log.stream().anyMatch(line -> line.startsWith("mcp: mute UNREACHABLE")
                        && line.contains("initialize")),
                "the skip is visible on the run's own output and names the exchange that"
                        + " went unanswered, got: " + log);

        // Nothing left running — the security criterion the card carries.
        long pid = pidOf(pidFile);
        Optional<ProcessHandle> child = ProcessHandle.of(pid);
        assertFalse(child.isPresent() && child.get().isAlive(),
                "the mute server (pid " + pid + ") outlived the headless run");
    }

    @Test
    void aCronFireBehindAMuteServerReturnsAndRecordsItsState(@TempDir Path cwd) throws Exception {
        // The sharpest version of the card's question: a fire is unattended by
        // definition, and before card 221 this exact shape was a process that
        // never returned and never said why.
        Path pidFile = cwd.resolve("cron-mute.pid");
        List<String> command = fixtureCommand(pidFile, "mute");
        assumeTrue(command != null, "cannot locate the fixture classpath; skipping");
        McpServerConfig mute = new McpServerConfig(
                "mute", command.getFirst(), command.subList(1, command.size()), null, null, null);

        Job job = new Job("nightly", "0 0 * * *", "say ok", cwd.toString(), "readonly");
        long startedAt = System.nanoTime();
        JobState state = new HeadlessRunner(JSON, config(List.of(mute)),
                ScriptedProvider.oneAnswer("done"))
                .withMcpLoader(shortBoundLoader(cwd))
                .runJob(job, line -> { });
        long elapsedMs = (System.nanoTime() - startedAt) / 1_000_000;

        assertTrue(elapsedMs < RUN_BUDGET_MS,
                "the fire must return; it took " + elapsedMs + " ms");
        assertEquals(JobState.OK, state.status(),
                "the fire completes on the standard belt and writes its state — a mute"
                        + " server costs the bound, never the job");

        long pid = pidOf(pidFile);
        Optional<ProcessHandle> child = ProcessHandle.of(pid);
        assertFalse(child.isPresent() && child.get().isAlive(),
                "the mute server (pid " + pid + ") outlived the cron fire");
    }

    @Test
    void theDefaultLoaderIsTheProductionFunnelThatCarriesTheFix(@TempDir Path cwd)
            throws Exception {
        // The probes above shorten the bound through the seam; this pins the
        // runner's DEFAULT loader to the same McpServerRegistry.load →
        // McpTransports.defaultFactory funnel every interactive face uses — the
        // one card 221's teardown test guards. The gibberish fixture answers one
        // non-JSON line, so the handshake fails in milliseconds with no timeout:
        // the default 20 s bound is never waited on and the test stays fast.
        Path pidFile = cwd.resolve("gibberish.pid");
        List<String> command = fixtureCommand(pidFile, "gibberish");
        assumeTrue(command != null, "cannot locate the fixture classpath; skipping");
        McpServerConfig babbler = new McpServerConfig(
                "babbler", command.getFirst(), command.subList(1, command.size()), null, null, null);
        List<String> log = new ArrayList<>();

        HeadlessRunner.Outcome outcome =
                new HeadlessRunner(JSON, config(List.of(babbler)), ScriptedProvider.oneAnswer("ok"))
                        .runOnce("say ok", cwd, false, null, null, log::add);

        assertTrue(outcome.exitOk(), "the run continues without the babbling server");
        assertTrue(log.stream().anyMatch(line -> line.startsWith("mcp: babbler UNREACHABLE")),
                "the production funnel skips it loudly, got: " + log);

        long pid = pidOf(pidFile);
        Optional<ProcessHandle> child = ProcessHandle.of(pid);
        assertFalse(child.isPresent() && child.get().isAlive(),
                "the spawned server (pid " + pid + ") outlived a failed handshake on the"
                        + " headless path — the skip path must close what start() opened");
    }

    // ---- the harness (mirrors McpMuteServerRealProcessTest) ------------------------

    /** The pid the fixture wrote before it went quiet. */
    private static long pidOf(Path pidFile) throws Exception {
        long deadline = System.nanoTime() + Duration.ofSeconds(10).toNanos();
        while (System.nanoTime() < deadline) {
            if (Files.exists(pidFile)) {
                String text = Files.readString(pidFile, StandardCharsets.UTF_8).trim();
                if (!text.isEmpty()) {
                    return Long.parseLong(text);
                }
            }
            Thread.sleep(25);
        }
        throw new AssertionError("the fixture never announced its pid at " + pidFile);
    }

    /** The command that launches the fixture in its own JVM — this JDK's java,
     *  a classpath from the code sources in use, the fixture's main class. */
    private static List<String> fixtureCommand(Path pidFile, String mode) throws URISyntaxException {
        Set<String> classpath = new LinkedHashSet<>();
        for (Class<?> anchor : List.of(MuteMcpServerFixture.class, ObjectMapper.class,
                JsonFactory.class, JsonInclude.class)) {
            var source = anchor.getProtectionDomain().getCodeSource();
            if (source == null || source.getLocation() == null) {
                return null;
            }
            classpath.add(Path.of(source.getLocation().toURI()).toString());
        }
        String java = System.getProperty("java.home") + File.separator + "bin" + File.separator + "java";
        if (!Files.isExecutable(Path.of(java))) {
            return null;
        }
        assertNotNull(pidFile, "the fixture needs somewhere to announce its pid");
        return List.of(java, "-Duser.home=" + System.getProperty("user.home"), "-cp", String.join(File.pathSeparator, classpath),
                MuteMcpServerFixture.class.getName(), pidFile.toString(), mode);
    }
}
