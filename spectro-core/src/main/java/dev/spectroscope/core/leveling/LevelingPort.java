package dev.spectroscope.core.leveling;

import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.trace.TracingPort;
import dev.spectroscope.core.trace.TracingPorts;

import java.util.Objects;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Watches one live session's event stream and tells the ladder what it saw.
 *
 * <p>Belongs on {@link TracingPorts#register(TracingPort)}, never on
 * {@code require}: leveling is a nicety, and the registry isolates registered
 * ports precisely so a nicety cannot end a run. This class adds its own
 * warn-once guard on top, the same belt-and-braces the OTLP sink wears.</p>
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
        this.sessionId = Objects.requireNonNull(sessionId, "sessionId");
        this.recorder = Objects.requireNonNull(recorder, "recorder");
    }

    @Override
    public void onEvent(RunEvent event) {
        int at = index++;
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
