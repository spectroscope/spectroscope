package dev.spectroscope.core.tools;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.tools.Tool.ToolContext;
import org.junit.jupiter.api.Test;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** update_plan is permission-free and publishes exactly one plan event through the emit sink. */
class UpdatePlanToolTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private final List<RunEvent> events = new ArrayList<>();
    private final Tool tool = new UpdatePlanTool();

    private ToolContext context() {
        return new ToolContext(Path.of("."), new CancelSignal(), "main", "c1", events::add);
    }

    @Test
    void itIsPermissionFree() {
        assertEquals("update_plan", tool.name());
        assertFalse(tool.needsPermission(), "a plan is metadata, never a gated side effect");
    }

    @Test
    void itEmitsAPlanEventWithTheParsedSteps() {
        JsonNode input = readTree("""
                { "steps": [
                    { "text": "read the files", "status": "completed" },
                    { "text": "write the tool", "status": "in_progress" } ] }
                """);
        String result = tool.execute(input, context());

        assertTrue(result.startsWith("ok"), "the model sees a terse ok, not the plan back");
        assertEquals(1, events.size(), "exactly one plan event per call");
        RunEvent.Plan plan = (RunEvent.Plan) events.get(0);
        assertEquals("main", plan.agentId());
        assertEquals(List.of(
                new RunEvent.PlanStep("read the files", "completed"),
                new RunEvent.PlanStep("write the tool", "in_progress")), plan.steps());
    }

    @Test
    void anEmptyOrMissingStepsArrayIsARejectedNeverThrows() {
        assertTrue(tool.execute(JSON.createObjectNode(), context()).startsWith("ERROR:"));
        assertTrue(tool.execute(readTree("{\"steps\":[]}"), context()).startsWith("ERROR:"));
        assertTrue(tool.execute(readTree("{\"steps\":[{\"status\":\"pending\"}]}"), context())
                .startsWith("ERROR:"), "a step without text is rejected");
        assertTrue(events.isEmpty(), "rejected calls emit no event");
    }

    @Test
    void anUnknownStatusIsRejectedWithTheAllowedValues() {
        // A live gpt-oss run sent "done": the web UI showed the raw string, the
        // CLI rendered it as pending, and the JSONL carried a non-canonical value.
        String result = tool.execute(
                readTree("{\"steps\":[{\"text\":\"x\",\"status\":\"done\"}]}"), context());
        assertTrue(result.startsWith("ERROR:"), result);
        assertTrue(result.contains("pending, in_progress, completed"),
                "the error must teach the allowed values");
        assertTrue(events.isEmpty(), "a rejected plan emits no event");
    }

    @Test
    void aMissingStatusDefaultsToPending() {
        String result = tool.execute(readTree("{\"steps\":[{\"text\":\"x\"}]}"), context());
        assertEquals("ok (1 steps)", result);
        RunEvent.Plan plan = (RunEvent.Plan) events.get(0);
        assertEquals("pending", plan.steps().get(0).status());
    }

    private JsonNode readTree(String json) {
        try {
            return JSON.readTree(json);
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }
}
