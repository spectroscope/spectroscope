package dev.spectroscope.core.loop;

import com.fasterxml.jackson.databind.JsonNode;
import dev.spectroscope.core.config.governing.Governs;

import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.HexFormat;
import java.util.List;
import java.util.concurrent.ThreadLocalRandom;
import java.util.function.LongSupplier;

/**
 * Card 504, criteria 6 to 9 and 11: the loop of one session, beside
 * {@code CronScheduler} as card 266 asked and never through it, because the
 * scheduler fires through {@code HeadlessRunner}, the unattended face.
 *
 * <p>The driver arms each wakeup on a {@link WakeupTimer} its holder owns: the
 * server process for a browser session, a timer thread of the REPL for the
 * REPL. A wakeup lands on the whole minute at or after its delay. When it
 * falls due it fires only into a session that a client is attached to and
 * that runs nothing; otherwise it is held, written to {@code .loop.jsonl},
 * and fires when the session is attached and idle again, unless the loop has
 * aged out in the meantime.</p>
 *
 * <p>A loop with an interval re-arms itself at every fire. A self paced loop
 * waits for the model's {@code schedule_wakeup}; a tick that ends without one
 * gets one keepalive of {@link LoopLimits#KEEPALIVE_SECONDS}, and the second
 * such tick in a row ends the loop as {@code model_stopped}. Seven days after
 * its start the loop ends as {@code aged_out}; Stop in the chat ends it as
 * {@code user_abort}. Messaging ({@code agentMessaging}) is not read here.</p>
 *
 * <p>Threading: one lock, this object. The host is called outside it, so a
 * host may call back into the driver from any thread.</p>
 */
public final class LoopDriver {

    /** The end reason when the model stops the loop or misses its second tick. */
    public static final String MODEL_STOPPED = "model_stopped";
    /** The end reason seven days after the start. */
    public static final String AGED_OUT = "aged_out";
    /** The end reason of Stop in the chat. */
    public static final String USER_ABORT = "user_abort";

    private static final DateTimeFormatter CLOCK = DateTimeFormatter.ofPattern("HH:mm:ss");
    /** The grid a wakeup lands on: the whole minute at or after its delay. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.MILLISECONDS)
    static final long MINUTE = 60_000L;

    /** The session the loop fires into. Every method must return at once. */
    public interface Host {
        /** @return true when a client is attached to the session */
        boolean attached();

        /** @return true when no run is in flight */
        boolean idle();

        /**
         * Starts a run of the session.
         *
         * @param record what the record and the chat show as the prompt
         * @param model  what the model reads
         * @return true when the run started, false when the session was busy after all
         */
        boolean startRun(String record, String model);

        /** @param state the loop as it stands now */
        void info(LoopState state);
    }

    /**
     * What a {@code /loop} hands its first run.
     *
     * @param modelText what the first run's model reads
     * @param state     the loop as it stands after the start
     */
    public record Start(String modelText, LoopState state) {
    }

    /**
     * What {@code schedule_wakeup} answers.
     *
     * @param ok           true when a wakeup was armed or the loop stopped
     * @param text         the tool result
     * @param scheduledFor when the wakeup falls due, or 0
     * @param delaySeconds the delay after the clamp, or 0
     * @param wasClamped   true when the clamp moved the delay
     */
    public record Scheduled(boolean ok, String text, long scheduledFor, int delaySeconds, boolean wasClamped) {

        static Scheduled refused(String text) {
            return new Scheduled(false, text, 0L, 0, false);
        }
    }

    private final String sessionId;
    private final WakeupTimer timer;
    private final LongSupplier clock;
    private final LoopSidecar sidecar;

    private Host host;
    private SessionLoop loop;

    /**
     * @param sessionId the session the loop belongs to
     * @param timer     what holds the wakeups
     * @param clock     epoch millis
     * @param sidecar   the {@code .loop.jsonl} writer, or null for none
     */
    public LoopDriver(String sessionId, WakeupTimer timer, LongSupplier clock, LoopSidecar sidecar) {
        this.sessionId = sessionId;
        this.timer = timer;
        this.clock = clock;
        this.sidecar = sidecar;
    }

