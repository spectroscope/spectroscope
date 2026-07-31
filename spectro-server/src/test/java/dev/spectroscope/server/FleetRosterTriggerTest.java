package dev.spectroscope.server;

import dev.spectroscope.orchestrator.NodeCard;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

/**
 * Card 72: a waiting node's trigger note reaches the fleet faces. The roster
 * JSON is hand-mapped (REST and socket share {@link FleetAggregator#nodeJson}),
 * so the additive card field must be mapped explicitly — and only when
 * present, keeping the pre-card-72 shape for every plain node.
 */
class FleetRosterTriggerTest {

    @Test
    void theRosterJsonCarriesTheTriggerNoteOnlyWhenPresent() {
        FleetAggregator.NodeState waiting = new FleetAggregator.NodeState(
                new NodeCard("n1", "worker", List.of(), "t.events", "watch:/drop"), true, 5L);
        Map<String, Object> withNote = FleetAggregator.nodeJson(waiting);
        assertEquals("watch:/drop", withNote.get("trigger"),
                "a standing node tells the fleet what it waits on");

        FleetAggregator.NodeState plain = new FleetAggregator.NodeState(
                new NodeCard("n2", "worker", List.of(), "t.events"), true, 5L);
        assertFalse(FleetAggregator.nodeJson(plain).containsKey("trigger"),
                "absent stays absent — a plain node's roster shape is unchanged");
    }
}
