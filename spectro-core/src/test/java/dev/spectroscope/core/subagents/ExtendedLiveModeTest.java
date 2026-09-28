package dev.spectroscope.core.subagents;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.Agent;
import dev.spectroscope.core.AgentOptions;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.EventStream;
import dev.spectroscope.core.PermissionBroker;
import dev.spectroscope.core.RunOptions;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.events.RunEvent.PermissionRequest;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.tools.StandardTools;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.tools.ToolRegistry;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Queue;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 453, criterion 5: the LIVE mode decides, per tool call, and a child
 * agent follows its parent's current mode because it shares the parent's
 * broker.
 */
@Timeout(value = 30, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class ExtendedLiveModeTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static final String REFUSAL = "ERROR: path is outside the working directory: ../note.txt";

    @TempDir
    Path outer;

    private Path cwd;

    @BeforeEach
    void layout() throws IOException {
        cwd = Files.createDirectories(outer.resolve("inner"));
        Files.writeString(outer.resolve("note.txt"), "outside line\n");
    }

    /** A broker whose mode the test switches, the way the composer switch does. */
    private static final class Switchable implements PermissionBroker {
        volatile boolean extended;

        Switchable(boolean extended) {
            this.extended = extended;
        }

        @Override
        public boolean decide(PermissionRequest request) {
            return true;
        }

        @Override
        public boolean reachesOutsideTheWorkingDirectory() {
            return extended;
        }
    }

    private static Tool readFile() {
        return StandardTools.all().stream().filter(t -> t.name().equals("read_file"))
                .findFirst().orElseThrow();
    }

    private static List<LlmProvider.ProviderEvent> readNote(String callId) {
        return List.of(new LlmProvider.PToolCall(callId, "read_file",
                        JSON.createObjectNode().put("path", "../note.txt")),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE));
    }

    private static List<LlmProvider.ProviderEvent> done() {
        return List.of(new LlmProvider.PTextDelta("done"),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN));
    }

    private static List<String> outputs(List<RunEvent> events, boolean childOnly) {
        return events.stream()
                .filter(RunEvent.ToolResult.class::isInstance)
                .map(RunEvent.ToolResult.class::cast)
                .filter(r -> !childOnly || !"main".equals(r.agentId()))
                .map(RunEvent.ToolResult::output)
                .toList();
    }

    @Test
    void switchingBackToAskClosesTheFenceOnTheNextCall() {
        Switchable broker = new Switchable(true);
        Queue<List<LlmProvider.ProviderEvent>> turns = new ConcurrentLinkedQueue<>(
                List.of(readNote("c1"), readNote("c2"), done()));
        LlmProvider provider = request -> {
            if (turns.size() == 2) {
                broker.extended = false; // the operator switched to ask between the two calls
            }
            return turns.poll();
        };
        ToolRegistry registry = new ToolRegistry();
        registry.register(readFile());
        Agent agent = new Agent(AgentOptions.builder()
                .provider(provider)
                .systemPrompt("test")
                .registry(registry)
                .cwd(cwd)
                .onPermission(broker)
                .build());
        List<RunEvent> events = new ArrayList<>();
        try (EventStream stream = agent.run("read it twice", new RunOptions(new CancelSignal(), null))) {
            stream.forEach(events::add);
        }

        assertEquals(List.of("outside line\n", REFUSAL), outputs(events, false),
                "the first call ran in extended, the second after the switch back to ask");
    }

    /** Parent turns are scripted; the child reads the note once and stops. */
    private static final class ParentAndChild implements LlmProvider {
        final Queue<List<ProviderEvent>> parentTurns = new ConcurrentLinkedQueue<>();
        final Queue<List<ProviderEvent>> childTurns = new ConcurrentLinkedQueue<>();

        @Override
        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            Queue<List<ProviderEvent>> source =
                    request.system().contains("subagent") ? childTurns : parentTurns;
            List<ProviderEvent> turn = source.poll();
            if (turn == null) {
                throw new IllegalStateException("no scripted turn left");
            }
            return turn;
        }
    }

    private List<RunEvent> runChild(Switchable broker) {
        ParentAndChild provider = new ParentAndChild();
        provider.parentTurns.add(List.of(
                new LlmProvider.PToolCall("p1", "spawn_agent",
                        JSON.createObjectNode().put("type", "explore").put("task", "read the note")),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE)));
        provider.parentTurns.add(done());
        provider.childTurns.add(readNote("k1"));
        provider.childTurns.add(done());
        SubagentManager manager = new SubagentManager(SubagentConfig.builder()
                .provider(provider)
                .cwd(cwd)
                .parentAgentId("main")
                .onPermission(broker)
                .baseTools(List.of(readFile()))
                .maxTurns(3)
                .build(), 30_000);
        ToolRegistry registry = new ToolRegistry();
        manager.tools().forEach(registry::register);
        Agent parent = new Agent(AgentOptions.builder()
                .provider(provider)
                .systemPrompt("You are the parent.")
                .registry(registry)
                .cwd(cwd)
                .agentId("main")
                .onPermission(broker)
                .build());
        List<RunEvent> events = new ArrayList<>();
        try (EventStream stream = manager.run(parent, "Delegate",
                new RunOptions(new CancelSignal(), null))) {
            stream.forEach(events::add);
        }
        assertTrue(events.stream().anyMatch(RunEvent.AgentSpawn.class::isInstance),
                "premise: a child was spawned");
        return events;
    }

    @Test
    void aChildOfAnExtendedParentReachesOutside() {
        assertEquals(List.of("outside line\n"), outputs(runChild(new Switchable(true)), true));
    }

    @Test
    void aChildOfAnAskParentIsFenced() {
        assertEquals(List.of(REFUSAL), outputs(runChild(new Switchable(false)), true));
    }
}
