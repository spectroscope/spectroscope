package dev.spectroscope.server.codegraph;

import dev.spectroscope.core.scheduler.JobState;
import dev.spectroscope.core.tools.ToolPath;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayDeque;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

/**
 * The code graph builds running in the background of this server (card 472).
 *
 * <p>One build per folder at a time. A build runs its steps one after the
 * other on its own thread, never on a request or socket thread, so a build of
 * minutes leaves the chat and the socket as they were. Its state moves once:
 * {@link #RUNNING} from the start, then {@link #OK} when every step exited 0,
 * or {@link #FAILED} at the first step that did not, that could not start, or
 * that outlived the limit. A failed build keeps its last {@link #TAIL} lines
 * for the failure sheet.</p>
 *
 * <p>The finished state of the last build per folder stays in memory until the
 * server stops; the graph itself is on disk and needs no bookkeeping here.</p>
 */
public final class CodeGraphJobs {

    /** The state of a build in progress; the desktop tray counts this value. */
    public static final String RUNNING = "running";
    /** Every step exited 0. Same wire value as the scheduler's {@link JobState#OK}. */
    public static final String OK = JobState.OK;
    /** A step failed, could not start, or ran past the limit. Same as {@link JobState#FAILED}. */
    public static final String FAILED = JobState.FAILED;

    /** How many output lines a build keeps, the number the failure sheet shows. */
    public static final int TAIL = 20;

    /**
     * How long one build may run before it is stopped. A full build without
     * labels of this repository took 50.6 s on 2026-10-09 (card 472, start and
     * end time read from {@code /api/codegraph/status}); an hour leaves room for
     * a large folder and a slow naming backend and still ends a hung step.
     */
    static final Duration LIMIT = Duration.ofMinutes(60);

    /** A line longer than this is cut, so one runaway line cannot fill the memory. */
    static final int LINE_CAP = 400;

    /** Starts one step. The production form is {@link #PROCESS}. */
    @FunctionalInterface
    public interface Launcher {
        /**
         * Starts a program with its output and errors merged into one stream.
         *
         * @param argv   the argument list, the program first
         * @param folder the working directory
         * @param env    variables to add to the inherited environment
         * @return the started process
         * @throws IOException when the program cannot be started
         */
        Process start(List<String> argv, Path folder, Map<String, String> env) throws IOException;
    }

    /**
     * Real processes: the tool PATH every tool shell gets (so a Finder-launched
     * app finds the interpreter graphify needs), plus the given variables, with
     * standard error merged into standard output and no standard input.
     */
    public static final Launcher PROCESS = (argv, folder, env) -> {
        ProcessBuilder builder = new ProcessBuilder(argv)
                .directory(folder.toFile())
                .redirectErrorStream(true);
        builder.environment().put("PATH", ToolPath.resolve().path());
        builder.environment().putAll(env);
        Process process = builder.start();
        process.getOutputStream().close();
        return process;
    };

    /**
     * What a build looks like from outside, at one moment.
     *
     * @param folder    the folder the build runs in
     * @param sessionId the session that started it
     * @param mode      {@code full} or {@code update}
     * @param state     {@link #RUNNING}, {@link #OK} or {@link #FAILED}
     * @param startedAt ISO-8601 instant of the start
     * @param endedAt   ISO-8601 instant of the end, or null while running
     * @param exitCode  the exit code of the last step that ended, or null
     * @param lastLine  the last line of output, or null before the first
     * @param tail      up to {@link #TAIL} last lines, oldest first
     */
    public record Snapshot(String folder, String sessionId, String mode, String state, String startedAt,
                           String endedAt, Integer exitCode, String lastLine, List<String> tail) {
    }

    /** The mutable side of one build, guarded by its own monitor. */
    private final class Job {
        private final Path folder;
        private final String sessionId;
        private final String mode;
        private final String startedAt;
        private final ArrayDeque<String> tail = new ArrayDeque<>();
        private String state = RUNNING;
        private String endedAt;
        private Integer exitCode;
        private Process current;
        private boolean overrun;

        Job(Path folder, String sessionId, String mode) {
            this.folder = folder;
            this.sessionId = sessionId;
            this.mode = mode;
            this.startedAt = clock.instant().toString();
        }

        synchronized void line(String raw) {
            String line = raw.length() > LINE_CAP ? raw.substring(0, LINE_CAP) : raw;
            if (tail.size() == TAIL) {
                tail.removeFirst();
            }
            tail.addLast(line);
        }

        synchronized void end(String finalState, Integer code) {
            if (!RUNNING.equals(state)) {
                return;
            }
            state = finalState;
            exitCode = code;
            endedAt = clock.instant().toString();
        }

        synchronized void attach(Process process) {
            current = process;
        }

        synchronized boolean overrun() {
            return overrun;
        }

        /** Stops the step in flight once the limit has passed. */
        synchronized void stopForOverrun() {
            if (!RUNNING.equals(state)) {
                return;
            }
            overrun = true;
            if (current != null) {
                current.destroyForcibly();
            }
        }

        synchronized Snapshot snapshot() {
            return new Snapshot(folder.toString(), sessionId, mode, state, startedAt, endedAt, exitCode,
                    tail.peekLast(), List.copyOf(tail));
        }
    }

