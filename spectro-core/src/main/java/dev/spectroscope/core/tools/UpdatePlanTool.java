package dev.spectroscope.core.tools;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.events.RunEvent;

import java.util.ArrayList;
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

    /** Wire name: {@code update_plan}. */
    @Override
    public String name() {
        return "update_plan";
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
        for (JsonNode stepNode : stepsNode) {
            String text = stepNode.path("text").asText("").strip();
            String status = stepNode.path("status").asText("pending").strip();
            if (text.isBlank()) {
                return "ERROR: every step needs a non-empty text.";
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
