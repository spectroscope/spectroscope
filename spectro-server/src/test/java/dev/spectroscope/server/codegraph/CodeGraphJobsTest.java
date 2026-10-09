package dev.spectroscope.server.codegraph;

import dev.spectroscope.core.scheduler.JobState;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.PipedInputStream;
import java.io.PipedOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 472: a code graph build is a background job with three states. It is
 * {@code running} from the moment it starts, {@code ok} when every step exits
 * 0, and {@code failed} at the first step that does not, keeping the last
 * twenty lines of output for the failure sheet. Proven through the launcher
 * seam: no test starts graphify.
 */
@Timeout(value = 20, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class CodeGraphJobsTest {

    private static final Clock CLOCK = Clock.fixed(Instant.parse("2026-10-09T10:00:00Z"), ZoneOffset.UTC);

    /** A process whose output and exit the test controls. */
    static final class FakeProcess extends Process {
        private final PipedOutputStream feed = new PipedOutputStream();
        private final PipedInputStream out;
        private final CountDownLatch done = new CountDownLatch(1);
        private volatile int exit = -1;
        volatile boolean destroyed;

        FakeProcess() {
            try {
                out = new PipedInputStream(feed, 1 << 16);
            } catch (IOException impossible) {
                throw new IllegalStateException(impossible);
            }
        }

        void say(String line) throws IOException {
            feed.write((line + "\n").getBytes(StandardCharsets.UTF_8));
            feed.flush();
        }

        void exit(int code) throws IOException {
            exit = code;
            feed.close();
            done.countDown();
        }

        @Override public OutputStream getOutputStream() { return new ByteArrayOutputStream(); }
        @Override public InputStream getInputStream() { return out; }
        @Override public InputStream getErrorStream() { return InputStream.nullInputStream(); }
        @Override public int waitFor() throws InterruptedException { done.await(); return exit; }
        @Override public boolean waitFor(long timeout, TimeUnit unit) throws InterruptedException {
            return done.await(timeout, unit);
        }
        @Override public int exitValue() {
            if (done.getCount() > 0) {
                throw new IllegalThreadStateException("running");
            }
            return exit;
        }
        @Override public void destroy() { destroyForcibly(); }
        @Override public Process destroyForcibly() {
            destroyed = true;
            try {
                exit(137);
            } catch (IOException ignored) {
                // the pipe is already closed
            }
            return this;
        }
        @Override public boolean isAlive() { return done.getCount() > 0; }
    }

    /** Hands out prepared processes in order and records what was asked for. */
    static final class Script implements CodeGraphJobs.Launcher {
        final List<FakeProcess> processes = new ArrayList<>();
        final List<List<String>> argvs = new CopyOnWriteArrayList<>();
        final List<Path> folders = new CopyOnWriteArrayList<>();
        final List<Map<String, String>> envs = new CopyOnWriteArrayList<>();

        FakeProcess next() {
            FakeProcess p = new FakeProcess();
            processes.add(p);
            return p;
        }

        @Override
        public synchronized Process start(List<String> argv, Path folder, Map<String, String> env) {
            argvs.add(argv);
            folders.add(folder);
            envs.add(env);
            return processes.get(argvs.size() - 1);
        }
    }

    private static void await(BooleanSupplier condition) throws InterruptedException {
        long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (!condition.getAsBoolean()) {
            if (System.nanoTime() > until) {
                throw new AssertionError("condition not reached");
            }
            Thread.sleep(5);
        }
    }

    private static final List<List<String>> TWO_STEPS = List.of(
            List.of("graphify", "extract", "/p", "--code-only"),
            List.of("graphify", "cluster-only", "/p", "--no-label"));

    @Test
    void aStartedJobIsRunningWithItsStartTimeAndLastLine(@TempDir Path dir) throws Exception {
        Script script = new Script();
        FakeProcess first = script.next();
        script.next();
        CodeGraphJobs jobs = new CodeGraphJobs(script, CLOCK, Duration.ofMinutes(5));

        CodeGraphJobs.Snapshot started = jobs.start(dir, "s-1", "full", TWO_STEPS, Map.of());

        assertNotNull(started);
        assertEquals(CodeGraphJobs.RUNNING, started.state());
        assertEquals("2026-10-09T10:00:00Z", started.startedAt());
        assertNull(started.endedAt());
        first.say("[graphify extract] scanning");
        first.say("[graphify extract] AST extraction on 2 code files...");
        await(() -> "[graphify extract] AST extraction on 2 code files...".equals(jobs.get(dir).lastLine()));
        assertEquals(CodeGraphJobs.RUNNING, jobs.get(dir).state());
        first.exit(0);
        script.processes.get(1).exit(0);
    }

    @Test
    void everyStepExitingZeroEndsOkAndRunsTheStepsInOrderInTheFolder(@TempDir Path dir) throws Exception {
        Script script = new Script();
        FakeProcess first = script.next();
        FakeProcess second = script.next();
        CodeGraphJobs jobs = new CodeGraphJobs(script, CLOCK, Duration.ofMinutes(5));

        jobs.start(dir, "s-1", "full", TWO_STEPS, Map.of("OLLAMA_BASE_URL", "http://localhost:11434/v1"));
        first.say("wrote graph.json");
        first.exit(0);
        await(() -> script.argvs.size() == 2);
        second.say("Done - 2 communities.");
        second.exit(0);
        await(() -> !CodeGraphJobs.RUNNING.equals(jobs.get(dir).state()));

        CodeGraphJobs.Snapshot done = jobs.get(dir);
        assertEquals(CodeGraphJobs.OK, done.state());
        assertEquals(0, done.exitCode());
        assertEquals("2026-10-09T10:00:00Z", done.endedAt());
        assertEquals("Done - 2 communities.", done.lastLine());
        assertEquals(TWO_STEPS, script.argvs);
        assertEquals(List.of(dir, dir), script.folders);
        assertEquals(Map.of("OLLAMA_BASE_URL", "http://localhost:11434/v1"), script.envs.get(1));
    }

    @Test
    void aStepThatFailsEndsFailedRunsNoFurtherStepAndKeepsTheLastTwentyLines(@TempDir Path dir)
            throws Exception {
        Script script = new Script();
        FakeProcess first = script.next();
        script.next();
        CodeGraphJobs jobs = new CodeGraphJobs(script, CLOCK, Duration.ofMinutes(5));

        jobs.start(dir, "s-1", "full", TWO_STEPS, Map.of());
        for (int i = 1; i <= 25; i++) {
            first.say("line " + i);
        }
        first.exit(2);
        await(() -> CodeGraphJobs.FAILED.equals(jobs.get(dir).state()));

        CodeGraphJobs.Snapshot failed = jobs.get(dir);
        assertEquals(2, failed.exitCode());
        assertEquals(CodeGraphJobs.TAIL, failed.tail().size());
        assertEquals("line 6", failed.tail().get(0));
        assertEquals("line 25", failed.tail().get(19));
        assertEquals(1, script.argvs.size(), "the step after a failure must not start");
    }

    @Test
    void aSecondStartForTheSameFolderWhileOneRunsIsRefused(@TempDir Path dir) throws Exception {
        Script script = new Script();
        FakeProcess first = script.next();
        CodeGraphJobs jobs = new CodeGraphJobs(script, CLOCK, Duration.ofMinutes(5));

        assertNotNull(jobs.start(dir, "s-1", "update", List.of(TWO_STEPS.get(0)), Map.of()));
        assertNull(jobs.start(dir, "s-2", "update", List.of(TWO_STEPS.get(0)), Map.of()));
        first.exit(0);
        await(() -> CodeGraphJobs.OK.equals(jobs.get(dir).state()));
        assertEquals(1, script.argvs.size());
    }

    @Test
    void aJobThatRunsPastItsLimitIsStoppedAndFailed(@TempDir Path dir) throws Exception {
        Script script = new Script();
        FakeProcess hanging = script.next();
        CodeGraphJobs jobs = new CodeGraphJobs(script, CLOCK, Duration.ofMillis(200));

        jobs.start(dir, "s-1", "update", List.of(TWO_STEPS.get(0)), Map.of());
        await(() -> CodeGraphJobs.FAILED.equals(jobs.get(dir).state()));

        assertTrue(hanging.destroyed, "the process outlived its limit");
        assertTrue(jobs.get(dir).lastLine().startsWith("stopped: the build ran longer than"),
                jobs.get(dir).lastLine());
    }

    @Test
    void aProgramThatCannotStartEndsFailedWithTheReason(@TempDir Path dir) throws Exception {
        CodeGraphJobs.Launcher broken = (argv, folder, env) -> {
            throw new IOException("No such file or directory");
        };
        CodeGraphJobs jobs = new CodeGraphJobs(broken, CLOCK, Duration.ofMinutes(5));

        jobs.start(dir, "s-1", "update", List.of(TWO_STEPS.get(0)), Map.of());
        await(() -> CodeGraphJobs.FAILED.equals(jobs.get(dir).state()));

        assertTrue(jobs.get(dir).lastLine().contains("No such file or directory"), jobs.get(dir).lastLine());
    }

    @Test
    void theJobsAppearInTheJobsStateMapWithTheSchedulersFields(@TempDir Path dir) throws Exception {
        Script script = new Script();
        FakeProcess first = script.next();
        CodeGraphJobs jobs = new CodeGraphJobs(script, CLOCK, Duration.ofMinutes(5));

        jobs.start(dir, "s-9", "update", List.of(TWO_STEPS.get(0)), Map.of());
        first.say("Rebuilt: 8 nodes");
        await(() -> "Rebuilt: 8 nodes".equals(jobs.get(dir).lastLine()));

        Map<String, JobState> running = jobs.asJobStates();
        JobState state = running.get(CodeGraphJobs.jobId(dir));
        assertNotNull(state, "no entry under " + CodeGraphJobs.jobId(dir) + " in " + running.keySet());
        assertEquals("running", state.status());
        assertEquals("s-9", state.sessionId());
        assertEquals("Rebuilt: 8 nodes", state.resultPreview());

        first.exit(0);
        await(() -> CodeGraphJobs.OK.equals(jobs.get(dir).state()));
        assertEquals(JobState.OK, jobs.asJobStates().get(CodeGraphJobs.jobId(dir)).status());
    }

    @Test
    void theJobsStateEndpointShowsTheSchedulersJobsAndTheCodeGraphJobsSideBySide(@TempDir Path dir)
            throws Exception {
        Script script = new Script();
        FakeProcess first = script.next();
        CodeGraphJobs jobs = new CodeGraphJobs(script, CLOCK, Duration.ofMinutes(5));
        jobs.start(dir, "s-9", "update", List.of(TWO_STEPS.get(0)), Map.of());
        JobState nightly = new JobState("2026-10-09T02:00:00Z", JobState.OK, "end_turn", "s-1", "done");

        Map<String, JobState> merged = CodeGraphJobs.withCodeGraphJobs(Map.of("nightly", nightly), jobs);

        assertEquals(nightly, merged.get("nightly"));
        assertEquals("running", merged.get(CodeGraphJobs.jobId(dir)).status());
        assertEquals(2, merged.size());
        first.exit(0);
    }

    @Test
    void aFolderThatNeverRanHasNoJob(@TempDir Path dir) {
        CodeGraphJobs jobs = new CodeGraphJobs(new Script(), CLOCK, Duration.ofMinutes(5));

        assertNull(jobs.get(dir));
        assertFalse(jobs.asJobStates().containsKey(CodeGraphJobs.jobId(dir)));
    }
}
