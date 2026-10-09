package dev.spectroscope.core.playbook;

import com.fasterxml.jackson.core.io.JsonStringEncoder;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;

/**
 * Writes a playbook in its one canonical form (P4 spec, "The canonical form"):
 * fixed key order per record, map entries in document order, nulls and empty
 * optional lists omitted, defaults written, arrows and model references on one
 * line. The reader cannot tell an absent default from a written one, so
 * writing defaults is what makes write(read(f)) equal f.
 */
public final class PlaybookWriter {

    private PlaybookWriter() {
    }

    private sealed interface V permits Lit, Obj, Arr {
    }

    private record Lit(String text) implements V {
    }

    private record Obj(Map<String, V> fields, boolean inline) implements V {
    }

    private record Arr(List<? extends V> items) implements V {
    }

    /** The canonical text of {@code p}: UTF-8 content, LF line ends, two space indent, one trailing newline. */
    public static String write(Playbook p) {
        StringBuilder out = new StringBuilder();
        render(top(p), 0, out);
        return out.append('\n').toString();
    }

    private static Lit str(String s) {
        return new Lit('"' + new String(JsonStringEncoder.getInstance().quoteAsString(s)) + '"');
    }

    private static Arr strings(List<String> list) {
        return new Arr(list.stream().map(PlaybookWriter::str).toList());
    }

    private static <T> Obj map(Map<String, T> m, Function<T, V> f) {
        Map<String, V> out = new LinkedHashMap<>();
        m.forEach((k, v) -> out.put(k, f.apply(v)));
        return new Obj(out, false);
    }

    private static Obj ref(Playbook.ModelRef r) {
        Map<String, V> f = new LinkedHashMap<>();
        f.put("provider", str(r.provider()));
        f.put("model", str(r.model()));
        return new Obj(f, true);
    }

    private static void putIf(Map<String, V> f, String key, String value) {
        if (value != null) f.put(key, str(value));
    }

    private static void putIfAny(Map<String, V> f, String key, List<String> value) {
        if (value != null && !value.isEmpty()) f.put(key, strings(value));
    }

    private static Obj top(Playbook p) {
        Map<String, V> f = new LinkedHashMap<>();
        f.put("schema_version", new Lit(Integer.toString(p.schemaVersion())));
        f.put("id", str(p.id()));
        f.put("name", str(p.name()));
        f.put("description", str(p.description()));
        f.put("models", map(p.models(), m -> {
            Map<String, V> c = new LinkedHashMap<>();
            c.put("primary", ref(m.primary()));
            c.put("fallbacks", new Arr(m.fallbacks().stream().map(PlaybookWriter::ref).toList()));
            return new Obj(c, false);
        }));
        f.put("documents", map(p.documents(), d -> {
            Map<String, V> c = new LinkedHashMap<>();
            c.put("name", str(d.name()));
            c.put("purpose", str(d.purpose()));
            c.put("location", str(d.location()));
            putIf(c, "template", d.template());
            c.put("sections", strings(d.sections()));
            return new Obj(c, false);
        }));
        f.put("checks", map(p.checks(), k -> {
            Map<String, V> c = new LinkedHashMap<>();
            c.put("kind", str(k.kind()));
            putIfAny(c, "documents", k.documents());
            putIfAny(c, "forbid", k.forbid());
            putIf(c, "run", k.run());
            putIf(c, "model", k.model());
            putIfAny(c, "reads", k.reads());
            putIf(c, "ask", k.ask());
            putIfAny(c, "labels", k.labels());
            return new Obj(c, false);
        }));
        f.put("vars", map(p.vars(), PlaybookWriter::str));
        f.put("start", str(p.start()));
        f.put("nodes", new Arr(p.nodes().stream().map(PlaybookWriter::node).toList()));
        f.put("arrows", new Arr(p.arrows().stream().map(PlaybookWriter::arrow).toList()));
        Map<String, V> c = new LinkedHashMap<>();
        c.put("skills", strings(p.contents().skills()));
        c.put("agents", strings(p.contents().agents()));
        c.put("hooks", strings(p.contents().hooks()));
        c.put("commands", strings(p.contents().commands()));
        c.put("workflows", strings(p.contents().workflows()));
        f.put("contents", new Obj(c, false));
        return new Obj(f, false);
    }

    private static Obj node(Playbook.Node n) {
        Map<String, V> f = new LinkedHashMap<>();
        f.put("kind", str(n.kind()));
        f.put("id", str(n.id()));
        switch (n) {
            case Playbook.Step s -> {
                f.put("name", str(s.name()));
                putIf(f, "goal", s.goal());
                f.put("performer", str(s.performer()));
                putIf(f, "role", s.role());
                f.put("skills", strings(s.skills()));
                putIf(f, "model", s.model());
                f.put("privacy", str(s.privacy()));
                f.put("permission", str(s.permission()));
                f.put("consumes", strings(s.consumes()));
                f.put("produces", strings(s.produces()));
                f.put("nod", new Lit(Boolean.toString(s.nod())));
            }
            case Playbook.Decision d -> {
                f.put("name", str(d.name()));
                f.put("check", str(d.check()));
                putIfAny(f, "outcomes", d.outcomes());
                if (d.maxRounds() != null) f.put("max_rounds", new Lit(Integer.toString(d.maxRounds())));
            }
            case Playbook.End e -> f.put("result", str(e.result()));
        }
        return new Obj(f, false);
    }

    private static Obj arrow(Playbook.Arrow a) {
        Map<String, V> f = new LinkedHashMap<>();
        f.put("from", str(a.from()));
        f.put("to", str(a.to()));
        putIf(f, "on", a.on());
        return new Obj(f, true);
    }

    private static StringBuilder indent(int depth, StringBuilder out) {
        return out.append("  ".repeat(depth));
    }

    private static void render(V v, int depth, StringBuilder out) {
        switch (v) {
            case Lit l -> out.append(l.text());
            case Obj o when o.fields().isEmpty() -> out.append("{}");
            case Obj o when o.inline() -> {
                out.append("{ ");
                int i = 0;
                for (Map.Entry<String, V> e : o.fields().entrySet()) {
                    if (i++ > 0) out.append(", ");
                    out.append(str(e.getKey()).text()).append(": ");
                    render(e.getValue(), depth, out);
                }
                out.append(" }");
            }
            case Obj o -> {
                out.append("{\n");
                int i = 0;
                for (Map.Entry<String, V> e : o.fields().entrySet()) {
                    if (i++ > 0) out.append(",\n");
                    indent(depth + 1, out).append(str(e.getKey()).text()).append(": ");
                    render(e.getValue(), depth + 1, out);
                }
                out.append('\n');
                indent(depth, out).append('}');
            }
            case Arr a when a.items().isEmpty() -> out.append("[]");
            case Arr a when a.items().stream().allMatch(x -> x instanceof Lit) -> {
                out.append('[');
                for (int i = 0; i < a.items().size(); i++) {
                    if (i > 0) out.append(", ");
                    render(a.items().get(i), depth, out);
                }
                out.append(']');
            }
            case Arr a -> {
                out.append("[\n");
                for (int i = 0; i < a.items().size(); i++) {
                    if (i > 0) out.append(",\n");
                    indent(depth + 1, out);
                    render(a.items().get(i), depth + 1, out);
                }
                out.append('\n');
                indent(depth, out).append(']');
            }
        }
    }
}
