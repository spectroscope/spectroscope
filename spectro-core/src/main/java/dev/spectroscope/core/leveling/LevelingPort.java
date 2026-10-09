package dev.spectroscope.core.leveling;

import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.trace.TracingPort;
import dev.spectroscope.core.trace.TracingPorts;

import java.util.Objects;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Watches one live session's events and tells the ladder what it saw.
 *
 * <p>Two ways in. The server's browser session feeds it through
 * {@code SessionStore.onLine} and {@link #onEventAt} (card 473): the store
 * numbers every line the file gets, including the lines that never pass the
 * tracing ports (a closed exchange, a window override), so a receipt names
 * the line a reader finds at that position. There the port's own counter is
 * unused. As a tracing port it counts the stream itself; it then belongs on
 * {@link TracingPorts#register(TracingPort)}, never on {@code require}:
 * leveling is a nicety, and the registry isolates registered ports precisely
 * so a nicety cannot end a run. Either way this class adds its own warn-once
 * guard, the same belt-and-braces the OTLP sink wears.</p>
 *
 * <p>The session id is injected at construction from the store, exactly as
 * {@code JsonlSink} takes its {@code SessionStore}. That is also what makes the
 * live-versus-imported distinction structural rather than guessed: imports and
 * scenario replays are built in the browser and never reach a tracing port, so
 * a foreign transcript cannot mark anything here no matter what it contains.</p>
 */
public final class LevelingPort implements TracingPort {

    private final String sessionId;
    private final LevelingRecorder recorder;
    private final AtomicBoolean warned = new AtomicBoolean();
    private int index;

    /**
     * @param sessionId the session this port watches, from the session store
     * @param recorder where observations go
     */
    public LevelingPort(String sessionId, LevelingRecorder recorder) {
        this(sessionId, recorder, 0);
    }

    /**
     * @param sessionId the session this port watches, from the session store
     * @param recorder where observations go
     * @param startIndex how many events the session's file already holds — a resumed
     *        session appends, so counting from zero would put a receipt on the wrong line
     */
    public LevelingPort(String sessionId, LevelingRecorder recorder, int startIndex) {
        this.sessionId = Objects.requireNonNull(sessionId, "sessionId");
        this.recorder = Objects.requireNonNull(recorder, "recorder");
        this.index = Math.max(0, startIndex);
    }

    @Override
    public void onEvent(RunEvent event) {
        onEventAt(index++, event);
    }

    /**
     * Tells the ladder of one event at a line number the caller knows (card
     * 473: the session store's own count, see
     * {@code SessionStore.onLine}), instead of this port's own counter, which
     * only sees the tracing stream.
     *
     * @param at    the event's line number in the session file
     * @param event the event on that line
     */
    public void onEventAt(int at, RunEvent event) {
        try {
            recorder.observe(sessionId, at, event);
        } catch (RuntimeException never) {
            if (warned.compareAndSet(false, true)) {
                System.err.println("leveling: port failed on " + sessionId
                        + ", no longer scoring this session (" + never + ")");
            }
        }
    }
}
