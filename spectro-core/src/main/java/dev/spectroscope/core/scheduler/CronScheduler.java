package dev.spectroscope.core.scheduler;

import com.cronutils.model.CronType;
import com.cronutils.model.definition.CronDefinition;
import com.cronutils.model.definition.CronDefinitionBuilder;
import com.cronutils.model.time.ExecutionTime;
import com.cronutils.parser.CronParser;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;

/**
 * The scheduler. cron-utils only COMPUTES times; a single
 * {@link ScheduledExecutorService} fires. The scheduler is just another event
 * consumer: it hands each job to {@link HeadlessRunner#runJob} and reads nothing
 * of its own. The core speaks only events, so it logs through the injected callback.
 */
public final class CronScheduler {

    /** UNIX 5-field definition — the classic five-field dialect. */
    private static final CronDefinition UNIX =
            CronDefinitionBuilder.instanceDefinitionFor(CronType.UNIX);
    private static final CronParser PARSER = new CronParser(UNIX);

    private final ObjectMapper mapper;
    private final ZoneId zone;
    private final Consumer<String> log;
    private final HeadlessRunner runner;

    /** Overlap guard: ids of jobs whose previous run is still going. */
    private final Set<String> running = Collections.synchronizedSet(new HashSet<>());

    /** One thread suffices: the executor only waits and dispatches; the runs block on it. */
    private final ScheduledExecutorService executor =
            Executors.newSingleThreadScheduledExecutor(runnable -> {
                Thread thread = new Thread(runnable, "spectroscope-cron");
                thread.setDaemon(true); // never keep the JVM alive after the CLI exits
                return thread;
            });

    /**
     * Wires the scheduler's collaborators; nothing fires until {@link #start}.
     *
     * @param runner the headless runner (built once from config)
     * @param mapper the module's shared, configured ObjectMapper
     * @param zone   the IANA zone the cron slots are computed in — NEVER implicit
     * @param log    log sink (the core never prints)
     */
    public CronScheduler(HeadlessRunner runner, ObjectMapper mapper, ZoneId zone, Consumer<String> log) {
        this.runner = runner;
        this.mapper = mapper;
        this.zone = zone;
        this.log = log;
    }

    /**
     * The next execution of a cron expression in the given zone, for `cron list/status`.
     *
     * @param cronExpr the 5-field UNIX cron expression to evaluate
     * @param zone     the IANA zone the slots are computed in
     * @return the next instant, or empty if the expression never fires again
     */
    public static Optional<ZonedDateTime> nextRun(String cronExpr, ZoneId zone) {
        ExecutionTime execution = ExecutionTime.forCron(PARSER.parse(cronExpr));
        return execution.nextExecution(ZonedDateTime.now(zone));
    }

    /**
     * Loads and validates jobs from ~/.spectro/jobs.json. Each entry is validated by the
     * {@link Job} constructor; the cron expression is parsed eagerly so a bad file fails
     * loudly. Duplicate ids are rejected.
     *
     * @param mapper the shared ObjectMapper that deserializes the file
     * @return the validated jobs, or an empty list when no jobs.json exists
     * @throws IllegalArgumentException on invalid JSON, a bad job, or a duplicate id
     */
    public static List<Job> loadJobs(ObjectMapper mapper) {
        Path path = Path.of(System.getProperty("user.home"), ".spectro", "jobs.json");
        if (!Files.exists(path)) {
            return List.of();
        }
        List<Job> jobs;
        try {
            jobs = mapper.readValue(Files.readString(path),
                    mapper.getTypeFactory().constructCollectionType(List.class, Job.class));
        } catch (IOException invalid) {
            throw new IllegalArgumentException(path + " is not valid JSON: " + invalid.getMessage(), invalid);
        }
        Set<String> seen = new HashSet<>();
        for (Job job : jobs) {
            if (!seen.add(job.id())) {
                throw new IllegalArgumentException(path + ": duplicate job id \"" + job.id() + "\".");
            }
            PARSER.parse(job.cron()).validate(); // reject a bad cron expression immediately
        }
        return jobs;
    }

    /**
     * Starts the scheduler: arms the first slot of every job. Returns immediately;
     * {@link #stop()} tears the executor down (the caller keeps the process alive until
     * Ctrl+C). Every job schedules its own next occurrence after it fires.
     *
     * @param jobs the validated jobs to arm (typically from {@link #loadJobs})
     */
    public void start(List<Job> jobs) {
        jobs.forEach(this::scheduleNext);
    }

    /**
     * Computes the delay to the next slot and arms exactly one execution.
     *
     * @param job the job whose next occurrence is being armed
     */
    private void scheduleNext(Job job) {
        if (executor.isShutdown()) {
            return;
        }
        Optional<ZonedDateTime> next = nextRun(job.cron(), zone);
        if (next.isEmpty()) {
            log.accept("[" + job.id() + "] cron \"" + job.cron() + "\" never fires again — not scheduled.");
            return;
        }
        long delayMs = Math.max(0L, Duration.between(Instant.now(), next.get().toInstant()).toMillis());
        executor.schedule(() -> fire(job), delayMs, TimeUnit.MILLISECONDS);
    }

    /**
     * Runs one slot: overlap guard, headless run, then reschedule the next occurrence.
     *
     * @param job the job whose slot just came due
     */
    private void fire(Job job) {
        try {
            if (running.contains(job.id())) {
                // Overlap guard: the previous run is still going — skip this slot and record it.
                log.accept("[" + job.id() + "] skipped: the previous run is still going.");
                HeadlessRunner.JobStateStore.write(mapper, job.id(),
                        new JobState(Instant.now().toString(), JobState.SKIPPED, "overlap", null, ""));
                return;
            }
            running.add(job.id());
            log.accept("[" + job.id() + "] start (cron \"" + job.cron() + "\", zone " + zone + ").");
            try {
                JobState state = runner.runJob(job, log);
                log.accept("[" + job.id() + "] end: " + state.status() + " (" + state.stopReason()
                        + "), session " + (state.sessionId() != null ? state.sessionId() : "-") + ".");
            } catch (RuntimeException failure) {
                log.accept("[" + job.id() + "] scheduler error: " + failure.getMessage());
            } finally {
                running.remove(job.id()); // remove in finally, or one slow run blocks the job forever
            }
        } finally {
            scheduleNext(job); // always arm the next slot, even after a skip or a failure
        }
    }

    /** Idempotent shutdown — stops arming and dispatching new slots. */
    public void stop() {
        executor.shutdownNow();
    }
}
