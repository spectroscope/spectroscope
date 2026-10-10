package dev.spectroscope.core.playbook.run;

import dev.spectroscope.core.playbook.Playbook;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;

/** Walks over a playbook's arrows: the forward path for the plan, reachability for loops. */
public final class PlaybookWalk {

    private PlaybookWalk() {
    }

    /** @param p the playbook; @return the ids of its end nodes */
    public static Set<String> endIds(Playbook p) {
        Set<String> out = new LinkedHashSet<>();
        for (Playbook.Node n : p.nodes()) {
            if (n instanceof Playbook.End) {
                out.add(n.id());
            }
        }
        return out;
    }

    /**
     * A depth first walk from start over arrows in file order; every step and
     * decision once, ends left out.
     *
     * @param p the playbook
     * @return the node ids in the order the plan lists them
     */
    public static List<String> forwardPath(Playbook p) {
        Set<String> ends = endIds(p);
        List<String> out = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        Deque<String> stack = new ArrayDeque<>();
        stack.push(p.start());
        while (!stack.isEmpty()) {
            String id = stack.pop();
            if (ends.contains(id) || !seen.add(id)) {
                continue;
            }
            out.add(id);
            List<Playbook.Arrow> next = arrowsFrom(p, id);
            for (int i = next.size() - 1; i >= 0; i--) {
                stack.push(next.get(i).to());
            }
        }
        return List.copyOf(out);
    }

    /**
     * @param p    the playbook
     * @param from where to start
     * @param to   the node looked for
     * @return true when an arrow path leads from {@code from} to {@code to}; a node reaches itself
     */
    public static boolean canReach(Playbook p, String from, String to) {
        Set<String> seen = new HashSet<>();
        Deque<String> queue = new ArrayDeque<>(List.of(from));
        while (!queue.isEmpty()) {
            String id = queue.poll();
            if (id.equals(to)) {
                return true;
            }
            if (seen.add(id)) {
                arrowsFrom(p, id).forEach(a -> queue.add(a.to()));
            }
        }
        return false;
    }

    /**
     * Whether a decision's outcome is a round of the decision's own loop. The
     * loop's head is whichever of the decision and the target comes first in
     * {@link #forwardPath}; the outcome is a round when the target reaches the
     * decision again without passing a node before that head. An outcome that
     * only comes back through an outer loop, such as a passed task review that
     * returns through the question whether tasks are left, is a forward exit.
     *
     * @param p        the playbook
     * @param decision the decision taking the outcome
     * @param to       the target of the outcome's arrow
     * @return true for a round of the decision's own loop
     */
    public static boolean isRound(Playbook p, String decision, String to) {
        List<String> order = forwardPath(p);
        if (!order.contains(to)) {
            return false; // an end
        }
        int head = Math.min(order.indexOf(decision), order.indexOf(to));
        Set<String> seen = new HashSet<>();
        Deque<String> queue = new ArrayDeque<>(List.of(to));
        while (!queue.isEmpty()) {
            String id = queue.poll();
            if (id.equals(decision)) {
                return true;
            }
            if (order.indexOf(id) >= head && seen.add(id)) {
                arrowsFrom(p, id).forEach(a -> queue.add(a.to()));
            }
        }
        return false;
    }

    /**
     * @param p  the playbook
     * @param id the source node
     * @param on the outcome label, or null for a step's one arrow
     * @return the arrow, or null when there is none
     */
    public static Playbook.Arrow arrowFrom(Playbook p, String id, String on) {
        for (Playbook.Arrow a : p.arrows()) {
            if (a.from().equals(id) && Objects.equals(a.on(), on)) {
                return a;
            }
        }
        return null;
    }

    /** @param p the playbook; @param id the source; @return its arrows in file order */
    public static List<Playbook.Arrow> arrowsFrom(Playbook p, String id) {
        return p.arrows().stream().filter(a -> a.from().equals(id)).toList();
    }
}
