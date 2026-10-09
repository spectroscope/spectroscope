package dev.spectroscope.core.playbook;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Reads playbook.json into {@link Playbook}, naming every field it does not
 * know and refusing every field a shared folder may not carry. The tree is
 * walked by hand rather than bound, so a finding can carry the JSON path a
 * person can go and look at. Refused names are searched in the whole tree,
 * including {@code vars} and the inside of unknown fields, before anything
 * is read.
 */
public final class PlaybookReader {

    public record Read(Playbook playbook, List<Finding> findings) {}

    private static final ObjectMapper JSON = new ObjectMapper();

    /** Fields a playbook may never carry: they route material or widen rights. */
    static final Set<String> REFUSED = Set.of("apiKey", "key", "baseUrl", "endpoint", "address", "hooks",
            "mcpServers", "autoApprove");
    static final Set<String> RESERVED_KINDS = Set.of("split", "join");
    static final Set<String> RESERVED_STEP_FIELDS = Set.of("fallback_chain", "sub_playbook");

    static final Set<String> TOP = Set.of("schema_version", "id", "name", "description", "models", "documents",
            "checks", "vars", "start", "nodes", "arrows", "contents");
    static final Set<String> STEP = Set.of("kind", "id", "name", "goal", "performer", "role", "skills", "model",
            "privacy", "permission", "consumes", "produces", "nod");
    static final Set<String> DECISION = Set.of("kind", "id", "name", "check", "outcomes", "max_rounds");
    static final Set<String> END = Set.of("kind", "id", "result");
    static final Set<String> ARROW = Set.of("from", "to", "on");
    static final Set<String> MODEL_CHOICE = Set.of("primary", "fallbacks");
    static final Set<String> MODEL_REF = Set.of("provider", "model");
    static final Set<String> DOCUMENT = Set.of("name", "purpose", "location", "template", "sections");
    static final Set<String> CHECK = Set.of("kind", "documents", "forbid", "run", "model", "reads", "ask", "labels");
    static final Set<String> CONTENTS = Set.of("skills", "agents", "hooks", "commands", "workflows");

    private final List<Finding> findings = new ArrayList<>();
    private boolean refused;

    private PlaybookReader() {
    }

    public static Read read(String json) {
        PlaybookReader r = new PlaybookReader();
        JsonNode root;
        try {
            root = JSON.readTree(json);
        } catch (Exception malformed) {
            return new Read(null, List.of(new Finding("", "not JSON: " + malformed.getMessage())));
        }
        if (root == null || !root.isObject()) {
            return new Read(null, List.of(new Finding("", "the playbook must be a JSON object")));
        }
        r.refuseAnywhere(root, "");
        Playbook p = r.playbook(root);
        return new Read(r.refused ? null : p, List.copyOf(r.findings));
    }

    private void unknown(JsonNode node, Set<String> known, String path) {
        Iterator<String> names = node.fieldNames();
        while (names.hasNext()) {
            String field = names.next();
            String at = path.isEmpty() ? field : path + "." + field;
            if (!REFUSED.contains(field) && !known.contains(field)) {
                findings.add(new Finding(at, "unknown field"));
            }
        }
    }

    /** Names every refused field at any depth, objects and arrays alike. */
    private void refuseAnywhere(JsonNode node, String path) {
        if (node.isObject()) {
            Iterator<Map.Entry<String, JsonNode>> fields = node.fields();
            while (fields.hasNext()) {
                Map.Entry<String, JsonNode> e = fields.next();
                String at = path.isEmpty() ? e.getKey() : path + "." + e.getKey();
                if (REFUSED.contains(e.getKey())) {
                    findings.add(new Finding(at, "refused: a playbook may not carry keys, addresses, hooks or MCP servers"));
                    refused = true;
                }
                refuseAnywhere(e.getValue(), at);
            }
        } else if (node.isArray()) {
            for (int i = 0; i < node.size(); i++) {
                refuseAnywhere(node.get(i), path + "[" + i + "]");
            }
        }
    }

    private static String text(JsonNode node, String field, String fallback) {
        JsonNode v = node.get(field);
        return v == null || v.isNull() ? fallback : v.asText();
    }

    private static List<String> strings(JsonNode node, String field) {
        JsonNode v = node.get(field);
        if (v == null || !v.isArray()) {
            return List.of();
        }
        List<String> out = new ArrayList<>();
        for (JsonNode e : v) {
            out.add(e.asText());
        }
        return List.copyOf(out);
    }