    /**
     * Rebuilds a loop that did not end from the session's sidecar, for a
     * holder that has none in memory (a server that restarted).
     *
     * @param sessionId the session
     * @param timer     what holds the wakeups
     * @param clock     epoch millis
     * @param sidecar   the sidecar to read
     * @return the driver with the loop and its pending wakeup, or with an ended loop whose end no
     *         client heard yet; null when no loop is open and no end waits to be told
     */
    public static LoopDriver restore(String sessionId, WakeupTimer timer, LongSupplier clock, LoopSidecar sidecar) {
        if (sidecar == null) {
            return null;
        }
        List<JsonNode> lines = sidecar.read(sessionId);
        JsonNode start = null;
        for (JsonNode line : lines) {
            if ("loop_start".equals(line.path("type").asText())) {
                start = line;
            }
        }
        if (start == null) {
            return null;
        }
        String loopId = start.path("loopId").asText();
        JsonNode armed = null;
        JsonNode endLine = null;
        boolean endSeen = false;
        int fires = 0;
        boolean fired = false;
        for (JsonNode line : lines) {
            if (!loopId.equals(line.path("loopId").asText())) {
                continue;
            }
            switch (line.path("type").asText()) {
                case "loop_end" -> endLine = line;
                case "loop_end_seen" -> endSeen = true;
                case "wakeup_armed" -> {
                    armed = line;
                    fired = false;
                }
                case "loop_fire" -> {
                    fires++;
                    if (armed != null && armed.path("wakeupId").asText().equals(line.path("wakeupId").asText())) {
                        fired = true;
                    }
                }
                default -> {
                }
            }
        }
        if (endLine != null && endSeen) {
            return null;
        }
        LoopDriver driver = new LoopDriver(sessionId, timer, clock, sidecar);
        synchronized (driver) {
            SessionLoop restored = new SessionLoop(loopId, start.path("pacing").asText("self"),
                    start.path("prompt").asText(""),
                    start.hasNonNull("intervalSeconds") ? start.path("intervalSeconds").asInt() : null,
                    start.path("ts").asLong());
            restored.fires = fires;
            driver.loop = restored;
            if (endLine != null) {
                // Fix round 1: ended while no client heard it; the next attach tells it.
                restored.endedReason = endLine.path("reason").asText(USER_ABORT);
                return driver;
            }
            long now = clock.getAsLong();
            if (armed != null && !fired) {
                SessionLoop.Wakeup wakeup = new SessionLoop.Wakeup(armed.path("wakeupId").asText(),
                        armed.path("scheduledFor").asLong(), armed.path("reason").asText(),
                        armed.has("prompt") ? armed.path("prompt").asText() : restored.prompt,
                        armed.hasNonNull("requestedSeconds") ? armed.path("requestedSeconds").asInt() : null,
                        armed.path("delaySeconds").asInt(), armed.path("wasClamped").asBoolean(),
                        armed.path("keepalive").asBoolean());
                restored.pending = wakeup;
                restored.timer = driver.timerFor(wakeup, now);
            } else if (restored.fixed()) {
                driver.armFixed(restored, now);
            } else {
                driver.armKeepalive(restored, now);
            }
        }
        return driver;
    }

    /**
     * Attaches the session's client, or with null detaches it. An attach
     * fires a wakeup that fell due while nobody was there.
     *
     * @param host the session as the client sees it, or null
     */
    public void host(Host host) {
        synchronized (this) {
            this.host = host;
        }
        if (host != null) {
            tell(host, state());
            poke();
        }
    }

    /**
     * Detaches the session's client, when it is still the one attached.
     *
     * @param host the client that leaves
     */
    public void detach(Host host) {
        synchronized (this) {
            if (this.host == host) {
                this.host = null;
            }
        }
    }

