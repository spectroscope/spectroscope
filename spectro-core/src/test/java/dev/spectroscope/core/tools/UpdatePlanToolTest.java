package dev.spectroscope.core.tools;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
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
    void aStepThatSentTitleInsteadOfTextIsToldWhichKeyItSent() {
        // Observed: one model, two calls, same turn — the first sent {status, title}
        // and read "text is missing" as "guess again", the second happened to guess right.
        String result = tool.execute(
                readTree("{\"steps\":[{\"status\":\"in_progress\",\"title\":\"Run the dice test\"}]}"),
                context());

        assertTrue(result.startsWith("ERROR:"), result);
        assertTrue(result.contains("\"title\""), "the message names the key it received: " + result);
        assertTrue(result.contains("\"text\""), "and the key it needs: " + result);
        assertFalse(result.contains("Run the dice test"),
                "a step's own prose is never echoed back: " + result);
        assertTrue(events.isEmpty(), "a rejected plan emits no event");
    }

    @Test
    void aStepWithNoKeysAtAllKeepsThePlainMessage() {
        assertEquals("ERROR: every step needs a non-empty text.",
                tool.execute(readTree("{\"steps\":[{}]}"), context()),
                "with nothing to name, naming nothing is the honest message");
        assertTrue(events.isEmpty(), "a rejected plan emits no event");
    }

    @Test
    void aStepWhoseTextIsPresentButBlankSaysThatInsteadOfListingKeys() {
        String result = tool.execute(
                readTree("{\"steps\":[{\"text\":\"   \",\"status\":\"pending\"}]}"), context());

        assertTrue(result.startsWith("ERROR: steps[0]"), result);
        assertTrue(result.contains("blank"),
                "naming the keys here would read as \"but I DID send text\": " + result);
        assertTrue(events.isEmpty(), "a rejected plan emits no event");
    }

    @Test
    void theTaughtMessageNamesTheOffendingIndexStaysOneLineAndBoundsWhatItQuotes() {
        ObjectNode good = JSON.createObjectNode();
        good.put("text", "read the files");
        good.put("status", "completed");
        ObjectNode bad = JSON.createObjectNode();
        bad.put("status", "in_progress");
        bad.put("a newline\nand " + "y".repeat(4000), 1);
        for (int i = 0; i < 12; i++) {
            bad.put("k" + i, i);
        }
        ObjectNode input = JSON.createObjectNode();
        input.set("steps", JSON.createArrayNode().add(good).add(bad));

        String result = tool.execute(input, context());

        assertTrue(result.contains("steps[1]"), "the message says WHICH step: " + result);
        assertFalse(result.contains("\n"), "the message stays one line: " + result);
        assertTrue(result.length() < 300,
                "model-supplied keys are bounded, never echoed whole: " + result);
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
