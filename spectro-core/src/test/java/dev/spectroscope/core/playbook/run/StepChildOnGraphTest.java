package dev.spectroscope.core.playbook.run;

import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.graph.Channel;
import dev.spectroscope.core.graph.GraphState;
import dev.spectroscope.core.graph.ListSink;
import dev.spectroscope.core.graph.RunConfig;
import dev.spectroscope.core.graph.StateGraph;
import dev.spectroscope.core.graph.StateSchema;
import dev.spectroscope.core.graph.StateUpdate;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.provider.SwitchableProvider;
import dev.spectroscope.core.subagents.AgentType;
import dev.spectroscope.core.subagents.SubagentConfig;
import dev.spectroscope.core.subagents.SubagentManager;
import org.junit.jupiter.api.Test;

import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class StepChildOnGraphTest {

    /** Answers every request with one fixed turn and counts the requests. */
    static final class OneTurn implements LlmProvider {
        final String model;
        final String text;
        final AtomicInteger calls = new AtomicInteger();

        OneTurn(String model, String text) {
            this.model = model;
            this.text = text;
        }

        @Override
        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            calls.incrementAndGet();
            return List.of(new PTextDelta(text), new PUsage(3, 2), new PStop(PStop.StopReason.END_TURN));
        }

        @Override
        public String modelName() {
            return model;
        }
    }

    static SubagentManager manager(LlmProvider sessionProvider) {
        return new SubagentManager(SubagentConfig.builder()
                .provider(sessionProvider)
                .cwd(Path.of("."))
                .parentAgentId("main")
                .onPermission(request -> true)
                .baseTools(List.of())
                .build());
    }

    @Test
    void aGraphNodeRunsAChildOnItsOwnProviderWithNoParentRun() throws Exception {
        OneTurn session = new OneTurn("session-model", "wrong provider");
        OneTurn step = new OneTurn("step-model", "step done");
        SubagentManager manager = manager(session);
        List<RunEvent> events = new CopyOnWriteArrayList<>();
        ListSink sink = new ListSink();

        StateGraph graph = new StateGraph(StateSchema.of(Channel.lastWriteWins("answer")));
        graph.addNode("implement", state -> {
            SubagentManager.StepResult result = manager.runStep(new SubagentManager.StepChild(AgentType.WORKER,
                    "do the step", "do the step", "playbook:implement",
                    new SwitchableProvider(step, "stepprov")), events::add, new CancelSignal());
            return StateUpdate.of("answer", result.answer());
        });
        graph.addEdge(StateGraph.START, "implement");
        graph.addEdge("implement", StateGraph.END);
        GraphState out = graph.compile(sink).invoke(GraphState.empty(), RunConfig.defaults());

        assertEquals("step done", out.get("answer"));
        assertEquals(0, session.calls.get(), "the manager's own provider is never asked");
        assertEquals(1, step.calls.get());
        RunEvent.RunStart start = events.stream().filter(RunEvent.RunStart.class::isInstance)
                .map(RunEvent.RunStart.class::cast).findFirst().orElseThrow();
        assertEquals("stepprov", start.provider());
        assertEquals("step-model", start.model());
        assertEquals("worker-1", start.agentId());
        assertTrue(events.stream().anyMatch(e -> e instanceof RunEvent.AgentMessage m
                && "playbook:implement".equals(m.label()) && "task".equals(m.role())));
        assertTrue(events.stream().anyMatch(e -> e instanceof RunEvent.AgentMessage m
                && "result".equals(m.role()) && "completed".equals(m.state())));
        List<Object> types = sink.records().stream().map(r -> r.get("type")).toList();
        assertTrue(types.contains("node_start") && types.contains("node_end") && types.contains("graph_end"), types.toString());
    }

    @Test
    void aNullProviderMeansTheManagersOwn() {
        OneTurn session = new OneTurn("session-model", "own provider");
        SubagentManager manager = manager(session);
        SubagentManager.StepResult result = manager.runStep(new SubagentManager.StepChild(AgentType.EXPLORE,
                "read", "read", "playbook:review", null), e -> { }, new CancelSignal());
        assertEquals(1, session.calls.get());
        assertEquals("own provider", result.answer());
        assertEquals("explore-1", result.childId());
    }

    @Test
    void aCancelledSignalEndsTheChildAsAnError() {
        OneTurn session = new OneTurn("session-model", "never read");
        CancelSignal signal = new CancelSignal();
        signal.cancel();
        SubagentManager.StepResult result = manager(session).runStep(new SubagentManager.StepChild(
                AgentType.WORKER, "work", "work", "playbook:x", null), e -> { }, signal);
        assertTrue(result.failed(), result.outcome());
        assertEquals("", result.answer());
    }
}
