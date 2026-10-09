package dev.spectroscope.core.playbook;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** The structural rules of a playbook (spec rules 1 to 7). Every finding names a path. */
public final class PlaybookValidator {

    private PlaybookValidator() {
    }

    static final Pattern ID = Pattern.compile("[a-z][a-z0-9-]*");
    static final Pattern VAR = Pattern.compile("\\{([a-z][a-z0-9_]*)}");
    static final Set<String> LOCATION_VARS = Set.of("date", "slug", "n");
    static final Set<String> PERFORMERS = Set.of("chat", "child");
    static final Set<String> ROLES = Set.of("explore", "worker", "research");
    static final Set<String> PRIVACY = Set.of("private", "cheap");
    static final Set<String> PERMISSIONS = Set.of("inherit", "readonly", "ask", "auto");
    static final Set<String> CHECK_KINDS = Set.of("sections", "open_items", "command", "review", "human");

    public static List<Finding> validate(Playbook p) {
        List<Finding> out = new ArrayList<>();
        if (p.schemaVersion() != 1) {
            out.add(new Finding("schema_version", "must be 1"));
        }
        if (!ID.matcher(p.id()).matches()) {
            out.add(new Finding("id", "must match [a-z][a-z0-9-]*"));
        }
        Map<String, Integer> index = new HashMap<>();
        for (int i = 0; i < p.nodes().size(); i++) {
            Playbook.Node n = p.nodes().get(i);
            if (index.containsKey(n.id())) {
                out.add(new Finding("nodes[" + i + "].id", "duplicate id " + n.id()));
            }
            index.put(n.id(), i);
        }
        if (!index.containsKey(p.start())) {
            out.add(new Finding("start", "names no node: " + p.start()));
        }
        // rule 5 and 6 per node
        for (int i = 0; i < p.nodes().size(); i++) {
            String at = "nodes[" + i + "]";
            Playbook.Node n = p.nodes().get(i);
            if (n instanceof Playbook.Step s) {
                if (s.model() != null && !p.models().containsKey(s.model())) {
                    out.add(new Finding(at + ".model", "unknown model choice " + s.model()));
                }
                for (String d : s.consumes()) {
                    if (!p.documents().containsKey(d)) out.add(new Finding(at + ".consumes", "unknown document " + d));
                }
                for (String d : s.produces()) {
                    if (!p.documents().containsKey(d)) out.add(new Finding(at + ".produces", "unknown document " + d));
                }
                if (!PERFORMERS.contains(s.performer())) out.add(new Finding(at + ".performer", "must be chat or child"));
                if ("child".equals(s.performer()) && (s.role() == null || !ROLES.contains(s.role()))) {
                    out.add(new Finding(at + ".role", "a child step needs a role: explore, worker or research"));
                }
                if (!PRIVACY.contains(s.privacy())) out.add(new Finding(at + ".privacy", "must be private or cheap"));
                if ("extended".equals(s.permission()) || !PERMISSIONS.contains(s.permission())) {
                    out.add(new Finding(at + ".permission", "extended is never allowed from a playbook; use inherit, readonly, ask or auto"));
                }
                for (String skill : s.skills()) {
                    if (skill == null || skill.isBlank()) out.add(new Finding(at + ".skills", "empty skill name"));
                }
            } else if (n instanceof Playbook.Decision d) {
                if (!p.checks().containsKey(d.check())) {
                    out.add(new Finding(at + ".check", "unknown check " + d.check()));
                }
            }
        }
        // checks
        p.checks().forEach((name, c) -> {
            String at = "checks." + name;
            if (!CHECK_KINDS.contains(c.kind())) out.add(new Finding(at + ".kind", "unknown check kind " + c.kind()));
            for (String d : c.documents()) {
                if (!p.documents().containsKey(d)) out.add(new Finding(at + ".documents", "unknown document " + d));
            }
            if ("command".equals(c.kind())) {
                if (c.run() == null) out.add(new Finding(at + ".run", "a command check needs run"));
                else undeclared(c.run(), p.vars().keySet(), Set.of()).forEach(v ->
                        out.add(new Finding(at + ".run", "undeclared var " + v)));
            }
            if ("review".equals(c.kind()) && (c.model() == null || !p.models().containsKey(c.model()))) {
                out.add(new Finding(at + ".model", "a review check needs a model choice"));
            }
            if ("human".equals(c.kind()) && c.ask() == null) out.add(new Finding(at + ".ask", "a human check needs ask"));
        });
        p.documents().forEach((name, d) -> undeclared(d.location(), p.vars().keySet(), LOCATION_VARS).forEach(v ->
                out.add(new Finding("documents." + name + ".location", "undeclared var " + v))));
        // rule 3: one arrow per outcome
        Map<String, List<Integer>> arrowsFrom = new HashMap<>();
        for (int j = 0; j < p.arrows().size(); j++) {
            Playbook.Arrow a = p.arrows().get(j);
            if (!index.containsKey(a.from())) out.add(new Finding("arrows[" + j + "].from", "names no node: " + a.from()));
            if (!index.containsKey(a.to())) out.add(new Finding("arrows[" + j + "].to", "names no node: " + a.to()));
            arrowsFrom.computeIfAbsent(a.from(), k -> new ArrayList<>()).add(j);
        }
        for (int i = 0; i < p.nodes().size(); i++) {
            Playbook.Node n = p.nodes().get(i);
            Set<String> outcomes = outcomesOf(p, n);
            Set<String> seen = new HashSet<>();
            for (int j : arrowsFrom.getOrDefault(n.id(), List.of())) {
                String on = p.arrows().get(j).on() == null ? "" : p.arrows().get(j).on();
                if (!outcomes.contains(on)) {
                    out.add(new Finding("arrows[" + j + "]", n.id() + " has no outcome " + (on.isEmpty() ? "(unlabelled)" : on)));
                } else if (!seen.add(on)) {
                    out.add(new Finding("arrows[" + j + "]", "second arrow for outcome " + on + " out of " + n.id()));
                }
            }
            for (String o : outcomes) {
                if (!seen.contains(o)) out.add(new Finding("nodes[" + i + "]", "no arrow for outcome " + (o.isEmpty() ? "(unlabelled)" : o)));
            }
        }
        // rule 2: reachability both ways
        if (index.containsKey(p.start())) {
            Set<String> fromStart = reach(p, p.start());
            for (int i = 0; i < p.nodes().size(); i++) {
                if (!fromStart.contains(p.nodes().get(i).id())) out.add(new Finding("nodes[" + i + "]", "not reachable from start"));
            }
            for (int i = 0; i < p.nodes().size(); i++) {
                Playbook.Node n = p.nodes().get(i);
                if (n instanceof Playbook.End) continue;
                boolean endReachable = reach(p, n.id()).stream().filter(index::containsKey)
                        .anyMatch(id -> p.nodes().get(index.get(id)) instanceof Playbook.End);
                if (!endReachable) out.add(new Finding("nodes[" + i + "]", "cannot reach an end"));
            }
        }
        // rule 4: every back arrow passes a decision with max_rounds
        for (int j = 0; j < p.arrows().size(); j++) {
            Playbook.Arrow a = p.arrows().get(j);
            if (!index.containsKey(a.from()) || !index.containsKey(a.to())) continue;
            if (!canReach(p, a.to(), a.from())) continue; // not a loop
            boolean ceiling = loopNodes(p, a.to(), a.from()).stream()
                    .filter(index::containsKey)
                    .map(id -> p.nodes().get(index.get(id)))
                    .anyMatch(n -> n instanceof Playbook.Decision d && d.maxRounds() != null && d.maxRounds() > 0);
            if (!ceiling) out.add(new Finding("arrows[" + j + "]", "a loop from " + a.from() + " back to " + a.to()
                    + " passes no decision with max_rounds"));
        }
        return List.copyOf(out);
    }

