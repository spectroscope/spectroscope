package dev.spectroscope.core.scheduler;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * cron-utils computation, jobs.json validation, and the jobs-state round-trip.
 * The Gradle test task redirects {@code user.home} into the build directory.
 */
class CronSchedulerTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Path JOBS =
            Path.of(System.getProperty("user.home"), ".spectro", "jobs.json");

    @AfterEach
    void cleanup() throws IOException {
        Files.deleteIfExists(JOBS);
    }

    private static void writeJobs(String json) throws IOException {
        Files.createDirectories(JOBS.getParent());
        Files.writeString(JOBS, json);
    }

    @Test
    void nextRunComputesAFutureSlotInTheGivenZone() {
        ZoneId zone = ZoneId.of("Europe/Berlin");
        ZonedDateTime next = CronScheduler.nextRun("* * * * *", zone).orElseThrow();
        assertTrue(next.isAfter(ZonedDateTime.now(zone).minusSeconds(1)));
        assertTrue(next.isBefore(ZonedDateTime.now(zone).plusMinutes(2)),
                "an every-minute expression fires within the next two minutes");
        assertEquals(zone, next.getZone());
    }

    @Test
    void dailyExpressionsFireAtTheRequestedHour() {
        ZonedDateTime next = CronScheduler.nextRun("0 8 * * *", ZoneId.of("Europe/Berlin")).orElseThrow();
        assertEquals(8, next.getHour());
        assertEquals(0, next.getMinute());
    }

    @Test
    void loadJobsReturnsEmptyWithoutAFile() {
        assertEquals(List.of(), CronScheduler.loadJobs(JSON));
    }

    @Test
    void loadJobsParsesAndValidates() throws IOException {
        writeJobs("""
                [ { "id": "log-check", "cron": "0 8 * * *",
                    "prompt": "Check logs.", "cwd": "/tmp" } ]
                """);
        List<Job> jobs = CronScheduler.loadJobs(JSON);
        assertEquals(1, jobs.size());
        assertEquals(Job.READONLY, jobs.getFirst().permissions(), "readonly is the headless default");
    }

    @Test
    void duplicateIdsAreRejected() throws IOException {
        writeJobs("""
                [ { "id": "same", "cron": "* * * * *", "prompt": "a", "cwd": "/tmp" },
                  { "id": "same", "cron": "* * * * *", "prompt": "b", "cwd": "/tmp" } ]
                """);
        assertThrows(IllegalArgumentException.class, () -> CronScheduler.loadJobs(JSON));
    }

    @Test
    void badCronExpressionsFailLoudly() throws IOException {
        writeJobs("""
                [ { "id": "broken", "cron": "not a cron", "prompt": "a", "cwd": "/tmp" } ]
                """);
        assertThrows(IllegalArgumentException.class, () -> CronScheduler.loadJobs(JSON));
    }

    @Test
    void jobStateStoreRoundTripsPerId() throws IOException {
        // Isolate from other test classes sharing the redirected user.home.
        Files.deleteIfExists(Path.of(System.getProperty("user.home"), ".spectro", "jobs-state.json"));
        HeadlessRunner.JobStateStore.write(JSON, "job-a",
                new JobState("2026-07-02T10:00:00Z", JobState.OK, "end_turn", "s1", "fine"));
        HeadlessRunner.JobStateStore.write(JSON, "job-b",
                new JobState("2026-07-02T11:00:00Z", JobState.SKIPPED, "overlap", null, ""));

        Path statePath = Path.of(System.getProperty("user.home"), ".spectro", "jobs-state.json");
        Map<String, JobState> all = HeadlessRunner.JobStateStore.read(JSON, statePath);
        assertEquals(2, all.size());
        assertEquals(JobState.OK, all.get("job-a").status());
        assertEquals("overlap", all.get("job-b").stopReason());
    }
}
