package dev.spectroscope.core.trace;

import dev.spectroscope.core.events.RunEvent;

/**
 * One pluggable consumer of the run's event stream (the OpenAI processor
 * pattern, KONZEPT §4.3): JSONL persistence, a bus publisher, later an OTel
 * exporter — each a port, all fed by the same drain loop through a
 * {@link TracingPorts} registry instead of hard-wired calls.
 *
 * <p>Implementations should not throw. The registry isolates ports added via
 * {@link TracingPorts#register(TracingPort)} anyway (belt and braces), but a
 * port added via {@link TracingPorts#require(TracingPort)} is load-bearing on
 * purpose: its failure aborts the run, exactly like the inline sink it
 * replaced.</p>
 */
public interface TracingPort {

    /**
     * Receives one event of the run, in emission order.
     *
     * @param event the event — shared with every other port, never mutated
     */
    void onEvent(RunEvent event);
}