    private Playbook playbook(JsonNode root) {
        unknown(root, TOP, "");
        Map<String, Playbook.ModelChoice> models = new LinkedHashMap<>();
        JsonNode m = root.path("models");
        m.fields().forEachRemaining(e -> {
            unknown(e.getValue(), MODEL_CHOICE, "models." + e.getKey());
            models.put(e.getKey(), new Playbook.ModelChoice(
                    modelRef(e.getValue().path("primary"), "models." + e.getKey() + ".primary"),
                    refs(e.getValue().path("fallbacks"), "models." + e.getKey() + ".fallbacks")));
        });
        Map<String, Playbook.DocumentType> documents = new LinkedHashMap<>();
        root.path("documents").fields().forEachRemaining(e -> {
            unknown(e.getValue(), DOCUMENT, "documents." + e.getKey());
            JsonNode d = e.getValue();
            documents.put(e.getKey(), new Playbook.DocumentType(text(d, "name", e.getKey()), text(d, "purpose", ""),
                    text(d, "location", ""), text(d, "template", null), strings(d, "sections")));
        });
        Map<String, Playbook.Check> checks = new LinkedHashMap<>();
        root.path("checks").fields().forEachRemaining(e -> {
            unknown(e.getValue(), CHECK, "checks." + e.getKey());
            JsonNode c = e.getValue();
            checks.put(e.getKey(), new Playbook.Check(text(c, "kind", ""), strings(c, "documents"), strings(c, "forbid"),
                    text(c, "run", null), text(c, "model", null), strings(c, "reads"), text(c, "ask", null), strings(c, "labels")));
        });
        Map<String, String> vars = new LinkedHashMap<>();
        root.path("vars").fields().forEachRemaining(e -> vars.put(e.getKey(), e.getValue().asText()));
        List<Playbook.Node> nodes = new ArrayList<>();
        int i = 0;
        for (JsonNode n : root.path("nodes")) {
            Playbook.Node node = node(n, "nodes[" + i + "]");
            if (node != null) {
                nodes.add(node);
            }
            i++;
        }
        List<Playbook.Arrow> arrows = new ArrayList<>();
        int j = 0;
        for (JsonNode a : root.path("arrows")) {
            unknown(a, ARROW, "arrows[" + j + "]");
            arrows.add(new Playbook.Arrow(text(a, "from", ""), text(a, "to", ""), text(a, "on", null)));
            j++;
        }
        JsonNode c = root.path("contents");
        unknown(c, CONTENTS, "contents");
        Playbook.Contents contents = new Playbook.Contents(strings(c, "skills"), strings(c, "agents"),
                strings(c, "hooks"), strings(c, "commands"), strings(c, "workflows"));
        return new Playbook(root.path("schema_version").asInt(0), text(root, "id", ""), text(root, "name", ""),
                text(root, "description", ""), models, documents, checks, vars, text(root, "start", ""),
                List.copyOf(nodes), List.copyOf(arrows), contents);
    }

    private Playbook.ModelRef modelRef(JsonNode n, String path) {
        unknown(n, MODEL_REF, path);
        return new Playbook.ModelRef(text(n, "provider", ""), text(n, "model", ""));
    }

    private List<Playbook.ModelRef> refs(JsonNode arr, String path) {
        List<Playbook.ModelRef> out = new ArrayList<>();
        int i = 0;
        for (JsonNode n : arr) {
            out.add(modelRef(n, path + "[" + i++ + "]"));
        }
        return List.copyOf(out);
    }

    private Playbook.Node node(JsonNode n, String path) {
        String kind = text(n, "kind", "");
        if (RESERVED_KINDS.contains(kind)) {
            findings.add(new Finding(path + ".kind", kind + " is not supported in version 1"));
            refused = true;
            return null;
        }
        switch (kind) {
            case "step" -> {
                for (String reserved : RESERVED_STEP_FIELDS) {
                    if (n.has(reserved)) {
                        findings.add(new Finding(path + "." + reserved, reserved + " is not supported in version 1"));
                        refused = true;
                    }
                }
                unknown(n, STEP, path);
                return new Playbook.Step(text(n, "id", ""), text(n, "name", ""), text(n, "goal", null),
                        text(n, "performer", "chat"), text(n, "role", null), strings(n, "skills"), text(n, "model", null),
                        text(n, "privacy", "cheap"), text(n, "permission", "inherit"), strings(n, "consumes"),
                        strings(n, "produces"), n.path("nod").asBoolean(false));
            }
            case "decision" -> {
                unknown(n, DECISION, path);
                JsonNode rounds = n.get("max_rounds");
                return new Playbook.Decision(text(n, "id", ""), text(n, "name", ""), text(n, "check", ""),
                        strings(n, "outcomes"), rounds == null || rounds.isNull() ? null : rounds.asInt());
            }
            case "end" -> {
                unknown(n, END, path);
                return new Playbook.End(text(n, "id", ""), text(n, "result", "done"));
            }
            default -> {
                findings.add(new Finding(path + ".kind", "unknown node kind: " + kind));
                refused = true;
                return null;
            }
        }
    }
}
