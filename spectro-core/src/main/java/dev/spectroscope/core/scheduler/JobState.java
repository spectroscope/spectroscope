package dev.spectroscope.core.scheduler;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/**
 * The last result and status of a job, stored per id in ~/.spectro/jobs-state.json.
 * `spectroscope cron status` renders exactly this record.
 *
 * @param lastRunAt     ISO-8601 instant of the run
 * @param status        "ok" | "failed" | "skipped" (pinned wire values)
 * @param stopReason    end_turn | aborted | overlap | error: ...
 * @param sessionId     the run's session id, or null when skipped
 * @param resultPreview the first 200 characters of the final answer
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record JobState(String lastRunAt, String status, String stopReason,
                       String sessionId, String resultPreview) {

    /** Wire value: the run ended regularly with end_turn. */
    public static final String OK = "ok";
    /** Wire value: the run errored, was aborted, hit a limit, or the cwd was missing. */
    public static final String FAILED = "failed";
    /** Wire value: the slot was skipped by the overlap guard. */
    public static final String SKIPPED = "skipped";
}
