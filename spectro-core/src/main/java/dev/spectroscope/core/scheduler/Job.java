package dev.spectroscope.core.scheduler;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/**
 * One job definition from ~/.spectro/jobs.json, deserialized by Jackson.
 *
 * @param id          unique job id, also the key in jobs-state.json
 * @param cron        5-field UNIX cron expression, e.g. "0 8 * * *"
 * @param prompt      the task text handed to the headless agent
 * @param cwd         working directory = the tools' path sandbox for this job
 * @param permissions "readonly" (default), "auto" or "extended": the headless policy
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record Job(String id, String cron, String prompt, String cwd, String permissions) {

    /** The permitted headless policies; the wire values are pinned. */
    public static final String READONLY = "readonly";
    public static final String AUTO = "auto";
    /** Card 453: approves like auto and lets the file tools leave {@code cwd}. */
    public static final String EXTENDED = "extended";
    /** The values {@code permissions} accepts: every known mode except ask,
     *  because a scheduled run has nobody to ask. */
    public static final java.util.List<String> PERMISSIONS = java.util.List.of(READONLY, AUTO, EXTENDED);

    /**
     * Validates one job and fills the default policy. Never trusts the file: a
     * malformed jobs.json must fail loudly, not silently mis-schedule.
     *
     * @throws IllegalArgumentException on a missing field or an unknown policy
     */
    public Job {
        requireNonBlank(id, "id");
        requireNonBlank(cron, "cron");
        requireNonBlank(prompt, "prompt");
        requireNonBlank(cwd, "cwd");
        if (permissions == null || permissions.isBlank()) {
            permissions = READONLY; // headless default
        }
        if (!PERMISSIONS.contains(permissions)) {
            throw new IllegalArgumentException(
                    "job \"" + id + "\": permissions must be \"readonly\", \"auto\" or \"extended\".");
        }
    }

    /**
     * Guard for the mandatory job fields — fails with the field's name in the message.
     *
     * @param value the field value to test
     * @param field the field name for the error text
     */
    private static void requireNonBlank(String value, String field) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException("job field \"" + field + "\" is missing or empty.");
        }
    }
}
