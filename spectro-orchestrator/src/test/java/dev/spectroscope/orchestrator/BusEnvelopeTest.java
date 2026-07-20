package dev.spectroscope.orchestrator;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.events.RunEvent;
import org.junit.jupiter.api.Test;

import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** The envelope's whole promise: wrap the event, never rewrite it. */
class BusEnvelopeTest {

    private final ObjectMapper mapper = new ObjectMapper();

    private static BusEnvelope sample() {
        return new BusEnvelope("worker-1", "fleet-1", "task-7f3a", 42, "worker-1#41",
                "fleet-1.events", 1721400000000L,
                new RunEvent.AgentMessage("worker-1", "panel", "status", "working",
                        "checking queries", null, 1721400000000L));
    }

    @Test
    void theLineCarriesThePayloadVerbatim() throws Exception {
        BusEnvelope env = sample();
        String line = env.toLine(mapper);
        String payloadJson = mapper.writeValueAsString(mapper.valueToTree(env.payload()));
        assertTrue(line.contains(payloadJson),
                "the envelope adds AROUND the event; the event's own JSON stays intact");
    }

    @Test
    void roundTripsThroughTheWire() {
        BusEnvelope env = sample();
        BusEnvelope back = BusEnvelope.fromLine(env.toLine(mapper), mapper);
        assertEquals(env, back);
        assertEquals("worker-1#42", back.id());
    }

    @Test
    void inMemoryBusIsolatesTopicsAndUnsubscribes() throws Exception {
        InMemoryBus bus = new InMemoryBus();
        AtomicInteger a = new AtomicInteger();
        AtomicInteger b = new AtomicInteger();
        AutoCloseable subA = bus.subscribe("fleet-1.events", f -> a.incrementAndGet());
        bus.subscribe("fleet-2.events", f -> b.incrementAndGet());

        bus.publish(sample()); // topic fleet-1.events
        assertEquals(1, a.get());
        assertEquals(0, b.get());

        subA.close();
        bus.publish(sample());
        assertEquals(1, a.get(), "closed subscriptions stay silent");
    }
}
