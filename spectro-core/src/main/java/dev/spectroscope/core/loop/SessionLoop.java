package dev.spectroscope.core.loop;

/**
 * Card 504: the state of one loop. Guarded by its {@link LoopDriver}; it
 * holds no timer and calls nobody.
 */
final class SessionLoop {

    /**
     * One wakeup.
     *
     * @param id               its id
     * @param scheduledFor     when it falls due, on the whole minute
     * @param reason           the reason shown to the operator
     * @param prompt           the prompt it fires, possibly the sentinel
     * @param requestedSeconds the delay the model asked for, or null for one the harness chose
     * @param delaySeconds     the delay after the clamp
     * @param wasClamped       true when the clamp moved it
     * @param keepalive        true for the harness's one fallback
     */
    record Wakeup(String id, long scheduledFor, String reason, String prompt, Integer requestedSeconds,
                  int delaySeconds, boolean wasClamped, boolean keepalive) {
    }

    final String loopId;
    final String pacing;
    final String prompt;
    final Integer intervalSeconds;
    final long startedAt;

    Wakeup pending;
    WakeupTimer.Cancellable timer;
    boolean held;
    boolean preambleDelivered;
    int misses;
    int fires;
    boolean tickOpen;
    boolean scheduledThisTick;
    String endedReason;
    /** Fix round 1: an attached client heard the end. */
    boolean endSeen;

    SessionLoop(String loopId, String pacing, String prompt, Integer intervalSeconds, long startedAt) {
        this.loopId = loopId;
        this.pacing = pacing;
        this.prompt = prompt;
        this.intervalSeconds = intervalSeconds;
        this.startedAt = startedAt;
    }

    boolean active() {
        return endedReason == null;
    }

    boolean fixed() {
        return "fixed".equals(pacing);
    }

    LoopState state() {
        Wakeup next = pending;
        return new LoopState(loopId, active(), pacing, prompt, intervalSeconds,
                next == null ? null : next.scheduledFor(), next == null ? null : next.reason(),
                next != null && next.keepalive(), held, fires, startedAt, endedReason, !active() && !endSeen);
    }
}
