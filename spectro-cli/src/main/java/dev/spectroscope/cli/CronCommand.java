package dev.spectroscope.cli;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.scheduler.CronScheduler;
import dev.spectroscope.core.scheduler.HeadlessRunner;
import dev.spectroscope.core.scheduler.Job;
import dev.spectroscope.core.scheduler.JobState;
import picocli.CommandLine.Command;
import picocli.CommandLine.Option;
import picocli.CommandLine.Parameters;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;

/**
 * spectroscope cron [list|status] [--once &lt;id&gt;]  — with no subcommand: the daemon.
 *
 * <p>list/status compute the next slots via ExecutionTime and read the last results
 * from jobs-state.json. --once runs one job immediately (for testing). With no
 * argument the scheduler runs in the foreground until Ctrl+C. The zone is always
 * explicit — the system default is a fine choice, an implicit one is not.
 */
@Command(name = "cron", description = "Schedule and run jobs from ~/.spectro/jobs.json.")
public final class CronCommand implements Callable<Integer> {

    /** Where the scheduler persists each job's last result (under ~/.spectro). */
    private static final String JOBS_STATE_FILE = "jobs-state.json";

    @Option(names = "--once", description = "Run one job immediately by id.")
    private String once;

    @Parameters(index = "0", arity = "0..1", description = "list | status (omit for the daemon).")
    private String sub;

    /** Shared setup, then a dispatch to one of three modes: a one-off run
     *  (--once), the list/status report, or the foreground daemon.
     *
     * @return the process exit code — 0 on success, 1 for an unknown subcommand
     *         or a failed/unknown job
     */
    @Override
    public Integer call() {
        ObjectMapper mapper = new ObjectMapper();
        ZoneId zone = ZoneId.systemDefault(); // always explicit — never left implicit
        List<Job> jobs = CronScheduler.loadJobs(mapper);
        // Deliberately process-moment, NOT loadForWorkspace: one daemon serves every
        // job, and each job already names its own explicit job.cwd (the tool sandbox,
        // read inside HeadlessRunner.runJob) — there is no single "the workspace" to
        // re-resolve a config against here, unlike the REPL/run/server session moment.
        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none());
        LogSetup.apply(config.logLevel()); // config-effective level onto the root
        HeadlessRunner runner = new HeadlessRunner(mapper, config);

        if (once != null) {
            return runJobOnce(jobs, runner);
        }
        if ("list".equals(sub) || "status".equals(sub)) {
            return printJobs(jobs, mapper, zone, "status".equals(sub));
        }
        if (sub != null) {
            System.err.println("Unknown cron subcommand \"" + sub + "\". Allowed: list, status, --once <id>.");
            return 1;
        }
        return runDaemon(jobs, runner, mapper, zone);
    }

    /**
     * --once: fire one job now; the exit code mirrors the job's status.
     *
     * @param jobs   every configured job — searched for the {@code --once} id
     * @param runner executes the matched job headless, streaming its log lines to stdout
     * @return 0 when the job finished OK, 1 for an unknown id or a failed run
     */
    private Integer runJobOnce(List<Job> jobs, HeadlessRunner runner) {
        Job job = jobs.stream().filter(j -> j.id().equals(once)).findFirst().orElse(null);
        if (job == null) {
            System.err.println("No job \"" + once + "\" in ~/.spectro/jobs.json.");
            return 1;
        }
        System.out.println("[" + job.id() + "] one-off run starts (permissions " + job.permissions() + ").");
        JobState state = runner.runJob(job, System.out::println);
        System.out.println("[" + job.id() + "] " + state.status() + " (" + state.stopReason()
                + "), session " + (state.sessionId() != null ? state.sessionId() : "-"));
        return JobState.OK.equals(state.status()) ? 0 : 1;
    }

    /**
     * list/status: every job with its next slot; withStatus adds the last result.
     *
     * @param jobs       the configured jobs to report on — an empty list prints a hint, not an error
     * @param mapper     deserializes the persisted per-job state file
     * @param zone       the zone the next-run slots are computed and printed in
     * @param withStatus true for {@code status} — adds last run, stop reason and result preview per job
     * @return always 0 — a report never fails the process
     */
    private Integer printJobs(List<Job> jobs, ObjectMapper mapper, ZoneId zone, boolean withStatus) {
        if (jobs.isEmpty()) {
            System.out.println("No jobs defined (~/.spectro/jobs.json).");
        }
        Map<String, JobState> states = readState(mapper);
        for (Job job : jobs) {
            Optional<ZonedDateTime> next = CronScheduler.nextRun(job.cron(), zone);
            System.out.println(job.id() + "  cron \"" + job.cron() + "\"  permissions " + job.permissions());
            System.out.println("  next run: " + next.map(ZonedDateTime::toString).orElse("-")
                    + " (zone " + zone + ")");
            if (withStatus) {
                JobState s = states.get(job.id());
                System.out.println("  last run: " + (s != null
                        ? s.lastRunAt() + "  " + s.status() + " (" + s.stopReason() + ")  session "
                          + (s.sessionId() != null ? s.sessionId() : "-")
                        : "never run"));
                if (s != null && !s.resultPreview().isEmpty()) {
                    System.out.println("  result:   " + s.resultPreview());
                }
            }
        }
        return 0;
    }

    /**
     * No subcommand: the foreground scheduler, running until Ctrl+C. A shutdown
     * hook stops the scheduler and releases the await before the JVM exits.
     *
     * @param jobs   the jobs to schedule — an empty list refuses to start (nothing to do)
     * @param runner executes each due job when its cron slot fires
     * @param mapper persists each job's result state between runs
     * @param zone   the zone cron expressions are evaluated in — always explicit
     * @return 0 after a clean Ctrl+C shutdown, 1 when there was nothing to schedule
     */
    private Integer runDaemon(List<Job> jobs, HeadlessRunner runner, ObjectMapper mapper, ZoneId zone) {
        if (jobs.isEmpty()) {
            System.err.println("No jobs in ~/.spectro/jobs.json, nothing to schedule.");
            return 1;
        }
        System.out.println("spectroscope cron: " + jobs.size() + " job(s), zone " + zone + ". Ctrl+C ends it.");
        CronScheduler scheduler = new CronScheduler(runner, mapper, zone, System.out::println);
        CountDownLatch stopped = new CountDownLatch(1);
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            scheduler.stop();
            System.out.println("\nScheduler stopped.");
            stopped.countDown();
        }));
        scheduler.start(jobs);
        try {
            stopped.await(); // the daemon runs until Ctrl+C fires the shutdown hook
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
        return 0;
    }

    /**
     * Reads the persisted last-result-per-job map from {@code ~/.spectro/jobs-state.json};
     * a missing or corrupt file yields an empty map, so {@code cron status} always works.
     *
     * @param mapper deserializes the state file into an insertion-ordered map
     * @return job id to last {@link JobState}, empty when nothing was persisted yet
     */
    private static Map<String, JobState> readState(ObjectMapper mapper) {
        Path path = Path.of(System.getProperty("user.home"), ".spectro", JOBS_STATE_FILE);
        if (!Files.exists(path)) {
            return Map.of();
        }
        try {
            return mapper.readValue(Files.readString(path),
                    mapper.getTypeFactory().constructMapType(
                            LinkedHashMap.class, String.class, JobState.class));
        } catch (IOException broken) {
            return Map.of(); // a corrupt state file does not block `cron status`
        }
    }
}
