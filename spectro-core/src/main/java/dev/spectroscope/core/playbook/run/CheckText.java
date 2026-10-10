package dev.spectroscope.core.playbook.run;

import dev.spectroscope.core.playbook.Playbook;

import java.util.ArrayList;
import java.util.List;

/** A check in words, for the step prompt's "Done when" line. */
public final class CheckText {

    private CheckText() {
    }

    /**
     * @param p the playbook
     * @param d the decision
     * @return the decision's name, a colon and what its check asks
     */
    public static String describe(Playbook p, Playbook.Decision d) {
        Playbook.Check c = p.checks().get(d.check());
        String what = switch (c.kind()) {
            case "sections" -> names(p, c.documents()) + " has the sections "
                    + String.join(", ", sectionsOf(p, c.documents())) + ", each with text";
            case "open_items" -> names(p, c.documents()) + " has no unchecked boxes";
            case "command" -> "the command " + CommandCheck.substitute(c.run(), p.vars()) + " exits 0";
            case "review" -> "a reviewer answers " + String.join(" or ", labels(c));
            case "human" -> "a person answers: " + c.ask();
            default -> c.kind();
        };
        return d.name() + ": " + what;
    }

    /**
     * @param p the playbook
     * @param s the step
     * @return one line per decision the step's arrow leads to; empty when it leads elsewhere
     */
    public static List<String> doneWhen(Playbook p, Playbook.Step s) {
        List<String> out = new ArrayList<>();
        Playbook.Arrow a = PlaybookWalk.arrowFrom(p, s.id(), null);
        if (a != null) {
            for (Playbook.Node n : p.nodes()) {
                if (n instanceof Playbook.Decision d && d.id().equals(a.to())) {
                    out.add(describe(p, d));
                }
            }
        }
        return out;
    }

    static List<String> labels(Playbook.Check c) {
        return c.labels().isEmpty() ? List.of("pass", "fail") : c.labels();
    }

    private static String names(Playbook p, List<String> ids) {
        return String.join(", ", ids.stream().map(id -> p.documents().get(id).name()).toList());
    }

    private static List<String> sectionsOf(Playbook p, List<String> ids) {
        List<String> out = new ArrayList<>();
        ids.forEach(id -> out.addAll(p.documents().get(id).sections()));
        return out;
    }
}