    /**
     * {@code /loop}: starts a loop, replacing one that runs. The caller starts
     * the first run itself, with {@link Start#modelText()}.
     *
     * @param prompt          the task
     * @param intervalSeconds the fixed interval, clamped to 60 to 3600, or null for a self paced loop
     * @return the first run's text and the state
     */
    public Start start(String prompt, Integer intervalSeconds) {
        String task = prompt == null ? "" : prompt.strip();
        Host told;
        LoopState state;
        String model;
        synchronized (this) {
            long now = clock.getAsLong();
            if (loop != null && loop.active()) {
                end(loop, USER_ABORT, now);
            }
            Integer interval = intervalSeconds == null ? null : clamp(intervalSeconds.doubleValue());
            SessionLoop fresh = new SessionLoop(HexFormat.of().toHexDigits(ThreadLocalRandom.current().nextInt()),
                    interval == null ? "self" : "fixed", task, interval, now);
            loop = fresh;
            fresh.tickOpen = true;
            if (sidecar != null) {
                sidecar.loopStart(sessionId, fresh.loopId, fresh.pacing, task, interval, now);
            }
            if (interval != null) {
                armFixed(fresh, now);
                model = LoopPrompts.fixed(task, interval);
            } else {
                model = LoopPrompts.selfPacedStart(task);
            }
            state = fresh.state();
            told = host;
        }
        if (told != null) {
            tell(told, state);
        }
        return new Start(model, state);
    }

    /**
     * {@code schedule_wakeup}: arms the loop's next wakeup, cancelling the
     * pending one, or with {@code stop} ends the loop.
     *
     * @param delaySeconds the delay the model asked for, or null
     * @param reason       one sentence for the operator, or null
     * @param prompt       the prompt to fire, the sentinel for a self paced loop, or null
     * @param stop         true to end the loop
     * @return the tool's answer
     */
    public Scheduled schedule(Double delaySeconds, String reason, String prompt, boolean stop) {
        Scheduled result;
        Host told;
        LoopState state;
        synchronized (this) {
            long now = clock.getAsLong();
            if (loop == null || !loop.active()) {
                return Scheduled.refused("ERROR: no loop runs in this session; the operator starts one with /loop.");
            }
            if (stop) {
                int cancelled = loop.pending == null ? 0 : 1;
                end(loop, MODEL_STOPPED, now);
                // Hub and spoke fix round: a stop ends the turn like an armed wakeup does.
                result = new Scheduled(true, "Loop stopped; cancelled " + cancelled + " pending wakeup"
                        + (cancelled == 1 ? "" : "s") + ". No further wakeups fire; the operator can start a new"
                        + " loop with /loop. The turn ends when this call returns, so the closing summary"
                        + " belongs before the stop.", 0L, 0, false);
            } else if (delaySeconds == null || reason == null || reason.isBlank()
                    || prompt == null || prompt.isBlank()) {
                return Scheduled.refused("ERROR: delaySeconds, reason and prompt are required unless stop is true.");
            } else if (prompt.strip().length() > LoopLimits.TEXT_CAP && !LoopPrompts.SENTINEL.equals(prompt.strip())
                    && !prompt.strip().equals(loop.prompt)) {
                // Fix round 2: what the model writes is bounded; the operator's own task is not its text.
                return Scheduled.refused("ERROR: prompt is longer than " + LoopLimits.TEXT_CAP + " characters."
                        + " Pass <<loop>> to keep the loop's own instructions, or a shorter prompt.");
            } else if (aged(loop, now)) {
                end(loop, AGED_OUT, now);
                result = Scheduled.refused("Wakeup not scheduled: the loop reached its age limit of 7 days and"
                        + " has ended. Do not call schedule_wakeup again.");
            } else {
                int delay = clamp(delaySeconds);
                boolean clamped = Double.isNaN(delaySeconds) || Double.isInfinite(delaySeconds)
                        || delay != Math.round(delaySeconds);
                // Fix round 1: a prompt the model wrote fires attributed to it,
                // in the record and in the model's text alike; the sentinel and
                // the operator's own task fire as they are.
                String written = prompt.strip();
                String fires = LoopPrompts.SENTINEL.equals(written) || written.equals(loop.prompt)
                        ? written : LoopPrompts.modelWritten(written, clockOf(now));
                SessionLoop.Wakeup wakeup = new SessionLoop.Wakeup(newId(), wholeMinute(now + delay * 1_000L),
                        capped(reason.strip()), fires, (int) Math.max(Integer.MIN_VALUE,
                        Math.min(Integer.MAX_VALUE, Math.round(delaySeconds))), delay, clamped, false);
                arm(loop, wakeup, now);
                loop.misses = 0;
                if (loop.tickOpen) {
                    loop.scheduledThisTick = true;
                }
                long in = Math.round((wakeup.scheduledFor() - now) / 1_000.0);
                result = new Scheduled(true, "Next wakeup at " + clockOf(wakeup.scheduledFor()) + " (in " + in + " s)"
                        + (clamped ? ", clamped to " + delay + " s from your requested value" : "")
                        + ". Write the per tick update before this call; the turn ends when it returns.",
                        wakeup.scheduledFor(), delay, clamped);
            }
            state = loop.state();
            told = host;
        }
        if (told != null) {
            tell(told, state);
        }
        return result;
    }

