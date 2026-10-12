package dev.spectroscope.core.loop;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.tools.Tool;

import java.util.function.Supplier;

/**
 * {@code schedule_wakeup} (card 504, criterion 7): the model paces a loop.
 *
 * <p>Tier {@code write} in {@code tool-tiers.json} and gated: in {@code ask}
 * the operator sees the call, in the auto modes the relay rule of card 503
 * reads it, as it reads every gated call. The agent offers the tool only
 * while the session runs a loop ({@code Agent.loopActive}).</p>
 */
public final class ScheduleWakeupTool implements Tool {

    /** Wire name. */
    public static final String NAME = "schedule_wakeup";

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final JsonNode SCHEMA;

    static {
        try {
            SCHEMA = JSON.readTree("""
                    {"type":"object","properties":{\
                    "delaySeconds":{"type":"number","description":"Seconds from now to wake up. Clamped to 60 to 3600; \
                    the wakeup lands on the whole minute at or after it. Required unless stop is true."},\
                    "reason":{"type":"string","description":"One short sentence on why this delay. The operator sees \
                    it. Required unless stop is true."},\
                    "prompt":{"type":"string","description":"What the wakeup runs: the literal <<loop>> for a self \
                    paced loop, or the task as written. Required unless stop is true."},\
                    "stop":{"type":"boolean","description":"True ends the loop now; the other fields are ignored."}}}""");
        } catch (Exception impossible) {
            throw new ExceptionInInitializerError(impossible);
        }
    }

    private final Supplier<LoopDriver> driver;

    /** @param driver the session's loop, or a supplier of null where none runs */
    public ScheduleWakeupTool(Supplier<LoopDriver> driver) {
        this.driver = driver;
    }

    @Override
    public String name() {
        return NAME;
    }

    @Override
    public String description() {
        return "Schedules the next tick of the loop the operator started with /loop, or ends it. Call it as the"
                + " last call of the turn, after you wrote the update for this tick: the turn ends when it returns."
                + " delaySeconds is clamped to 60 to 3600; pick it from how fast the thing you watch changes."
                + " Pass prompt <<loop>> to keep the loop's own instructions. A new wakeup replaces the pending one."
                + " Set stop to true when the task is done or cannot make progress; write the closing summary"
                + " first, since a stop ends the turn as well."
                + " A reason longer than " + LoopLimits.TEXT_CAP + " characters is cut; a prompt longer than "
                + LoopLimits.TEXT_CAP + " characters is refused.";
    }

    @Override
    public JsonNode inputSchema() {
        return SCHEMA;
    }

    /** Gated: tier write. */
    @Override
    public boolean needsPermission() {
        return true;
    }

    @Override
    public String execute(JsonNode input, ToolContext context) {
        LoopDriver loop = driver.get();
        if (loop == null || !loop.active()) {
            return "ERROR: no loop runs in this session; the operator starts one with /loop.";
        }
        boolean stop = input.path("stop").asBoolean(false);
        JsonNode delay = input.path("delaySeconds");
        if (!stop && !delay.isMissingNode() && !delay.isNull() && !delay.isNumber()) {
            return "ERROR: delaySeconds must be a number of seconds.";
        }
        Double seconds = delay.isNumber() ? delay.asDouble() : null;
        String reason = input.path("reason").isTextual() ? input.path("reason").asText() : null;
        String prompt = input.path("prompt").isTextual() ? input.path("prompt").asText() : null;
        return loop.schedule(seconds, reason, prompt, stop).text();
    }
}
