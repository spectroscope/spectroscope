package dev.spectroscope.core.tools;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.events.RunEvent;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Set;

/**
 * The {@code update_plan} tool: the main agent publishes its current step-by-step
 * plan (a short TODO list). Permission-free — a plan is metadata, not a side effect.
 * Each call fully replaces the plan (latest-wins) by emitting one additive
 * {@code plan} RunEvent through the context's emit sink; the model only ever sees a
 * terse "ok". Mirrors {@code report_status}; never throws.
 */
public final class UpdatePlanTool implements Tool {

    private static final ObjectMapper JSON = new ObjectMapper();
    /** The schema's enum is advisory to the model; execute() enforces it — the wire
     *  contract (JSONL, cross-edition) allows exactly these English values. */
    private static final Set<String> STATUSES = Set.of("pending", "in_progress", "completed");
    /** A rejection is quoted back into the model's context, and every key in it is
     *  model-supplied: without these bounds one confused step could carry a megabyte
     *  of prose as a key name and the tool result would carry it right back. */
    private static final int MAX_NAMED_KEYS = 4;
    private static final int MAX_KEY_CHARS = 24;
    private static final JsonNode SCHEMA = parseSchema("""
            { "type": "object", "required": ["steps"],
              "properties": {
                "steps": {
                  "type": "array",
                  "description": "The full current plan, in order — replaces any previous plan.",
                  "items": {
                    "type": "object",
                    "required": ["text", "status"],
                    "properties": {
                      "text":   { "type": "string", "description": "One short step" },
                      "status": { "type": "string", "enum": ["pending", "in_progress", "completed"] } } } } } }
            """);

    /**
     * The wire name, as a constant because the loop has to recognise this tool
     * by name.
     *
     * <p>Card 266's leash grades a stopped run by two halves — did the plan
     * advance, and did any tool call come back clean. This tool writes the
     * FIRST half, so counting it in the second as well lets a model buy its
     * next continuation by re-emitting a ledger that did not move. A literal
     * string in {@code Agent} would be the same fact spelled twice.</p>
     */
    public static final String NAME = "update_plan";

    /** Wire name: {@code update_plan}. */
    @Override
    public String name() {
        return NAME;
    }

    /** The model-facing manual — call on start and whenever a step's status changes. */
    @Override
    public String description() {
        return "Publishes your current step-by-step plan (a short TODO list). Call it when you "
                + "start work and whenever a step's status changes. The user sees it in the Plan "
                + "panel; it does not pause your work. Each call replaces the whole plan.";
    }

    /** Requires a {@code steps} array of {text, status} objects. */
    @Override
    public JsonNode inputSchema() {
        return SCHEMA;
    }

    /** Permission-free — publishing a plan changes nothing outside the event stream. */
    @Override
    public boolean needsPermission() {
        return false; // a plan is metadata, never a side-effecting action
    }

    /** Validates every step (non-empty text, canonical status) and emits the whole plan as ONE additive plan event — latest wins. */
    @Override
    public String execute(JsonNode input, ToolContext context) {
        JsonNode stepsNode = input.path("steps");
        if (!stepsNode.isArray() || stepsNode.isEmpty()) {
            return "ERROR: steps must be a non-empty array of {text, status}.";
        }
        List<RunEvent.PlanStep> steps = new ArrayList<>();
        for (int index = 0; index < stepsNode.size(); index++) {
            JsonNode stepNode = stepsNode.get(index);
            String text = stepNode.path("text").asText("").strip();
            String status = stepNode.path("status").asText("pending").strip();
            if (text.isBlank()) {
                return missingTextError(stepNode, index);
            }
            // Live models improvise values like "done"; letting them through split
            // the displays (web showed the raw string, the CLI rendered pending)
            // and leaked non-canonical statuses into the JSONL.
            if (!STATUSES.contains(status)) {
                return "ERROR: status must be one of pending, in_progress, completed.";
            }
            steps.add(new RunEvent.PlanStep(text, status));
        }
        context.emit().accept(new RunEvent.Plan(
                context.agentId(), List.copyOf(steps), System.currentTimeMillis()));
        return "ok (" + steps.size() + " steps)";
    }

    /**
     * Builds the rejection for a step that carries no usable text. The alias is
     * deliberately NOT accepted: {@code title}, {@code step} and {@code label} are all
     * live drifts, so no fixed alias list covers the next one, whereas naming the keys
     * that actually arrived teaches every drift at once and keeps one shape on the wire.
     *
     * @param stepNode the offending step, exactly as the model sent it
     * @param index    its position in the steps array, so a long plan says which one
     * @return one line, always, whatever the step carried
     */
    private static String missingTextError(JsonNode stepNode, int index) {
        if (stepNode.has("text")) {
            return "ERROR: steps[" + index + "] needs a non-empty \"text\"; the one it sent is blank.";
        }
        String sent = namedKeys(stepNode);
        if (sent.isEmpty()) {
            return "ERROR: every step needs a non-empty text.";
        }
        return "ERROR: steps[" + index + "] needs a non-empty \"text\"; it sent " + sent
                + ". Each step is {\"text\": \"...\", \"status\": \"pending|in_progress|completed\"}.";
    }

    /**
     * Quotes the keys a step did carry, bounded in both count and width.
     *
     * @param stepNode the offending step; a non-object simply has no keys to name
     * @return the quoted key names, comma-separated, or empty when there are none
     */
    private static String namedKeys(JsonNode stepNode) {
        List<String> names = new ArrayList<>();
        Iterator<String> keys = stepNode.fieldNames();
        while (keys.hasNext() && names.size() < MAX_NAMED_KEYS) {
            names.add("\"" + oneLine(keys.next()) + "\"");
        }
        if (keys.hasNext()) {
            names.add("\"…\"");
        }
        return String.join(", ", names);
    }

    /**
     * Flattens one model-supplied key to something that cannot break the single line.
     *
     * @param key the raw key name
     * @return the key with every control character and run of whitespace collapsed,
     *         truncated to {@link #MAX_KEY_CHARS}
     */
    private static String oneLine(String key) {
        String flat = key.replaceAll("[\\p{Cntrl}\\s]+", " ").strip();
        return flat.length() <= MAX_KEY_CHARS ? flat : flat.substring(0, MAX_KEY_CHARS) + "…";
    }

    /**
     * Parses the built-in schema literal — a broken one is a programming error and
     * fails loudly at class-initialization time.
     *
     * @param json the JSON Schema source text
     * @return the parsed schema tree
     */
    private static JsonNode parseSchema(String json) {
        try {
            return JSON.readTree(json);
        } catch (JsonProcessingException invalid) {
            throw new IllegalStateException("Invalid built-in tool schema: " + invalid.getMessage(), invalid);
        }
    }
}