    /** The run in flight ended: closes the loop's tick, then fires a held wakeup. */
    public void runEnded() {
        Host told = null;
        LoopState state = null;
        synchronized (this) {
            if (loop != null && loop.active() && loop.tickOpen) {
                loop.tickOpen = false;
                long now = clock.getAsLong();
                if (!loop.fixed()) {
                    if (loop.scheduledThisTick) {
                        loop.misses = 0;
                    } else {
                        loop.misses++;
                        if (loop.misses > LoopLimits.KEEPALIVE_MISSES) {
                            end(loop, MODEL_STOPPED, now);
                        } else if (loop.pending == null) {
                            armKeepalive(loop, now);
                        }
                    }
                }
                loop.scheduledThisTick = false;
                state = loop.state();
                told = host;
            }
        }
        if (told != null) {
            tell(told, state);
        }
        poke();
    }

    /**
     * The history the model reads no longer holds the loop's instructions: a
     * compaction, a {@code /clear}, or a client that rebuilt the history from
     * the session file. The sentinel expands to the full instructions at its
     * next fire.
     */
    public synchronized void compacted() {
        if (loop != null) {
            loop.preambleDelivered = false;
        }
    }

    /** Stop in the chat or on the chip: ends the loop as {@code user_abort}. */
    public void userAbort() {
        Host told;
        LoopState state;
        synchronized (this) {
            if (loop == null || !loop.active()) {
                return;
            }
            end(loop, USER_ABORT, clock.getAsLong());
            state = loop.state();
            told = host;
        }
        if (told != null) {
            tell(told, state);
        }
    }

    /** @return the loop as it stands, or {@link LoopState#none()} */
    public synchronized LoopState state() {
        return loop == null ? LoopState.none() : loop.state();
    }

    /** @return true while a loop runs */
    public synchronized boolean active() {
        return loop != null && loop.active();
    }

    /** Fires a wakeup that is held or due, if the session can take it now. */
    public void poke() {
        tryFire(null);
    }

    // ── inside ─────────────────────────────────────────────────────────────

