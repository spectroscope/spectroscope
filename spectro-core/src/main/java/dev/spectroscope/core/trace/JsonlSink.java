package dev.spectroscope.core.trace;

import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.session.SessionStore;

import java.util.Objects;

/**
 * The first port (KONZEPT §4.3): session persistence as a {@link TracingPort}.
 * Deliberately thin — it inherits {@link SessionStore#append}'s failure
 * behaviour unchanged, which is why the drain sites {@code require(...)} it:
 * a run must not outlive its session file in silence.
 */
public final class JsonlSink implements TracingPort {

    private final SessionStore store;

    /** @param store the session this run persists into */
    public JsonlSink(SessionStore store) {
        this.store = Objects.requireNonNull(store, "store");
    }

    @Override
    public void onEvent(RunEvent event) {
        store.append(event);
    }
}