    /** The outcomes a node can leave by, in order: a step's one unlabelled outcome is the empty string. */
    public static Set<String> outcomesOf(Playbook p, Playbook.Node n) {
        if (n instanceof Playbook.End) return Set.of();
        if (n instanceof Playbook.Step) return Set.of("");
        Playbook.Decision d = (Playbook.Decision) n;
        Set<String> out = new LinkedHashSet<>();
        if (!d.outcomes().isEmpty()) {
            out.addAll(d.outcomes());
        } else {
            Playbook.Check c = p.checks().get(d.check());
            if (c != null && (("review".equals(c.kind()) || "human".equals(c.kind())) && !c.labels().isEmpty())) {
                out.addAll(c.labels());
            } else {
                out.add("pass");
                out.add("fail");
            }
        }
        if (d.maxRounds() != null) out.add("exhausted");
        return out;
    }

    static Set<String> reach(Playbook p, String from) {
        Set<String> seen = new LinkedHashSet<>();
        Deque<String> todo = new ArrayDeque<>();
        todo.add(from);
        while (!todo.isEmpty()) {
            String id = todo.poll();
            if (!seen.add(id)) continue;
            for (Playbook.Arrow a : p.arrows()) {
                if (a.from().equals(id)) todo.add(a.to());
            }
        }
        return seen;
    }

    static boolean canReach(Playbook p, String from, String to) {
        return reach(p, from).contains(to);
    }

    /** The nodes on any path from {@code from} to {@code to}, {@code to} included. */
    static Set<String> loopNodes(Playbook p, String from, String to) {
        Set<String> forward = reach(p, from);
        Set<String> out = new LinkedHashSet<>();
        for (String id : forward) {
            if (canReach(p, id, to)) out.add(id);
        }
        return out;
    }

    static List<String> undeclared(String text, Set<String> vars, Set<String> builtIn) {
        List<String> out = new ArrayList<>();
        if (text == null) return out;
        Matcher m = VAR.matcher(text);
        while (m.find()) {
            String v = m.group(1);
            if (!vars.contains(v) && !builtIn.contains(v)) out.add(v);
        }
        return out;
    }
}