    private void tryFire(String dueId) {
        Host told;
        LoopState state;
        String record = null;
        String model = null;
        SessionLoop.Wakeup fired = null;
        boolean preambleBefore = false;
        synchronized (this) {
            SessionLoop current = loop;
            if (current == null || !current.active() || current.pending == null) {
                return;
            }
            SessionLoop.Wakeup wakeup = current.pending;
            long now = clock.getAsLong();
            if (dueId != null && !dueId.equals(wakeup.id())) {
                return; // a wakeup that was replaced
            }
            if (dueId == null && !current.held && now < wakeup.scheduledFor()) {
                return; // nothing is due yet
            }
            if (aged(current, now)) {
                end(current, AGED_OUT, now);
            } else if (host == null || !host.attached()) {
                hold(current, wakeup, "detached", now);
            } else if (!host.idle()) {
                hold(current, wakeup, "busy", now);
            } else {
                preambleBefore = current.preambleDelivered;
                String expansion;
                if (current.fixed()) {
                    // Hub and spoke fix round: a sentinel the model passed in a
                    // fixed loop stands for the loop's own task, as it does in a
                    // self paced one; the model never reads the bare sentinel.
                    record = LoopPrompts.SENTINEL.equals(wakeup.prompt()) ? current.prompt : wakeup.prompt();
                    model = LoopPrompts.fixed(record, current.intervalSeconds);
                    expansion = "fixed";
                } else if (LoopPrompts.SENTINEL.equals(wakeup.prompt())) {
                    record = current.prompt;
                    if (current.preambleDelivered) {
                        model = LoopPrompts.reminder();
                        expansion = "reminder";
                    } else {
                        model = LoopPrompts.full(current.prompt);
                        current.preambleDelivered = true;
                        expansion = "full";
                    }
                } else {
                    record = wakeup.prompt();
                    model = LoopPrompts.verbatimSelfPaced(wakeup.prompt());
                    expansion = "verbatim";
                }
                current.pending = null;
                current.timer = null;
                current.held = false;
                current.fires++;
                current.tickOpen = true;
                current.scheduledThisTick = false;
                fired = wakeup;
                if (sidecar != null) {
                    sidecar.fired(sessionId, current.loopId, wakeup, expansion, now);
                }
                if (current.fixed()) {
                    armFixed(current, now, wakeup.scheduledFor());
                }
            }
            state = current.state();
            told = host;
        }
        if (fired != null && told != null && !told.startRun(record, model)) {
            // The session took a run between the check and the start: hold the wakeup again.
            synchronized (this) {
                SessionLoop current = loop;
                if (current != null && current.active()) {
                    if (current.timer != null) {
                        current.timer.cancel();
                    }
                    current.pending = fired;
                    current.timer = null;
                    current.held = true;
                    current.fires--;
                    current.tickOpen = false;
                    current.preambleDelivered = preambleBefore;
                    state = current.state();
                }
            }
        }
        if (told != null) {
            tell(told, state);
        }
    }

    /** The caller holds the lock. */
    private void hold(SessionLoop current, SessionLoop.Wakeup wakeup, String why, long now) {
        if (!current.held) {
            current.held = true;
            if (sidecar != null) {
                sidecar.held(sessionId, current.loopId, wakeup, why, now);
            }
        }
    }

    /** The caller holds the lock. */
    private void armFixed(SessionLoop current, long now) {
        armFixed(current, now, null);
    }

    /**
     * The caller holds the lock. A fixed loop counts its next wakeup from the
     * minute the last one was due, so a fire a few milliseconds late keeps the
     * cadence; a wakeup that would already be past starts afresh from now.
     */
    private void armFixed(SessionLoop current, long now, Long lastDue) {
        int interval = current.intervalSeconds;
        long next = lastDue != null && lastDue + interval * 1_000L > now
                ? wholeMinute(lastDue + interval * 1_000L)
                : wholeMinute(now + interval * 1_000L);
        arm(current, new SessionLoop.Wakeup(newId(), next,
                "every " + interval + " s", current.prompt, interval, interval, false, false), now);
    }

    /** The caller holds the lock. */
    private void armKeepalive(SessionLoop current, long now) {
        int delay = LoopLimits.KEEPALIVE_SECONDS;
        arm(current, new SessionLoop.Wakeup(newId(), wholeMinute(now + delay * 1_000L),
                "keepalive: the last tick did not call schedule_wakeup", LoopPrompts.SENTINEL, null, delay,
                false, true), now);
    }

