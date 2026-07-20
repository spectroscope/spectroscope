package dev.spectroscope.orchestrator;

import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.trace.TracingPort;

import java.util.Objects;

/**
 * The bus as a {@link TracingPort} (KONZEPT §4.3): whoever drains an agent's
 * events — a CLI, a server connection, a panel lane — registers this port and
 * the whole run rides the bus as stamped envelopes. Deliberately thin and
 * non-swallowing: isolation is the registry's job
 * ({@code TracingPorts.register}), a direct caller gets the transport's raw
 * failure behaviour on purpose (a lane whose bus dies must fail loudly, the
 * autogen trap).
 */
public final class BusPublisher implements TracingPort {

    private final BusTransport bus;
    private final EnvelopeStamper pen;
    private final String taskId;

    /**
     * The solo-session form: one node, one context, the degenerate one-task
     * case ({@code taskId = contextId}, like the panel's own frames).
     *
     * @param bus       the transport every envelope rides
     * @param sender    the publishing node's agent id
     * @param contextId the session — also the topic root and the taskId
     */
    public BusPublisher(BusTransport bus, String sender, String contextId) {
        this(bus, new EnvelopeStamper(sender, contextId, BusEnvelope.topicFor(contextId)), contextId);
    }

    /**
     * The panel-lane form: share the lane's pen so choreography frames and
     * pumped agent events stay ONE causal chain per sender.
     *
     * @param bus    the transport every envelope rides
     * @param pen    the lane's stamper — shared, not owned
     * @param taskId the assignment every published event belongs to
     */
    BusPublisher(BusTransport bus, EnvelopeStamper pen, String taskId) {
        this.bus = Objects.requireNonNull(bus, "bus");
        this.pen = Objects.requireNonNull(pen, "pen");
        this.taskId = Objects.requireNonNull(taskId, "taskId");
    }

    @Override
    public void onEvent(RunEvent event) {
        bus.publish(pen.stamp(taskId, event));
    }
}
