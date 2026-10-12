package dev.spectroscope.core.playbook;

import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.core.JsonToken;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.governing.Governs;
import dev.spectroscope.core.subagents.SubagentManager;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Card 506: reads a workflow file into {@link Workflow}. A file is a JSON step
 * list with {@code name}, {@code description} and {@code steps}; a step is
 * {@code prompt}, {@code fanout} or {@code end}, written either with a
 * {@code kind} field (the canonical shape) or as the one key that names its
 * kind (the scenario DSL's shape, {@code {"fanout": {...}}}). Every finding
 * carries the JSON path; a repeating step without {@code max_rounds} also
 * carries the line the step starts on. The schema of the format sits beside
 * it at {@link #SCHEMA_RESOURCE} and {@code WorkflowSchemaTest} holds the two
 * together.
 */
public final class WorkflowReader {

    /**
     * @param workflow the workflow, or null when any finding was made
     * @param findings every finding, in file order
     */
    public record Read(Workflow workflow, List<Finding> findings) {}

    /** Where the JSON schema of the format lives on the class path. */
    public static final String SCHEMA_RESOURCE = "playbook/workflow.schema.json";

    /** The step kinds of the format. Split and join stay reserved for the playbook format's version 2. */
    public static final Set<String> KINDS = Set.of("prompt", "fanout", "end");
    /** The roles a child or a summariser runs as: the two the spawn tools start. */
    public static final Set<String> ROLES = Set.of("explore", "worker");
    /** What a template may name; {@code results} only in a join task. */
    static final Set<String> PLACEHOLDERS = Set.of("input", "previous", "folder");
    static final String RESULTS = "results";

    static final Set<String> TOP = Set.of("name", "description", "steps");
    static final Set<String> PROMPT = Set.of("kind", "id", "template", "repeat_until", "max_rounds");
    static final Set<String> FANOUT = Set.of("kind", "id", "label", "tool", "agents", "join", "repeat_until",
            "max_rounds");
    static final Set<String> END = Set.of("kind", "id", "result");
    static final Set<String> AGENT = Set.of("id", "role", "task", "steps");
    static final Set<String> JOIN = Set.of("role", "task");

    /**
     * The largest workflow file the loader reads. The two shipped files are
     * under 4 kB each; a step list sixteen times that is no longer a step list
     * a person reviews before pressing Run.
     */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.BYTES)
    public static final int MAX_FILE_BYTES = 65_536;

    /** The most rounds a repeating step may ask for; every repeat needs a ceiling, as a playbook loop does. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.COUNT)
    public static final int MAX_ROUNDS_LIMIT = 10;

    /** The most children one fan-out step starts: the spawn batch width, {@link SubagentManager#MAX_PARALLEL_CHILDREN}. */
    @Governs(kind = Governs.Kind.ALIAS, unit = Governs.Unit.COUNT)
    public static final int MAX_AGENTS = SubagentManager.MAX_PARALLEL_CHILDREN;

    /**
     * The most child runs one workflow may start, counted at load: every round of a fan-out step
     * starts its children and its summariser. Four rounds of the widest fan-out (four children
     * and a summariser); the two shipped files start four each.
     */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.COUNT)
    public static final int MAX_CHILD_RUNS = 20;

    /**
     * The most step bodies one workflow may run, counted at load: one per prompt or fan-out
     * step, every round counted. A prompt step is a whole chat turn of the session.
     */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.COUNT)
    public static final int MAX_STEP_RUNS = 20;

    /**
     * Strict duplicate detection: with two keys of one name the tree keeps the last while the
     * line scan reads the first, so a duplicate key is refused at load.
     */
    private static final ObjectMapper JSON = new ObjectMapper(com.fasterxml.jackson.core.JsonFactory.builder()
            .enable(com.fasterxml.jackson.core.StreamReadFeature.STRICT_DUPLICATE_DETECTION).build());
    private static final Pattern PLACEHOLDER = Pattern.compile("\\{\\{\\s*([^{}]*?)\\s*}}");
    private static final Pattern DUPLICATE = Pattern.compile("Duplicate field '(.*)'");

    private final List<Finding> findings = new ArrayList<>();
    private final List<Integer> lines;
    private boolean scenario;

    private WorkflowReader(List<Integer> lines) {
        this.lines = lines;
    }

    /**
     * @param bytes the file's bytes
     * @return the workflow or the findings
     */
    public static Read read(byte[] bytes) {
        if (bytes.length > MAX_FILE_BYTES) {
            return new Read(null, List.of(new Finding("", "the file has " + bytes.length
                    + " bytes; a workflow file may have at most " + MAX_FILE_BYTES + " bytes")));
        }
        return read(new String(bytes, StandardCharsets.UTF_8));
    }

    /**
     * @param json the file's text
     * @return the workflow or the findings
     */
    public static Read read(String json) {
        int bytes = json.getBytes(StandardCharsets.UTF_8).length;
        if (bytes > MAX_FILE_BYTES) {
            return new Read(null, List.of(new Finding("", "the file has " + bytes
                    + " bytes; a workflow file may have at most " + MAX_FILE_BYTES + " bytes")));
        }
        JsonNode root;
        try {
            root = JSON.readTree(json);
        } catch (Exception malformed) {
            Matcher duplicate = DUPLICATE.matcher(malformed instanceof com.fasterxml.jackson.core.JsonParseException p
                    ? String.valueOf(p.getOriginalMessage()) : "");
            if (duplicate.matches()) {
                int line = ((com.fasterxml.jackson.core.JsonParseException) malformed).getLocation().getLineNr();
                return new Read(null, List.of(new Finding("", "line " + line + ": the key \"" + duplicate.group(1)
                        + "\" appears twice in one object")));
            }
            return new Read(null, List.of(new Finding("", "not JSON: " + malformed.getMessage())));
        }
        if (root == null || !root.isObject()) {
            return new Read(null, List.of(new Finding("", "a workflow file must be a JSON object")));
        }
        WorkflowReader r = new WorkflowReader(stepLines(json));
        Workflow w = r.workflow(root);
        return new Read(r.findings.isEmpty() ? w : null, List.copyOf(r.findings));
    }

    private Workflow workflow(JsonNode root) {
        unknown(root, TOP, "");
        String name = text(root, "name", "");
        if (name == null || name.isBlank()) {
            findings.add(new Finding("name", "a workflow needs a name"));
        }
        String description = root.has("description") ? text(root, "description", "") : null;
        JsonNode steps = root.path("steps");
        List<Workflow.Step> out = new ArrayList<>();
        if (!steps.isArray()) {
            findings.add(new Finding("steps", "steps must be an array"));
        } else if (steps.isEmpty()) {
            findings.add(new Finding("steps", "a workflow needs at least one step"));
        } else {
            Set<String> ids = new HashSet<>();
            int stepRuns = 0;
            int childRuns = 0;
            for (int i = 0; i < steps.size(); i++) {
                Workflow.Step s = step(steps.get(i), i);
                if (s == null) {
                    continue;
                }
                int before = stepRuns;
                stepRuns += rounds(s);
                if (stepRuns > MAX_STEP_RUNS && before <= MAX_STEP_RUNS) {
                    findings.add(new Finding("steps[" + i + "]", "the run would reach " + stepRuns
                            + " step runs here, rounds counted; a workflow runs at most " + MAX_STEP_RUNS));
                }
                if (s instanceof Workflow.Fanout f) {
                    int beforeChildren = childRuns;
                    childRuns += rounds(s) * (f.agents().size() + (f.join() != null ? 1 : 0));
                    if (childRuns > MAX_CHILD_RUNS && beforeChildren <= MAX_CHILD_RUNS) {
                        findings.add(new Finding("steps[" + i + "]", "the run would start " + childRuns
                                + " child runs by here, every round with its summariser; a workflow starts at most "
                                + MAX_CHILD_RUNS));
                    }
                }
                if (!ids.add(s.id())) {
                    findings.add(new Finding("steps[" + i + "].id", "two steps are named \"" + s.id() + "\""));
                }
                if (s instanceof Workflow.End && i < steps.size() - 1) {
                    findings.add(new Finding("steps[" + i + "]", "only the last step may be an end"));
                }
                out.add(s);
            }
            if (!(steps.get(steps.size() - 1).has("kind") ? "end".equals(steps.get(steps.size() - 1).path("kind").asText())
                    : steps.get(steps.size() - 1).has("end"))) {
                findings.add(new Finding("steps", "the last step must be an end"));
            }
        }
        return new Workflow(name, description, List.copyOf(out), scenario);
    }

    private Workflow.Step step(JsonNode node, int i) {
        String at = "steps[" + i + "]";
        if (!node.isObject()) {
            findings.add(new Finding(at, "a step must be an object"));
            return null;
        }
        List<String> keys = new ArrayList<>();
        for (String k : List.of("kind", "prompt", "fanout", "end")) {
            if (node.has(k)) {
                keys.add(k);
            }
        }
        if (keys.size() != 1) {
            findings.add(new Finding(at, "a step names exactly one of kind, prompt, fanout or end"));
            return null;
        }
        String kind;
        JsonNode body;
        if (keys.get(0).equals("kind")) {
            kind = node.path("kind").asText("");
            body = node;
            if (!KINDS.contains(kind)) {
                findings.add(new Finding(at + ".kind", "\"" + kind + "\" is not a step kind; a step is prompt, fanout or end"));
                return null;
            }
        } else {
            scenario = true;
            kind = keys.get(0);
            body = node.get(kind);
        }
        boolean keyed = body != node;
        boolean given = node.has("id");
        String id = given ? text(node, "id", at) : kind + "-" + (i + 1);
        return switch (kind) {
            case "prompt" -> {
                if (keyed) {
                    unknown(node, Set.of("prompt", "id", "repeat_until", "max_rounds"), at);
                } else {
                    unknown(node, PROMPT, at);
                }
                Workflow.Text template = template(keyed ? body : node.get("template"), at + (keyed ? ".prompt" : ".template"),
                        false);
                Rounds rounds = rounds(node, at, id);
                yield new Workflow.Prompt(id, given, template, rounds.until, rounds.max);
            }
            case "fanout" -> {
                if (keyed) {
                    unknown(node, Set.of("fanout", "id", "repeat_until", "max_rounds"), at);
                    if (!body.isObject()) {
                        findings.add(new Finding(at + ".fanout", "a fanout must be an object"));
                        yield null;
                    }
                    unknown(body, Set.of("label", "tool", "agents", "join"), at + ".fanout");
                } else {
                    unknown(node, FANOUT, at);
                }
                String base = keyed ? at + ".fanout" : at;
                Rounds rounds = rounds(node, at, id);
                yield new Workflow.Fanout(id, given, optional(body, "label", base), optional(body, "tool", base),
                        agents(body.path("agents"), base + ".agents"), join(body.get("join"), base + ".join"),
                        rounds.until, rounds.max);
            }
            default -> {
                if (keyed) {
                    unknown(node, Set.of("end", "id"), at);
                    if (!body.isObject()) {
                        findings.add(new Finding(at + ".end", "an end must be an object"));
                        yield null;
                    }
                    unknown(body, Set.of("result"), at + ".end");
                } else {
                    unknown(node, END, at);
                }
                yield new Workflow.End(id, given, optional(body, "result", keyed ? at + ".end" : at));
            }
        };
    }

    /**
     * How many times a step's body runs at most: its {@code max_rounds} when it repeats, else
     * once; an end runs no body. A {@code max_rounds} without {@code repeat_until} is a finding.
     */
    private static int rounds(Workflow.Step step) {
        Integer max = switch (step) {
            case Workflow.Prompt p -> p.maxRounds();
            case Workflow.Fanout f -> f.maxRounds();
            case Workflow.End e -> 0;
        };
        return max == null ? 1 : max;
    }

    private record Rounds(String until, Integer max) {}

    private Rounds rounds(JsonNode node, String at, String id) {
        String until = node.has("repeat_until") ? text(node, "repeat_until", at) : null;
        Integer max = null;
        if (node.has("max_rounds")) {
            JsonNode m = node.get("max_rounds");
            if (!m.isInt() || m.asInt() < 1 || m.asInt() > MAX_ROUNDS_LIMIT) {
                findings.add(new Finding(at + ".max_rounds", "max_rounds is a whole number from 1 to " + MAX_ROUNDS_LIMIT));
            } else {
                max = m.asInt();
            }
            if (until == null) {
                findings.add(new Finding(at + ".max_rounds", "max_rounds without repeat_until: the step does not repeat"));
            }
        }
        if (until != null && !node.has("max_rounds")) {
            int index = Integer.parseInt(at.substring(at.indexOf('[') + 1, at.indexOf(']')));
            String line = index < lines.size() ? "line " + lines.get(index) + ": " : "";
            findings.add(new Finding(at, line + "step \"" + id + "\" repeats (repeat_until) and carries no max_rounds;"
                    + " every repeat needs a ceiling"));
        }
        return new Rounds(until, max);
    }

    private List<Workflow.Agent> agents(JsonNode agents, String at) {
        List<Workflow.Agent> out = new ArrayList<>();
        if (!agents.isArray() || agents.isEmpty() || agents.size() > MAX_AGENTS) {
            findings.add(new Finding(at, "a fanout starts 1 to " + MAX_AGENTS + " children"));
            if (!agents.isArray()) {
                return out;
            }
        }
        for (int i = 0; i < agents.size(); i++) {
            JsonNode a = agents.get(i);
            String here = at + "[" + i + "]";
            if (!a.isObject()) {
                findings.add(new Finding(here, "a child must be an object"));
                continue;
            }
            unknown(a, AGENT, here);
            JsonNode steps = a.get("steps");
            if (steps != null && !steps.isArray()) {
                findings.add(new Finding(here + ".steps", "steps of a scenario child must be an array"));
            }
            out.add(new Workflow.Agent(optional(a, "id", here), role(a, here),
                    template(a.get("task"), here + ".task", false), steps));
        }
        return out;
    }

    private Workflow.Join join(JsonNode join, String at) {
        if (join == null) {
            return null;
        }
        if (!join.isObject()) {
            findings.add(new Finding(at, "a join must be an object"));
            return null;
        }
        unknown(join, JOIN, at);
        return new Workflow.Join(role(join, at), template(join.get("task"), at + ".task", true));
    }

    private String role(JsonNode node, String at) {
        if (!node.has("role")) {
            return null;
        }
        String role = node.path("role").asText("");
        if (!ROLES.contains(role)) {
            findings.add(new Finding(at + ".role", "\"" + role + "\" is not a role here; a child runs as explore or worker"));
        }
        return role;
    }

    private Workflow.Text template(JsonNode node, String at, boolean join) {
        Workflow.Text t;
        if (node != null && node.isTextual()) {
            t = Workflow.Text.of(node.asText());
        } else if (node != null && node.isObject() && node.path("en").isTextual() && node.path("de").isTextual()
                && node.size() == 2) {
            t = new Workflow.Text(null, node.path("en").asText(), node.path("de").asText());
        } else {
            findings.add(new Finding(at, "a text is a string or an object with en and de"));
            return Workflow.Text.of("");
        }
        for (String s : t.all()) {
            if (s.isBlank()) {
                findings.add(new Finding(at, "the text is empty"));
                break;
            }
        }
        Set<String> named = new java.util.LinkedHashSet<>();
        for (String s : t.all()) {
            Matcher m = PLACEHOLDER.matcher(s);
            while (m.find()) {
                named.add(m.group(1));
            }
        }
        for (String name : named) {
            if (!PLACEHOLDERS.contains(name) && !(join && RESULTS.equals(name))) {
                findings.add(new Finding(at, "{{" + name + "}} is not filled here; a template names {{input}},"
                        + " {{previous}} or {{folder}}" + (join ? ", and a join task {{results}}" : "")));
            }
        }
        return t;
    }

    private String text(JsonNode node, String field, String at) {
        JsonNode v = node.get(field);
        if (v == null || !v.isTextual()) {
            findings.add(new Finding(at.isEmpty() ? field : at + "." + field, field + " must be a string"));
            return null;
        }
        return v.asText();
    }

    private String optional(JsonNode node, String field, String at) {
        return node.has(field) ? text(node, field, at) : null;
    }

    private void unknown(JsonNode node, Set<String> known, String path) {
        Iterator<String> names = node.fieldNames();
        while (names.hasNext()) {
            String field = names.next();
            if (!known.contains(field)) {
                findings.add(new Finding(path.isEmpty() ? field : path + "." + field, "unknown field"));
            }
        }
    }

    /**
     * The line each element of the top level {@code steps} array starts on,
     * read off the parser's token locations, which a bound tree no longer has.
     */
    static List<Integer> stepLines(String json) {
        List<Integer> out = new ArrayList<>();
        try (JsonParser p = JSON.getFactory().createParser(json)) {
            if (p.nextToken() != JsonToken.START_OBJECT) {
                return out;
            }
            while (p.nextToken() == JsonToken.FIELD_NAME) {
                String name = p.currentName();
                JsonToken value = p.nextToken();
                if ("steps".equals(name) && value == JsonToken.START_ARRAY) {
                    JsonToken element;
                    while ((element = p.nextToken()) != JsonToken.END_ARRAY && element != null) {
                        out.add(p.currentTokenLocation().getLineNr());
                        p.skipChildren();
                    }
                    return out;
                }
                p.skipChildren();
            }
        } catch (IOException unreadable) {
            // the tree read already named it
        }
        return out;
    }
}
