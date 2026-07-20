package dev.spectroscope.orchestrator;

import dev.spectroscope.core.events.RunEvent;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertSame;

/**
 * The bus as a TracingPort (card 16): a drain loop that feeds a BusPublisher
 * puts a whole agent run on the bus as correctly stamped envelopes — the
 * KONZEPT §4.3 BusPublisher, docked at the core's new tracing seam instead of
 * pumped from the outside.
 */
class BusPublisherTest {

    private static RunEvent delta(String text, long ts) {
        return new RunEvent.TextDelta("main", text, ts);
    }

    @Test
    void publishesEveryEventAsAStampedEnvelope() {
        InMemoryBus bus = new InMemoryBus();
        List<BusEnvelope> seen = new ArrayList<>();
        bus.subscribe(BusEnvelope.topicFor("sess-1"), seen::add);

        BusPublisher publisher = new BusPublisher(bus, "node-a", "sess-1");
        RunEvent first = delta("a", 1);
        RunEvent second = delta("b", 2);
        RunEvent third = delta("c", 3);
        publisher.onEvent(first);
        publisher.onEvent(second);
        publisher.onEvent(third);

        assertEquals(3, seen.size());
        for (BusEnvelope env : seen) {
            assertEquals("node-a", env.sender());
            assertEquals("sess-1", env.contextId());
            assertEquals("sess-1", env.taskId(), "solo sessions ride the degenerate one-task case");
            assertEquals("sess-1.events", env.topic());
        }
        assertEquals(0, seen.get(0).sequence());
        assertEquals(1, seen.get(1).sequence());
        assertEquals(2, seen.get(2).sequence());
        assertEquals(BusEnvelope.CHAIN_ROOT, seen.get(0).parentId());
        assertEquals(seen.get(0).id(), seen.get(1).parentId());
        assertEquals(seen.get(1).id(), seen.get(2).parentId());
        assertSame(first, seen.get(0).payload(), "the payload rides verbatim, never copied");
    }

    @Test
    void aNodeIncarnationStampsItsEpochOnEveryEnvelope() {
        // A node binary passes its process incarnation; a panel lane keeps the
        // degenerate epoch 0 (one incarnation by construction). The epoch is
        // identity, not policy — nothing downstream drops on it.
        InMemoryBus bus = new InMemoryBus();
        List<BusEnvelope> seen = new ArrayList<>();
        bus.subscribe(BusEnvelope.topicFor("sess-1"), seen::add);

        new BusPublisher(bus, "node-a", "sess-1", 7L).onEvent(delta("a", 1));
        new BusPublisher(bus, "node-a", "sess-1").onEvent(delta("b", 2));

        assertEquals(7L, seen.get(0).epoch());
        assertEquals("node-a#7#0", seen.get(0).id());
        assertEquals(0L, seen.get(1).epoch(), "the solo ctor keeps the degenerate epoch");
        assertEquals("node-a#0#0", seen.get(1).id());
    }

    @Test
    void topicFollowsTheSessionIsolationConvention() {
        assertEquals("fleet-4c21.events", BusEnvelope.topicFor("fleet-4c21"));
    }

    @Test
    void sharesTheLanePenSoTheCausalChainStaysUnbroken() {
        InMemoryBus bus = new InMemoryBus();
        List<BusEnvelope> seen = new ArrayList<>();
        bus.subscribe("ctx.events", seen::add);

        // The lane's life: a choreography frame from the pen, the agent's
        // events through the publisher, a closing frame from the pen again —
        // ONE chain, because both write with the same pen.
        EnvelopeStamper pen = new EnvelopeStamper("lane", 0L, "ctx", "ctx.events");
        BusPublisher publisher = new BusPublisher(bus, pen, "task-1");

        bus.publish(pen.stamp("task-1", new RunEvent.AgentMessage(
                "lane", "panel", "status", "working", "lane started", null, 1L)));
        publisher.onEvent(delta("work", 2));
        bus.publish(pen.stamp("task-1", new RunEvent.AgentMessage(
                "lane", "panel", "result", "completed", "completed", null, 3L)));

        assertEquals(3, seen.size());
        assertEquals(List.of(0L, 1L, 2L),
                seen.stream().map(BusEnvelope::sequence).toList());
        assertEquals(BusEnvelope.CHAIN_ROOT, seen.get(0).parentId());
        assertEquals(seen.get(0).id(), seen.get(1).parentId());
        assertEquals(seen.get(1).id(), seen.get(2).parentId());
    }
}