    /** The caller holds the lock. A new wakeup cancels the pending one. */
    private void arm(SessionLoop current, SessionLoop.Wakeup wakeup, long now) {
        if (current.timer != null) {
            current.timer.cancel();
        }
        current.pending = wakeup;
        current.held = false;
        current.timer = timerFor(wakeup, now);
        if (sidecar != null) {
            sidecar.armed(sessionId, current.loopId, wakeup, wakeup.prompt().equals(current.prompt), now);
        }
    }

    private WakeupTimer.Cancellable timerFor(SessionLoop.Wakeup wakeup, long now) {
        String id = wakeup.id();
        return timer.schedule(() -> tryFire(id), Math.max(0, wakeup.scheduledFor() - now));
    }

    /** The caller holds the lock. */
    private void end(SessionLoop current, String reason, long now) {
        if (!current.active()) {
            return;
        }
        if (current.timer != null) {
            current.timer.cancel();
        }
        current.timer = null;
        current.pending = null;
        current.held = false;
        current.tickOpen = false;
        current.endedReason = reason;
        if (sidecar != null) {
            sidecar.ended(sessionId, current.loopId, reason, now);
        }
    }

    /**
     * Tells the host, outside the lock. The first time an ended loop's state
     * reaches an attached client, its end counts as heard: the sidecar gets a
     * {@code loop_end_seen} line and later states carry {@code endUnseen}
     * false, so the page writes the end line once (fix round 1).
     */
    private void tell(Host told, LoopState state) {
        if (told == null || state == null) {
            return;
        }
        told.info(state);
        if (state.endUnseen() && told.attached()) {
            synchronized (this) {
                SessionLoop current = loop;
                if (current != null && !current.active() && !current.endSeen
                        && current.loopId.equals(state.loopId())) {
                    current.endSeen = true;
                    if (sidecar != null) {
                        sidecar.endSeen(sessionId, current.loopId, clock.getAsLong());
                    }
                }
            }
        }
    }

    /**
     * Fix round 2: a reason cut to {@link LoopLimits#TEXT_CAP}, marked where it
     * was cut. The cut never splits a surrogate pair.
     */
    private static String capped(String reason) {
        if (reason.length() <= LoopLimits.TEXT_CAP) {
            return reason;
        }
        int end = Character.isHighSurrogate(reason.charAt(LoopLimits.TEXT_CAP - 1))
                ? LoopLimits.TEXT_CAP - 1 : LoopLimits.TEXT_CAP;
        return reason.substring(0, end) + " [cut at " + LoopLimits.TEXT_CAP + " characters]";
    }

    private static boolean aged(SessionLoop current, long now) {
        return now - current.startedAt >= LoopLimits.MAX_AGE_MS;
    }

    /**
     * The delay clamp of reader 02: not a number is the minimum, an infinite
     * delay the maximum, everything else rounded into 60 to 3600 seconds.
     */
    static int clamp(double seconds) {
        if (Double.isNaN(seconds) || seconds == Double.NEGATIVE_INFINITY) {
            return LoopLimits.MIN_DELAY_SECONDS;
        }
        if (seconds == Double.POSITIVE_INFINITY) {
            return LoopLimits.MAX_DELAY_SECONDS;
        }
        long rounded = Math.round(seconds);
        return (int) Math.max(LoopLimits.MIN_DELAY_SECONDS, Math.min(LoopLimits.MAX_DELAY_SECONDS, rounded));
    }

    /** @return the whole minute at or after the instant */
    static long wholeMinute(long at) {
        return Math.floorDiv(at + MINUTE - 1, MINUTE) * MINUTE;
    }

    private static String clockOf(long at) {
        return CLOCK.format(Instant.ofEpochMilli(at).atZone(ZoneId.systemDefault()));
    }

    private static String newId() {
        return HexFormat.of().toHexDigits(ThreadLocalRandom.current().nextInt());
    }
}
