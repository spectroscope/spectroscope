package dev.spectroscope.core.loop;

/**
 * Card 504: one loop as the page and the REPL show it, the body of the
 * {@code loop_info} frame.
 *
 * @param loopId          the loop's id, or null before the first {@code /loop}
 * @param active          true while the loop runs
 * @param pacing          {@code fixed} or {@code self}
 * @param prompt          the task the operator wrote with {@code /loop}
 * @param intervalSeconds the fixed interval, or null for a self paced loop
 * @param nextAt          when the next wakeup falls due, epoch millis, or null
 * @param reason          the reason the model gave for it, or null
 * @param keepalive       true when the pending wakeup is the harness's keepalive
 * @param held            true when a wakeup fell due and waits for an idle, attached session
 * @param fires           how many wakeups fired
 * @param startedAt       when the loop started, epoch millis
 * @param endedReason     {@code model_stopped}, {@code aged_out} or {@code user_abort} once it ended, else null
 * @param endUnseen       fix round 1: true while the loop has ended and no attached client has heard
 *                        its end yet, so the page writes the end line it missed
 */
public record LoopState(String loopId, boolean active, String pacing, String prompt, Integer intervalSeconds,
                        Long nextAt, String reason, boolean keepalive, boolean held, int fires, long startedAt,
                        String endedReason, boolean endUnseen) {

    /** @return the state of a session that never ran a loop */
    public static LoopState none() {
        return new LoopState(null, false, null, null, null, null, null, false, false, 0, 0L, null, false);
    }
}
