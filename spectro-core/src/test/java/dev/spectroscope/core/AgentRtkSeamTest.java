package dev.spectroscope.core;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.tools.RtkFilter;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.tools.ToolRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;

/**
 * Card 379, Owner call 1 and criterion 10: whose judgement owns the decision,
 * and what the operator gets to see.
 *
 * <p>rtk is built to sit inside another agent's permission system and to reach
 * its verdict from Claude Code's {@code settings.json}. Spectroscope has its own
 * gate, so the verdict stays ours: rtk is asked what a line could BECOME, never
 * whether it may run. What follows from that is the thing these cases pin. The
 * gate is asked about the line that will actually be executed, because gating on
 * a line and running another one is the one outcome a product whose promise is
 * observing cannot ship. And the original travels beside it, because a rewrite
 * the operator cannot see is the other one.</p>
 */
@Timeout(value = 30, unit = TimeUnit.SECONDS)
class AgentRtkSeamTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** Records the line it was actually handed, and reports the gate's verdict. */
    private static final class RecordingShell implements Tool {
        final AtomicReference<String> executed = new AtomicReference<>();

        public String name() {
            return "run_command";
        }

        public String description() {
            return "records";
        }

        public JsonNode inputSchema() {
            return JSON.createObjectNode().put("type", "object");
        }

        public boolean needsPermission() {
            return true;
        }

        public String execute(JsonNode input, ToolContext context) {
            executed.set(input.path(RtkFilter.COMMAND_FIELD).asText());
            return "ok";
        }
    }

    /** One tool-use turn, then an empty one: the house's scripted-provider idiom. */
    private record OneShellCall(String line) implements LlmProvider {
        public String modelName() {
            return "fake-model-1";
        }

        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            boolean alreadyCalled = request.messages().stream()
                    .anyMatch(message -> message.role() == ProviderMessage.Role.ASSISTANT);
            if (alreadyCalled) {
                return List.of(new PStop(PStop.StopReason.END_TURN));
            }
            return List.of(
                    new PToolCall("c1", "run_command",
                            JSON.createObjectNode().put(RtkFilter.COMMAND_FIELD, line)),
                    new PStop(PStop.StopReason.TOOL_USE));
        }
    }

    /** One scripted rewrite, so this file measures the Agent and not rtk. */
    private record ScriptedOracle(String answer) implements RtkFilter.Oracle {
        public String rewrite(String line) {
            return answer;
        }

        public String version() {
            return "rtk 0.0.0-scripted";
        }
    }

    private record Run(List<RunEvent> events, String executed, JsonNode gated) { }

    private static Run runOneLine(String line, RtkFilter filter) {
        RecordingShell shell = new RecordingShell();
        ToolRegistry registry = new ToolRegistry();
        registry.register(shell);
        AtomicReference<JsonNode> gated = new AtomicReference<>();
        List<RunEvent> events = new ArrayList<>();
        Agent agent = new Agent(AgentOptions.builder()
                .provider(new OneShellCall(line))
                .systemPrompt("test")
                .registry(registry)
                .rtkFilter(filter)
                .onPermission(request -> {
                    gated.set(request.input());
                    return true;
                })
                .build());
        try (EventStream stream = agent.run("go", new RunOptions(new CancelSignal(), List.of()))) {
            for (RunEvent event : stream) {
                events.add(event);
            }
        }
        return new Run(events, shell.executed.get(), gated.get());
    }

    private static RunEvent.PermissionRequest gateEvent(List<RunEvent> events) {
        return events.stream()
                .filter(RunEvent.PermissionRequest.class::isInstance)
                .map(RunEvent.PermissionRequest.class::cast)
                .findFirst()
                .orElseThrow(() -> new AssertionError("no permission_request at all"));
    }

    private static RunEvent.ToolCall toolCallEvent(List<RunEvent> events) {
        return events.stream()
                .filter(RunEvent.ToolCall.class::isInstance)
                .map(RunEvent.ToolCall.class::cast)
                .findFirst()
                .orElseThrow(() -> new AssertionError("no tool_call at all"));
    }

    @Test
    void theGateIsAskedAboutTheLineThatWillActuallyRun() {
        Run run = runOneLine("ls -la",
                new RtkFilter(() -> true, new ScriptedOracle("rtk ls -la")));

        assertEquals("rtk ls -la", run.executed(), "the shell got the rewritten line");
        assertNotNull(run.gated(), "the gate was asked");
        assertEquals(run.executed(), run.gated().path(RtkFilter.COMMAND_FIELD).asText(),
                "the string the gate decided on IS the string that ran");
        assertEquals("rtk ls -la",
                gateEvent(run.events()).input().path(RtkFilter.COMMAND_FIELD).asText(),
                "and the recorded gate event says the same");
    }

    @Test
    void theOperatorSeesBothLinesAndWhoChangedIt() {
        Run run = runOneLine("ls -la",
                new RtkFilter(() -> true, new ScriptedOracle("rtk ls -la")));
        JsonNode gate = gateEvent(run.events()).input();

        assertEquals("ls -la", gate.path(RtkFilter.ORIGINAL_FIELD).asText(),
                "the command the model wrote travels beside the one that ran");
        assertEquals(RtkFilter.REWRITER, gate.path(RtkFilter.REWRITER_FIELD).asText(),
                "and the rewrite is marked as spectro's, not left to be guessed");
        assertEquals("ls -la", toolCallEvent(run.events()).input()
                        .path(RtkFilter.COMMAND_FIELD).asText(),
                "the tool_call event is what the MODEL said and must stay that");
    }

    @Test
    void offLeavesTheEventsExactlyAsTheyWereBeforeThisCard() {
        Run run = runOneLine("ls -la",
                new RtkFilter(() -> false, new ScriptedOracle("rtk ls -la")));
        JsonNode gate = gateEvent(run.events()).input();

        assertEquals("ls -la", run.executed());
        assertEquals("ls -la", gate.path(RtkFilter.COMMAND_FIELD).asText());
        assertFalse(gate.has(RtkFilter.ORIGINAL_FIELD),
                "an untouched call gains no field at all");
        assertFalse(gate.has(RtkFilter.REWRITER_FIELD));
    }

    /** Criterion 9 at the seam the tool really uses: {@code run_command} itself,
     *  not a helper called beside it. A rewritten call runs with rtk's telemetry
     *  refused, and an untouched one carries nothing. The second half matters,
     *  because a variable set for every command would make the first half green
     *  without proving anything. */
    @Test
    void theShippedRunCommandRefusesRtksTelemetryOnlyForARewrittenLine(
            @org.junit.jupiter.api.io.TempDir java.nio.file.Path cwd) {
        Tool shell = dev.spectroscope.core.tools.StandardTools.all(30).stream()
                .filter(t -> "run_command".equals(t.name()))
                .findFirst()
                .orElseThrow(() -> new AssertionError("no run_command in the shipped belt"));
        String line = "printenv " + RtkFilter.TELEMETRY_ENV + " || echo ABSENT";

        JsonNode rewritten = new RtkFilter(() -> true, new ScriptedOracle(line))
                .apply("run_command",
                        JSON.createObjectNode().put(RtkFilter.COMMAND_FIELD, "anything else"));
        assertEquals("1", shell.execute(rewritten, context(cwd)).strip());

        JsonNode plain = JSON.createObjectNode().put(RtkFilter.COMMAND_FIELD, line);
        assertEquals("ABSENT", shell.execute(plain, context(cwd)).strip());
    }

    private static Tool.ToolContext context(java.nio.file.Path cwd) {
        return new Tool.ToolContext(cwd, new CancelSignal(), "main", "c1",
                verdict -> { }, attachment -> { }, change -> { }, waited -> { });
    }

    @Test
    void anAgentWiredWithoutTheFilterBehavesExactlyAsBefore() {
        Run run = runOneLine("ls -la", null);

        assertEquals("ls -la", run.executed());
        assertFalse(gateEvent(run.events()).input().has(RtkFilter.REWRITER_FIELD));
    }
}
