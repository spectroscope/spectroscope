package dev.spectroscope.core.playbook;

import dev.spectroscope.core.graph.StateGraph;
import dev.spectroscope.core.graph.Topology;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class PlaybookTopologyTest {

    @Test
    void drawsStepsAndDecisionsBetweenStartAndEnd() {
        Playbook p = PlaybookReader.read(PlaybookReaderTest.MINIMAL).playbook();
        Topology t = PlaybookTopology.of(p);
        assertEquals(List.of(StateGraph.START, "write", "ok", StateGraph.END), t.nodes().stream().map(Topology.Node::id).toList());
        assertEquals("write", t.entry());
        assertTrue(t.edges().contains(new Topology.Edge(StateGraph.START, "write", "direct", null)));
        assertTrue(t.edges().contains(new Topology.Edge("write", "ok", "direct", null)));
        assertTrue(t.edges().contains(new Topology.Edge("ok", StateGraph.END, "conditional", "ok")));
        assertTrue(t.edges().contains(new Topology.Edge("ok", "write", "conditional", "ok")), "the loop is drawn, not reversed");
        assertEquals(1, t.branches().size());
        assertEquals("ok", t.branches().get(0).source());
        assertEquals(Topology.SCHEMA_VERSION, t.schemaVersion());
    }
}
