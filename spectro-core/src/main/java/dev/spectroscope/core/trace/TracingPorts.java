package dev.spectroscope.core.trace;

import dev.spectroscope.core.events.RunEvent;

import java.util.List;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * The registry that replaces the hard-wired JSONL sink (KONZEPT §4.3): one
 * {@code onEvent} fans out to every port. Durability first — ports added via
 * {@link #require(TracingPort)} see the event before any {@link #register(TracingPort)}ed
 * one, and their failures propagate (a run must not outlive its session file
 * in silence). Registered ports are auxiliary: a broken one is warned about
 * once, keeps being offered events (it may recover), and never costs the
 * other ports their delivery or the run its life.
 *
 * <p>The registry is itself a {@link TracingPort}, so registries compose.
 * Fan-out happens on the caller's thread — the drain loops are
 * single-threaded, and any port with threading needs handles them itself.</p>
 */
public final class TracingPorts implements TracingPort {

    private final List<TracingPort> required = new CopyOnWriteArrayList<>();
    private final List<TracingPort> registered = new CopyOnWriteArrayList<>();
    private final Set<TracingPort> warned = ConcurrentHashMap.newKeySet();

    /**
     * Adds a load-bearing port: its failure aborts the run, exactly like the
     * inline sink it replaced. The session's JSONL sink belongs here.
     *
     * @param port the port every event MUST reach
     * @return this registry, for fluent construction
     */
    public TracingPorts require(TracingPort port) {
        required.add(Objects.requireNonNull(port, "port"));
        return this;
    }

    /**
     * Adds an auxiliary port: isolated, best-effort, never fatal.
     *
     * @param port the port every event is offered
     * @return this registry, for fluent construction
     */
    public TracingPorts register(TracingPort port) {
        registered.add(Objects.requireNonNull(port, "port"));
        return this;
    }

    /**
     * Fans the event out: required ports first (failures propagate), then
     * registered ports (failures are contained, warned about once per port).
     *
     * @param event the event to deliver to every port
     */
    @Override
    public void onEvent(RunEvent event) {
        for (TracingPort port : required) {
            port.onEvent(event);
        }
        for (TracingPort port : registered) {
            try {
                port.onEvent(event);
            } catch (RuntimeException broken) {
                if (warned.add(port)) {
                    System.err.println("tracing port " + port.getClass().getSimpleName()
                            + " failed (suppressing further warnings): " + broken);
                }
            }
        }
    }
}
