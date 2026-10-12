package dev.spectroscope.core.playbook;

import com.fasterxml.jackson.core.io.JsonStringEncoder;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.util.Iterator;
import java.util.Map;

/**
 * Card 506: writes a {@link Workflow} back as text, in the canonical shape
 * (one {@code kind} field per step) or in the scenario DSL's shape (one key
 * per step). Fixed key order, fields the file did not carry left out, two
 * space indent, LF line ends, one trailing newline. Reading either text gives
 * the same workflow again, which is what "converts without loss" means.
 */
public final class WorkflowWriter {

    private static final JsonNodeFactory NODES = JsonNodeFactory.instance;

    private WorkflowWriter() {
    }

    /** @param w a workflow @return its canonical text */
    public static String write(Workflow w) {
        return render(tree(w, false));
    }

    /** @param w a workflow @return its text in the scenario DSL's shape */
    public static String toScenarioShape(Workflow w) {
        return render(tree(w, true));
    }

    static ObjectNode tree(Workflow w, boolean scenario) {
        ObjectNode top = NODES.objectNode();
        top.put("name", w.name());
        if (w.description() != null) {
            top.put("description", w.description());
        }
        ArrayNode steps = top.putArray("steps");
        for (Workflow.Step s : w.steps()) {
            steps.add(scenario ? keyed(s) : canonical(s));
        }
        return top;
    }

    private static ObjectNode canonical(Workflow.Step s) {
        ObjectNode n = NODES.objectNode();
        switch (s) {
            case Workflow.Prompt p -> {
                n.put("kind", "prompt");
                id(n, p);
                n.set("template", text(p.template()));
                rounds(n, p.repeatUntil(), p.maxRounds());
            }
            case Workflow.Fanout f -> {
                n.put("kind", "fanout");
                id(n, f);
                fanoutFields(n, f);
                rounds(n, f.repeatUntil(), f.maxRounds());
            }
            case Workflow.End e -> {
                n.put("kind", "end");
                id(n, e);
                if (e.result() != null) {
                    n.put("result", e.result());
                }
            }
        }
        return n;
    }

    private static ObjectNode keyed(Workflow.Step s) {
        ObjectNode n = NODES.objectNode();
        switch (s) {
            case Workflow.Prompt p -> {
                n.set("prompt", text(p.template()));
                id(n, p);
                rounds(n, p.repeatUntil(), p.maxRounds());
            }
            case Workflow.Fanout f -> {
                fanoutFields(n.putObject("fanout"), f);
                id(n, f);
                rounds(n, f.repeatUntil(), f.maxRounds());
            }
            case Workflow.End e -> {
                ObjectNode end = n.putObject("end");
                if (e.result() != null) {
                    end.put("result", e.result());
                }
                id(n, e);
            }
        }
        return n;
    }

    private static void fanoutFields(ObjectNode n, Workflow.Fanout f) {
        if (f.label() != null) {
            n.put("label", f.label());
        }
        if (f.tool() != null) {
            n.put("tool", f.tool());
        }
        ArrayNode agents = n.putArray("agents");
        for (Workflow.Agent a : f.agents()) {
            ObjectNode o = agents.addObject();
            if (a.id() != null) {
                o.put("id", a.id());
            }
            if (a.role() != null) {
                o.put("role", a.role());
            }
            o.set("task", text(a.task()));
            if (a.steps() != null) {
                o.set("steps", a.steps().deepCopy());
            }
        }
        if (f.join() != null) {
            ObjectNode j = n.putObject("join");
            if (f.join().role() != null) {
                j.put("role", f.join().role());
            }
            j.set("task", text(f.join().task()));
        }
    }

    private static void id(ObjectNode n, Workflow.Step s) {
        if (s.idGiven()) {
            n.put("id", s.id());
        }
    }

    private static void rounds(ObjectNode n, String until, Integer max) {
        if (until != null) {
            n.put("repeat_until", until);
        }
        if (max != null) {
            n.put("max_rounds", max);
        }
    }

    private static JsonNode text(Workflow.Text t) {
        if (t.plain() != null) {
            return NODES.textNode(t.plain());
        }
        ObjectNode o = NODES.objectNode();
        o.put("en", t.en());
        o.put("de", t.de());
        return o;
    }

    private static String render(JsonNode node) {
        StringBuilder out = new StringBuilder();
        render(node, 0, out);
        return out.append('\n').toString();
    }

    private static void render(JsonNode node, int depth, StringBuilder out) {
        if (node.isObject()) {
            if (node.isEmpty()) {
                out.append("{}");
                return;
            }
            out.append("{\n");
            Iterator<Map.Entry<String, JsonNode>> fields = node.fields();
            while (fields.hasNext()) {
                Map.Entry<String, JsonNode> f = fields.next();
                indent(depth + 1, out).append(quote(f.getKey())).append(": ");
                render(f.getValue(), depth + 1, out);
                out.append(fields.hasNext() ? ",\n" : "\n");
            }
            indent(depth, out).append('}');
        } else if (node.isArray()) {
            if (node.isEmpty()) {
                out.append("[]");
                return;
            }
            out.append("[\n");
            for (int i = 0; i < node.size(); i++) {
                indent(depth + 1, out);
                render(node.get(i), depth + 1, out);
                out.append(i < node.size() - 1 ? ",\n" : "\n");
            }
            indent(depth, out).append(']');
        } else if (node.isTextual()) {
            out.append(quote(node.asText()));
        } else {
            out.append(node.toString());
        }
    }

    private static String quote(String s) {
        return '"' + new String(JsonStringEncoder.getInstance().quoteAsString(s)) + '"';
    }

    private static StringBuilder indent(int depth, StringBuilder out) {
        return out.append("  ".repeat(depth));
    }
}
