package dev.spectroscope.core.playbook;

import dev.spectroscope.core.graph.StateGraph;
import dev.spectroscope.core.graph.Topology;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/** A playbook as the engine's drawing record, so the web draws it with the state graph layout. */
public final class PlaybookTopology {

    private PlaybookTopology() {
    }

    public static Topology of(Playbook p) {
        Set<String> ends = new LinkedHashSet<>();
        List<Topology.Node> nodes = new ArrayList<>();
        nodes.add(new Topology.Node(StateGraph.START, StateGraph.START));
        for (Playbook.Node n : p.nodes()) {
            if (n instanceof Playbook.End) {
                ends.add(n.id());
            } else if (n instanceof Playbook.Step s) {
                nodes.add(new Topology.Node(s.id(), s.name()));
            } else if (n instanceof Playbook.Decision d) {
                nodes.add(new Topology.Node(d.id(), d.name()));
            }
        }
        nodes.add(new Topology.Node(StateGraph.END, StateGraph.END));
        List<Topology.Edge> edges = new ArrayList<>();
        edges.add(new Topology.Edge(StateGraph.START, p.start(), "direct", null));
        List<Topology.Branch> branches = new ArrayList<>();
        for (Playbook.Node n : p.nodes()) {
            if (n instanceof Playbook.Decision d) {
                List<String> targets = new ArrayList<>();
                for (Playbook.Arrow a : p.arrows()) {
                    if (a.from().equals(d.id())) {
                        String to = ends.contains(a.to()) ? StateGraph.END : a.to();
                        edges.add(new Topology.Edge(d.id(), to, "conditional", d.id()));
                        if (!targets.contains(to)) {
                            targets.add(to);
                        }
                    }
                }
                branches.add(new Topology.Branch(d.id(), d.id(), List.copyOf(targets)));
            } else if (n instanceof Playbook.Step s) {
                for (Playbook.Arrow a : p.arrows()) {
                    if (a.from().equals(s.id())) {
                        edges.add(new Topology.Edge(s.id(), ends.contains(a.to()) ? StateGraph.END : a.to(), "direct", null));
                    }
                }
            }
        }
        return new Topology(Topology.SCHEMA_VERSION, p.start(), List.copyOf(nodes), List.copyOf(edges), List.copyOf(branches));
    }
}
