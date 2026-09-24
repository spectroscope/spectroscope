package dev.spectroscope.core;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.tools.StandardTools;
import dev.spectroscope.core.tools.ToolRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 396, criteria 2 and 5 in the loop: with a gate that allows everything,
 * which is what auto mode answers, a run_command aimed at this JVM comes back
 * as an ordinary failed tool call and the run goes on to its next turn. The
 * line is {@code kill -0 $PPID}: signal 0 sends nothing, so a guard that fails
 * here costs the test JVM nothing.
 */
@Timeout(value = 30, unit = TimeUnit.SECONDS)
class AgentHostGuardTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** One run_command turn, then an empty one. */
    private record OneKill(String line) implements LlmProvider {
        @Override public String modelName() {
            return "fake-model-1";
        }

        @Override public Iterable<ProviderEvent> stream(ProviderRequest request) {
            boolean alreadyCalled = request.messages().stream()
                    .anyMatch(message -> message.role() == ProviderMessage.Role.ASSISTANT);
            if (alreadyCalled) {
                return List.of(new PStop(PStop.StopReason.END_TURN));
            }
            return List.of(new PToolCall("c1", "run_command",
                            JSON.createObjectNode().put("command", line)),
                    new PStop(PStop.StopReason.TOOL_USE));
        }
    }

    @Test
    void anAllowAllGateStillMeetsTheGuard(@TempDir Path dir) {
        ToolRegistry registry = new ToolRegistry();
        StandardTools.all(10).forEach(registry::register);
        List<RunEvent> events = new ArrayList<>();
        Agent agent = new Agent(AgentOptions.builder()
                .provider(new OneKill("kill -0 $PPID"))
                .systemPrompt("test")
                .registry(registry)
                .cwd(dir)
                .onPermission(request -> true)
                .build());
        try (EventStream stream = agent.run("go", new RunOptions(new CancelSignal(), List.of()))) {
            for (RunEvent event : stream) {
                events.add(event);
            }
        }
        RunEvent.PermissionDecision decision = events.stream()
                .filter(RunEvent.PermissionDecision.class::isInstance)
                .map(RunEvent.PermissionDecision.class::cast).findFirst().orElseThrow();
        assertTrue(decision.allowed(), "the gate said yes, as auto mode does");
        RunEvent.ToolResult result = events.stream()
                .filter(RunEvent.ToolResult.class::isInstance)
                .map(RunEvent.ToolResult.class::cast).findFirst().orElseThrow();
        assertTrue(result.isError(), "a refusal is a failed tool call");
        assertTrue(result.output().startsWith("ERROR: refused"), result.output());
        assertTrue(result.output().contains(
                "protected PID " + ProcessHandle.current().pid() + " "), result.output());
        RunEvent.RunEnd end = events.stream()
                .filter(RunEvent.RunEnd.class::isInstance)
                .map(RunEvent.RunEnd.class::cast).findFirst().orElseThrow();
        long turns = events.stream().filter(RunEvent.TurnStart.class::isInstance).count();
        assertEquals(2, turns, "the run took its next turn after the refusal");
        assertEquals("end_turn", end.stopReason(), "the run ended on its own, it did not crash");
    }
}
