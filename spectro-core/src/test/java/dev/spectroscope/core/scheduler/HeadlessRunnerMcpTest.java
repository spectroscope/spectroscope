package dev.spectroscope.core.scheduler;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.mcp.McpCallResult;
import dev.spectroscope.core.mcp.McpInitializeResult;
import dev.spectroscope.core.mcp.McpServerConfig;
import dev.spectroscope.core.mcp.McpServerRegistry;
import dev.spectroscope.core.mcp.McpToolDescriptor;
import dev.spectroscope.core.mcp.McpTransport;
import dev.spectroscope.core.provider.LlmProvider;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.Queue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 220, the owner's combined road on the runner itself: a settings-level
 * opt-in ({@code headlessMcp}, default false) that every headless face honours
 * because they all build this one runner, and a per-invocation override
 * ({@link HeadlessRunner#withMcp}) for the face that has a command line.
 *
 * <p>The wiring point is deliberately the same seam card 195 used for hooks —
 * one place, so {@code spectro run}, a cron fire and a triggered node cannot
 * drift apart. Unlike hooks, this seam is consent-gated: a hook can only ever
 * refuse a call, an MCP server can only ever add reach, and the constraint
 * order on the card puts permission above capability.
 */
@Timeout(value = 15, unit = TimeUnit.SECONDS)
class HeadlessRunnerMcpTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** One configured stdio server named "notes" — never actually spawned: the
     *  loader seam below intercepts before any transport exists. */
    private static final McpServerConfig NOTES =
            new McpServerConfig("notes", "/bin/echo", List.of(), null, null, null);

    private static SpectroConfig config(boolean headlessMcp, List<McpServerConfig> servers) {
        return new SpectroConfig(
                "anthropic", "claude-opus-4-8", "http://localhost:11434", 100_000, "ask",
                List.of(), "gemini", true, servers, 2, true,
                List.of(), null, "info", null, null, "auto", "auto", null, null, null, null, null,
                null, false, headlessMcp);
    }

    private static final class ScriptedProvider implements LlmProvider {
        final Queue<List<ProviderEvent>> turns = new ArrayDeque<>();
        final List<ProviderRequest> requests = new ArrayList<>();

        @Override
        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            requests.add(request);
            List<ProviderEvent> turn = turns.poll();
            if (turn == null) {
                throw new IllegalStateException("no scripted turn left");
            }
            return turn;
        }
    }

    /** An in-memory transport advertising one tool — the whole point of the
     *  {@link McpTransport} seam: no process, no I/O, no timeout. */
    private static final class ScriptedTransport implements McpTransport {
        boolean closed;

        @Override
        public McpInitializeResult initialize() {
            return new McpInitializeResult("2024-11-05", "notes", JSON.createObjectNode());
        }

        @Override
        public List<McpToolDescriptor> listTools() {
            return List.of(new McpToolDescriptor("search_notes", "Search the notes",
                    JSON.createObjectNode().put("type", "object")));
        }

        @Override
        public McpCallResult callTool(String toolName, JsonNode arguments) {
            return McpCallResult.ofText("three notes about the deploy runbook");
        }

        @Override
        public void close() {
            closed = true;
        }
    }

    /** A loader seam that counts and hands out a registry over the scripted
     *  transport — the runner must call it only when the opt-in says so. */
    private record CountingLoader(AtomicInteger loads, ScriptedTransport transport)
            implements HeadlessRunner.McpLoader {
        @Override
        public McpServerRegistry load(List<McpServerConfig> servers, Path cwd) {
            loads.incrementAndGet();
            return McpServerRegistry.load(servers, cwd, config -> transport);
        }
    }

    @Test
    void withTheSettingsOffNothingIsLoadedAndTheBeltStaysStandard(@TempDir Path cwd) {
        ScriptedProvider provider = new ScriptedProvider();
        provider.turns.add(List.of(
                new LlmProvider.PTextDelta("done"),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN)));
        AtomicInteger loads = new AtomicInteger();
        List<String> log = new ArrayList<>();

        HeadlessRunner.Outcome outcome = new HeadlessRunner(JSON, config(false, List.of(NOTES)), provider)
                .withMcpLoader(new CountingLoader(loads, new ScriptedTransport()))
                .runOnce("say done", cwd, false, null, null, log::add);

        assertTrue(outcome.exitOk());
        assertEquals(0, loads.get(),
                "default OFF means the registry loader is never even called — the startup"
                        + " cost of a mount is paid only on an opt-in (card 220, honesty item 7)");
        assertTrue(provider.requests.getFirst().tools().stream()
                        .noneMatch(tool -> tool.name().startsWith("mcp__")),
                "no opt-in, no mcp__ tool on the wire");
        assertTrue(log.stream().noneMatch(line -> line.startsWith("mcp:")),
                "a run that mounted nothing must not claim otherwise");
    }

    @Test
    void theSettingsOptInMountsAndTheModelSeesAndCallsTheTool(@TempDir Path cwd) {
        ScriptedProvider provider = new ScriptedProvider();
        provider.turns.add(List.of(
                new LlmProvider.PToolCall("c1", "mcp__notes__search_notes",
                        JSON.createObjectNode().put("query", "deploy runbook")),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE)));
        provider.turns.add(List.of(
                new LlmProvider.PTextDelta("found them"),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN)));
        AtomicInteger loads = new AtomicInteger();
        ScriptedTransport transport = new ScriptedTransport();
        List<RunEvent> events = new ArrayList<>();
        List<String> log = new ArrayList<>();

        HeadlessRunner.Outcome outcome = new HeadlessRunner(JSON, config(true, List.of(NOTES)), provider)
                .withMcpLoader(new CountingLoader(loads, transport))
                .runOnce("search my notes", cwd, true, null, events::add, log::add);

        assertTrue(outcome.exitOk(), "stop=" + outcome.stopReason());
        assertEquals(1, loads.get(), "one run, one mount");
        assertTrue(provider.requests.getFirst().tools().stream()
                        .anyMatch(tool -> "mcp__notes__search_notes".equals(tool.name())),
                "the settings opt-in puts the server's tool on the wire, exactly like the REPL");
        RunEvent.ToolResult result = events.stream()
                .filter(RunEvent.ToolResult.class::isInstance)
                .map(RunEvent.ToolResult.class::cast)
                .findFirst().orElseThrow(() -> new AssertionError("no tool_result event"));
        assertTrue(result.output().contains("three notes about the deploy runbook"),
                "the MCP result flows back as an ordinary tool_result, got: " + result.output());
        assertTrue(transport.closed,
                "the registry is closed on the run's regular exit path — a stdio child"
                        + " outliving a fire is a defect of this road, not a cost of it");
    }

    @Test
    void aMountedRunSaysWhatItMountedInToolTerms(@TempDir Path cwd) {
        ScriptedProvider provider = new ScriptedProvider();
        provider.turns.add(List.of(
                new LlmProvider.PTextDelta("ok"),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN)));
        List<String> log = new ArrayList<>();

        new HeadlessRunner(JSON, config(true, List.of(NOTES)), provider)
                .withMcpLoader(new CountingLoader(new AtomicInteger(), new ScriptedTransport()))
                .runOnce("say ok", cwd, true, null, null, log::add);

        // AC: the run's own output names the mount and what --permissions auto
        // approves after it, in tool terms — not prose comfort.
        assertTrue(log.stream().anyMatch(line ->
                        line.startsWith("mcp: notes mounted")
                                && line.contains("mcp__notes__search_notes")),
                "the mount line names the server and every tool it contributed, got: " + log);
        assertTrue(log.stream().anyMatch(line ->
                        line.contains("--permissions auto approves")
                                && line.contains("every mounted MCP tool")
                                && line.contains("standard tools")),
                "the run states what auto approves after the mount — the nine sandboxed"
                        + " standard tools plus every mounted tool — got: " + log);
        assertTrue(log.stream().anyMatch(line -> line.contains("this run: auto")),
                "the statement names the policy THIS run actually holds, got: " + log);
    }

    @Test
    void aReadonlyMountedRunNamesItsOwnPolicyInsteadOfAutoComfort(@TempDir Path cwd) {
        ScriptedProvider provider = new ScriptedProvider();
        provider.turns.add(List.of(
                new LlmProvider.PTextDelta("ok"),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN)));
        List<String> log = new ArrayList<>();

        new HeadlessRunner(JSON, config(true, List.of(NOTES)), provider)
                .withMcpLoader(new CountingLoader(new AtomicInteger(), new ScriptedTransport()))
                .runOnce("say ok", cwd, false, null, null, log::add);

        assertTrue(log.stream().anyMatch(line -> line.contains("this run: readonly")
                        && line.contains("denied")),
                "a readonly run says its mounted tools will be denied, got: " + log);
    }

    @Test
    void theFlagOverridesTheSettingsInBothDirections(@TempDir Path cwd) {
        // --no-mcp beats a settings file that says true.
        ScriptedProvider first = new ScriptedProvider();
        first.turns.add(List.of(
                new LlmProvider.PTextDelta("ok"),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN)));
        AtomicInteger deniedLoads = new AtomicInteger();
        new HeadlessRunner(JSON, config(true, List.of(NOTES)), first)
                .withMcpLoader(new CountingLoader(deniedLoads, new ScriptedTransport()))
                .withMcp(false)
                .runOnce("say ok", cwd, false, null, null, line -> { });
        assertEquals(0, deniedLoads.get(),
                "--no-mcp declines the settings' consent for this one invocation");

        // --mcp beats a settings file that says false (or says nothing).
        ScriptedProvider second = new ScriptedProvider();
        second.turns.add(List.of(
                new LlmProvider.PTextDelta("ok"),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN)));
        AtomicInteger grantedLoads = new AtomicInteger();
        new HeadlessRunner(JSON, config(false, List.of(NOTES)), second)
                .withMcpLoader(new CountingLoader(grantedLoads, new ScriptedTransport()))
                .withMcp(true)
                .runOnce("say ok", cwd, false, null, null, line -> { });
        assertEquals(1, grantedLoads.get(),
                "--mcp is the operator asking by name; the settings stay untouched");
        assertTrue(second.requests.getFirst().tools().stream()
                        .anyMatch(tool -> "mcp__notes__search_notes".equals(tool.name())),
                "the flag-mounted run sends the tool to the model");
    }

    @Test
    void anEmptyServerListMountsNothingEvenWithConsent(@TempDir Path cwd) {
        ScriptedProvider provider = new ScriptedProvider();
        provider.turns.add(List.of(
                new LlmProvider.PTextDelta("ok"),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN)));
        AtomicInteger loads = new AtomicInteger();

        new HeadlessRunner(JSON, config(true, List.of()), provider)
                .withMcpLoader(new CountingLoader(loads, new ScriptedTransport()))
                .runOnce("say ok", cwd, false, null, null, line -> { });

        assertEquals(0, loads.get(),
                "consent over an empty mcpServers block mounts nothing and pays nothing —"
                        + " a run with no server configured behaves exactly as today");
    }

    @Test
    void theRegistryIsClosedWhenTheRunItselfFails(@TempDir Path cwd) {
        // The failure exit path: the provider throws mid-run. runOnce folds the
        // failure into the outcome — and the teardown must still happen, the way
        // DoctorCommand's finally closes its probe.
        ScriptedProvider provider = new ScriptedProvider(); // no scripted turn -> throws
        ScriptedTransport transport = new ScriptedTransport();

        HeadlessRunner.Outcome outcome = new HeadlessRunner(JSON, config(true, List.of(NOTES)), provider)
                .withMcpLoader(new CountingLoader(new AtomicInteger(), transport))
                .runOnce("say ok", cwd, false, null, null, line -> { });

        assertFalse(outcome.exitOk(), "no scripted turn means the run failed — the premise");
        assertTrue(transport.closed,
                "the registry is closed on the FAILURE path too — a leaked stdio child"
                        + " outliving a cron fire is the defect card 221 just spent a card on");
    }

    @Test
    void theCronFaceHonoursTheSameSwitch(@TempDir Path cwd) {
        // runJob is the cron scheduler's whole entry point; it must not need its
        // own wiring — the owner's "settings switch, wenn man mit der UI arbeitet"
        // half covers a fire precisely because the fire reads the same config.
        ScriptedProvider provider = new ScriptedProvider();
        provider.turns.add(List.of(
                new LlmProvider.PTextDelta("done"),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN)));
        AtomicInteger loads = new AtomicInteger();
        ScriptedTransport transport = new ScriptedTransport();

        Job job = new Job("nightly", "0 0 * * *", "say done", cwd.toString(), "readonly");
        JobState state = new HeadlessRunner(JSON, config(true, List.of(NOTES)), provider)
                .withMcpLoader(new CountingLoader(loads, transport))
                .runJob(job, line -> { });

        assertEquals(JobState.OK, state.status(), "the fire itself succeeded — the premise");
        assertEquals(1, loads.get(), "a cron fire mounts when the settings consent, no flag anywhere");
        assertTrue(transport.closed, "and the fire's registry is closed like any run's");
    }
}