    private static final CodeGraphJobs SHARED = new CodeGraphJobs(PROCESS, Clock.systemUTC(), LIMIT);

    private final Launcher launcher;
    private final Clock clock;
    private final Duration limit;
    private final Map<Path, Job> jobs = new ConcurrentHashMap<>();

    /**
     * The builds of this server process; the controller and the jobs-state
     * endpoint read the same instance.
     *
     * @return the shared instance
     */
    public static CodeGraphJobs shared() {
        return SHARED;
    }

    /**
     * Seam for tests.
     *
     * @param launcher starts each step
     * @param clock    stamps start and end
     * @param limit    how long one build may run
     */
    public CodeGraphJobs(Launcher launcher, Clock clock, Duration limit) {
        this.launcher = launcher;
        this.clock = clock;
        this.limit = limit;
    }

    /**
     * Starts a build unless one already runs for the folder.
     *
     * @param folder    the resolved workspace the steps run against
     * @param sessionId the session that asked
     * @param mode      {@code full} or {@code update}, for the display
     * @param steps     the argument lists, run in order
     * @param env       variables for every step's environment
     * @return the running build, or null when one already runs for the folder
     */
    public Snapshot start(Path folder, String sessionId, String mode, List<List<String>> steps,
                          Map<String, String> env) {
        Job job;
        synchronized (jobs) {
            Job previous = jobs.get(folder);
            if (previous != null && RUNNING.equals(previous.snapshot().state())) {
                return null;
            }
            job = new Job(folder, sessionId, mode);
            jobs.put(folder, job);
        }
        Snapshot started = job.snapshot();
        Thread.ofPlatform().daemon().name("codegraph-" + folder.getFileName())
                .start(() -> run(job, List.copyOf(steps), Map.copyOf(env)));
        Thread.ofVirtual().name("codegraph-limit").start(() -> {
            try {
                Thread.sleep(limit);
            } catch (InterruptedException stopped) {
                return;
            }
            job.stopForOverrun();
        });
        return started;
    }

    private void run(Job job, List<List<String>> steps, Map<String, String> env) {
        Integer last = null;
        for (List<String> argv : steps) {
            if (job.overrun()) {
                overran(job, last);
                return;
            }
            Process process;
            try {
                process = launcher.start(argv, job.folder, env);
            } catch (IOException | RuntimeException cannot) {
                job.line("could not start " + argv.get(0) + ": " + cannot.getMessage());
                job.end(FAILED, null);
                return;
            }
            job.attach(process);
            try (BufferedReader out = new BufferedReader(
                    new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = out.readLine()) != null) {
                    job.line(line);
                }
            } catch (IOException readFailed) {
                job.line("output could not be read: " + readFailed.getMessage());
            }
            int code;
            try {
                code = process.waitFor();
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                process.destroyForcibly();
                job.end(FAILED, null);
                return;
            }
            if (job.overrun()) {
                overran(job, code);
                return;
            }
            if (code != 0) {
                job.end(FAILED, code);
                return;
            }
            last = code;
        }
        job.end(OK, last);
    }

    /** Ends a build the limit stopped, saying so in its last line. */
    private void overran(Job job, Integer code) {
        long minutes = limit.toMinutes();
        job.line("stopped: the build ran longer than "
                + (minutes > 0 ? minutes + " minutes" : limit.toMillis() + " ms"));
        job.end(FAILED, code);
    }

    /**
     * The last build for a folder.
     *
     * @param folder the resolved workspace
     * @return its build, or null when none ran since the server started
     */
    public Snapshot get(Path folder) {
        Job job = jobs.get(folder);
        return job == null ? null : job.snapshot();
    }

    /**
     * The id a folder's build has in the jobs-state map.
     *
     * @param folder the resolved workspace
     * @return {@code codegraph:} followed by the folder's path
     */
    public static String jobId(Path folder) {
        return "codegraph:" + folder;
    }

    /**
     * The builds in the scheduler's record shape, so {@code /api/jobs/state}
     * and the desktop tray that polls it see them beside the cron jobs.
     *
     * @return job id to state; the preview is the last line of output
     */
    public Map<String, JobState> asJobStates() {
        Map<String, JobState> states = new LinkedHashMap<>();
        for (Job job : jobs.values()) {
            Snapshot s = job.snapshot();
            String stop = RUNNING.equals(s.state()) ? RUNNING
                    : s.exitCode() == null ? "error" : "exit " + s.exitCode();
            states.put(jobId(job.folder), new JobState(s.endedAt() == null ? s.startedAt() : s.endedAt(),
                    s.state(), stop, s.sessionId(), s.lastLine()));
        }
        return states;
    }

    /**
     * The scheduler's job states with the code graph builds added.
     *
     * @param scheduler the states read from the scheduler's file
     * @param builds    the builds of this process
     * @return a new map holding both; a build never replaces a scheduler entry
     */
    public static Map<String, JobState> withCodeGraphJobs(Map<String, JobState> scheduler, CodeGraphJobs builds) {
        Map<String, JobState> merged = new LinkedHashMap<>(scheduler);
        builds.asJobStates().forEach(merged::putIfAbsent);
        return merged;
    }
}
