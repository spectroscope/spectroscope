package dev.spectroscope.core;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.HookConfig;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.hooks.HookRunner;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.tools.Tool;
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
 * Card 489, round three: the reason of a blocking {@code pre_tool_use} hook
 * enters the same request as a tool result, so it is clamped by the same rule
 * and the same window. The loop hands the hook runner the window it hands the
 * tool.
 *
 * <p>A scripted hook exits 1 after printing 20,000 characters. On a window of
 * 8,192 tokens the tool result carries 6,144 of them, on 200,000 tokens 10,000.
 * The bounds are written out, so a reverted rule cannot move them. The prefix
 * the loop and the runner write ({@code ERROR: blocked by pre_tool_use hook:
 * exit 1: }) stays whole.</p>
 */
@Timeout(value = 30, unit = TimeUnit.SECONDS)
class HookReasonFollowsTheWindowTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** One call to {@code echo}, then a plain answer, on a declared window. */
    private static final class OneCall implements LlmProvider {
        private final int window;
        private boolean issued;

        OneCall(int window) {
            this.window = window;
        }

        @Override
        public int contextWindow() {
            return window;
        }

        @Override
        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            if (!issued) {
                issued = true;
                return List.of(new PToolCall("c1", "echo", JSON.createObjectNode()),
                        new PStop(PStop.StopReason.TOOL_USE));
            }
            return List.of(new PTextDelta("ok"), new PStop(PStop.StopReason.END_TURN));
        }
    }

    /** A tool that must never run: the hook blocks it. */
    private static final class Echo implements Tool {
        final List<JsonNode> inputs = new ArrayList<>();

        public String name() { return "echo"; }
        public String description() { return "echoes"; }
        public JsonNode inputSchema() { return JSON.createObjectNode(); }
        public boolean needsPermission() { return false; }
        public String execute(JsonNode input, ToolContext context) {
            inputs.add(input);
            return "echoed";
        }
    }

    @Test
    void aBlockingHooksReasonIsClampedToTheTurnsWindow(@TempDir Path cwd) {
        String printed = "h".repeat(20_000);
        for (int[] windowAndBound : new int[][] {{8_192, 6_144}, {200_000, 10_000}}) {
            HookRunner hooks = new HookRunner(
                    List.of(new HookConfig("*", "pre_tool_use", "guard", null)),
                    (cmd, env, dir, timeout, signal) ->
                            new HookRunner.CommandRunner.Result(1, printed, false),
                    10);
            Echo echo = new Echo();
            ToolRegistry registry = new ToolRegistry();
            registry.register(echo);
            Agent agent = new Agent(AgentOptions.builder()
                    .provider(new OneCall(windowAndBound[0]))
                    .systemPrompt("test")
                    .registry(registry)
                    .cwd(cwd)
                    .onPermission(request -> true)
                    .hooks(hooks)
                    .build());
            List<RunEvent> events = new ArrayList<>();
            try (EventStream stream = agent.run("go", new RunOptions(new CancelSignal(), null))) {
                stream.forEach(events::add);
            }
            String output = events.stream()
                    .filter(RunEvent.ToolResult.class::isInstance)
                    .map(RunEvent.ToolResult.class::cast)
                    .findFirst().orElseThrow().output();
            String reason = events.stream()
                    .filter(RunEvent.HookDecision.class::isInstance)
                    .map(RunEvent.HookDecision.class::cast)
                    .findFirst().orElseThrow().reason();
            System.out.println("clamp-hook window=" + windowAndBound[0]
                    + " result=" + output.length() + " reason=" + reason.length());

            assertTrue(echo.inputs.isEmpty(), "the hook blocked the call");
            String expected = "exit 1: " + "h".repeat(windowAndBound[1]);
            assertEquals("ERROR: blocked by pre_tool_use hook: " + expected, output,
                    "the tool result on a window of " + windowAndBound[0]);
            assertEquals(expected, reason,
                    "the hook_decision event records the reason the model was given");
        }
    }
}
