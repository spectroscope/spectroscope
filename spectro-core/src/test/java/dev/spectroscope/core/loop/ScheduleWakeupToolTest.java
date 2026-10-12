package dev.spectroscope.core.loop;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.tools.Tool;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Card 504, criterion 7: the tool the model paces a loop with. */
class ScheduleWakeupToolTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static JsonNode json(String text) throws Exception {
        return JSON.readTree(text);
    }

    private static String call(ScheduleWakeupTool tool, String input) throws Exception {
        return tool.execute(json(input), new Tool.ToolContext(Path.of("."), new CancelSignal()));
    }

    private static LoopDriver running(Path dir) {
        FakeTimer timer = new FakeTimer(1_000_000L);
        LoopDriver driver = new LoopDriver("s", timer, timer, new LoopSidecar(dir));
        driver.host(new LoopDriverTest.Host());
        driver.start("watch", null);
        return driver;
    }

    @Test
    void itIsNamedScheduleWakeupAndIsGated() {
        ScheduleWakeupTool tool = new ScheduleWakeupTool(() -> null);
        assertEquals("schedule_wakeup", tool.name());
        assertEquals(ScheduleWakeupTool.NAME, tool.name());
        assertTrue(tool.needsPermission(), "tier write: the gate is asked, and the auto modes read the relay rule");
    }

    @Test
    void theSchemaHasTheFourFieldsAndTheDescriptionTheRules() {
        ScheduleWakeupTool tool = new ScheduleWakeupTool(() -> null);
        JsonNode properties = tool.inputSchema().path("properties");
        assertEquals("number", properties.path("delaySeconds").path("type").asText());
        assertEquals("string", properties.path("reason").path("type").asText());
        assertEquals("string", properties.path("prompt").path("type").asText());
        assertEquals("boolean", properties.path("stop").path("type").asText());
        assertTrue(tool.description().contains("60"), tool.description());
        assertTrue(tool.description().contains("3600"), tool.description());
        assertTrue(tool.description().contains(LoopPrompts.SENTINEL), tool.description());
        assertTrue(tool.description().contains("stop"), tool.description());
        // Fix round 2: the cap on what the model writes is in the description.
        assertTrue(tool.description().contains(LoopLimits.TEXT_CAP + " characters"), tool.description());
        // Hub and spoke fix round: a stop ends the turn as well, so the summary comes first.
        assertTrue(tool.description().contains("closing summary"), tool.description());
    }

    @Test
    void aWakeupIsArmedAndTheResultSaysWhenAndHowTheTurnEnds(@TempDir Path dir) throws Exception {
        LoopDriver driver = running(dir);
        ScheduleWakeupTool tool = new ScheduleWakeupTool(() -> driver);
        String result = call(tool, "{\"delaySeconds\":30,\"reason\":\"CI takes a minute\",\"prompt\":\"<<loop>>\"}");
        assertTrue(result.startsWith("Next wakeup at "), result);
        assertTrue(result.contains("clamped to 60 s"), "wasClamped is said: " + result);
        assertTrue(result.contains("Write the per tick update before this call; the turn ends when it returns."),
                result);
        assertEquals("CI takes a minute", driver.state().reason());
    }

    @Test
    void theRequiredFieldsAreRefusedUnlessStop(@TempDir Path dir) throws Exception {
        LoopDriver driver = running(dir);
        ScheduleWakeupTool tool = new ScheduleWakeupTool(() -> driver);
        assertTrue(call(tool, "{\"reason\":\"r\",\"prompt\":\"p\"}").startsWith("ERROR:"));
        assertTrue(call(tool, "{\"delaySeconds\":60,\"prompt\":\"p\"}").startsWith("ERROR:"));
        assertTrue(call(tool, "{\"delaySeconds\":60,\"reason\":\"r\"}").startsWith("ERROR:"));
        assertTrue(call(tool, "{\"delaySeconds\":\"soon\",\"reason\":\"r\",\"prompt\":\"p\"}").startsWith("ERROR:"));
        String stopped = call(tool, "{\"stop\":true}");
        assertTrue(stopped.startsWith("Loop stopped"), stopped);
        assertFalse(driver.state().active());
    }

    @Test
    void withoutALoopTheToolSaysHowOneStarts() throws Exception {
        AtomicReference<LoopDriver> none = new AtomicReference<>();
        String result = call(new ScheduleWakeupTool(none::get), "{\"delaySeconds\":60,\"reason\":\"r\",\"prompt\":\"p\"}");
        assertTrue(result.startsWith("ERROR:"), result);
        assertTrue(result.contains("/loop"), result);
    }
}
