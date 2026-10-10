package dev.spectroscope.server.session;

import dev.spectroscope.core.Agent;
import dev.spectroscope.core.AgentOptions;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.playbook.Playbook;
import dev.spectroscope.core.playbook.run.PlaybookHost;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.subagents.SubagentConfig;
import dev.spectroscope.core.subagents.SubagentManager;
import dev.spectroscope.core.tools.ToolRegistry;
import dev.spectroscope.server.providers.ProviderRow;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Card 482: the session's side of a playbook run, driven without a socket. */
class SessionPlaybookHostTest {

    @TempDir Path ws;

    static LlmProvider says(String model, String text) {
        return new LlmProvider() {
            @Override
            public Iterable<ProviderEvent> stream(ProviderRequest request) {
                return List.of(new PTextDelta(text), new PUsage(2, 1), new PStop(PStop.StopReason.END_TURN));
            }

            @Override
            public String modelName() {
                return model;
            }
        };
    }

    @Test
    void aChatTurnRunsThroughTheDrainAndReportsItsStop() {
        LlmProvider chat = says("chat-model", "The plan is written.");
        Agent agent = new Agent(AgentOptions.builder().provider(chat).systemPrompt("s").registry(new ToolRegistry())
                .onPermission(r -> true).cwd(ws).agentId("main").build());
        SubagentManager subagents = new SubagentManager(SubagentConfig.builder().provider(chat).cwd(ws)
                .parentAgentId("main").onPermission(r -> true).baseTools(List.of()).build());
        List<RunEvent> drained = new CopyOnWriteArrayList<>();
        AtomicReference<SpectroConfig> config = new AtomicReference<>(SpectroConfig.load(
                new SpectroConfig.Overrides("ollama", "qwen3:8b", null, null, null, ws.toString())));
        List<String> floors = new ArrayList<>();
        SessionPlaybookHost host = new SessionPlaybookHost(ws, drained::add, subagents, agent, config::get,
                (p, m) -> null, c -> says(c.model(), "built"),
                p -> new ProviderRow(p, "local", "reachable", false, null, "http://localhost:11434",
                        List.of("qwen3:8b"), true, null, 7L),
                p -> "local", floors::add, r -> true, q -> null);

        PlaybookHost.ChatTurn turn = host.chatTurn("Playbook T, step Plan (plan).", "with skills", new CancelSignal());

        assertThat(turn.stopReason()).isEqualTo("end_turn");
        assertThat(turn.lastText()).isEqualTo("The plan is written.");
        assertThat(drained).anySatisfy(e -> assertThat(e).isInstanceOfSatisfying(RunEvent.RunStart.class,
                s -> assertThat(s.prompt()).isEqualTo("Playbook T, step Plan (plan).")));
        assertThat(host.chatModel()).isEqualTo(new Playbook.ModelRef("ollama", "qwen3:8b"));
        assertThat(host.providerFor(new Playbook.ModelRef("lmstudio", "m")).providerName()).isEqualTo("lmstudio");
        assertThat(host.probe("ollama").endpoint()).isEqualTo("http://localhost:11434");
        assertThat(host.kindOf("ollama")).isEqualTo("local");
        assertThat(host.workspace()).isEqualTo(ws);
        host.permissionFloor("readonly");
        assertThat(floors).containsExactly("readonly");
    }

    @Test
    void aProviderThatCannotBeBuiltIsAnIllegalStateWithItsReason() {
        SessionPlaybookHost host = new SessionPlaybookHost(ws, e -> { }, null, null,
                () -> SpectroConfig.load(new SpectroConfig.Overrides("ollama", "qwen3:8b", null, null, null,
                        ws.toString())),
                (p, m) -> null, c -> { throw new IllegalArgumentException("ANTHROPIC_API_KEY is not set"); },
                p -> null, p -> "cloud", m -> { }, r -> true, q -> null);
        assertThatThrownBy(() -> host.providerFor(new Playbook.ModelRef("anthropic", "claude-opus-5-5")))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("ANTHROPIC_API_KEY");
    }

    @Test
    void theChatSwitchAnswersWithTheSwitchersRefusal() {
        List<String> asked = new ArrayList<>();
        SessionPlaybookHost host = new SessionPlaybookHost(ws, e -> { }, null, null,
                () -> SpectroConfig.load(new SpectroConfig.Overrides("ollama", "qwen3:8b", null, null, null,
                        ws.toString())),
                (p, m) -> {
                    asked.add(p + " " + m);
                    return "gemini".equals(p) ? "\"gemini\" needs GEMINI_API_KEY" : null;
                },
                c -> null, p -> null, p -> "cloud", m -> { }, r -> true, q -> null);
        assertThat(host.switchChat(new Playbook.ModelRef("ollama", "qwen3:8b"))).isNull();
        assertThat(host.switchChat(new Playbook.ModelRef("gemini", "g"))).contains("GEMINI_API_KEY");
        assertThat(asked).containsExactly("ollama qwen3:8b", "gemini g");
    }
}
