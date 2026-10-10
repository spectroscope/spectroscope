package dev.spectroscope.server.session;

import dev.spectroscope.core.Agent;
import dev.spectroscope.core.Asker;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.EventStream;
import dev.spectroscope.core.PermissionBroker;
import dev.spectroscope.core.RunOptions;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.playbook.Playbook;
import dev.spectroscope.core.playbook.run.PlaybookHost;
import dev.spectroscope.core.playbook.run.Probe;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.provider.SwitchableProvider;
import dev.spectroscope.core.subagents.SubagentManager;
import dev.spectroscope.server.providers.ProviderRow;

import java.nio.file.Path;
import java.util.List;
import java.util.function.BiFunction;
import java.util.function.Consumer;
import java.util.function.Function;
import java.util.function.Supplier;

/** Card 482: the session's side of a playbook run: the drain, the chat agent, providers, the registry, the gate. */
final class SessionPlaybookHost implements PlaybookHost {

    private static final String MAIN = SessionConnection.MAIN_AGENT_ID;

    private final Path workspace;
    private final Consumer<RunEvent> emit;
    private final SubagentManager subagents;
    private final Agent agent;
    private final Supplier<SpectroConfig> config;
    private final BiFunction<String, String, String> switcher;
    private final Function<SpectroConfig, LlmProvider> builder;
    private final Function<String, ProviderRow> check;
    private final Function<String, String> kindOf;
    private final Consumer<String> floor;
    private final PermissionBroker broker;
    private final Asker asker;

    /**
     * @param workspace the session's working folder
     * @param emit      the session drain: file first, then socket
     * @param subagents the session's manager; the chat turn runs through it
     * @param agent     the session's main agent
     * @param config    the session's live config
     * @param switcher  the chat model switch; answers null or the refusal
     * @param builder   builds a provider from a config
     * @param check     the registry's bounded check of one provider
     * @param kindOf    local, cloud or builtin by provider name, without a request
     * @param floor     sets or clears the step's permission floor
     * @param broker    the session's gate
     * @param asker     the session's asker
     */
    SessionPlaybookHost(Path workspace, Consumer<RunEvent> emit, SubagentManager subagents, Agent agent,
                        Supplier<SpectroConfig> config, BiFunction<String, String, String> switcher,
                        Function<SpectroConfig, LlmProvider> builder, Function<String, ProviderRow> check,
                        Function<String, String> kindOf, Consumer<String> floor,
                        PermissionBroker broker, Asker asker) {
        this.workspace = workspace;
        this.emit = emit;
        this.subagents = subagents;
        this.agent = agent;
        this.config = config;
        this.switcher = switcher;
        this.builder = builder;
        this.check = check;
        this.kindOf = kindOf;
        this.floor = floor;
        this.broker = broker;
        this.asker = asker;
    }

    @Override
    public Path workspace() {
        return workspace;
    }

    @Override
    public void emit(RunEvent event) {
        emit.accept(event);
    }

    @Override
    public ChatTurn chatTurn(String recordPrompt, String modelPrompt, CancelSignal signal) {
        String mainRun = null;
        String stop = "error";
        StringBuilder last = new StringBuilder();
        try (EventStream events = subagents.run(agent, recordPrompt,
                new RunOptions(signal, List.of(), modelPrompt.equals(recordPrompt) ? null : modelPrompt))) {
            for (RunEvent event : events) {
                emit.accept(event);
                if (event instanceof RunEvent.RunStart s && MAIN.equals(s.agentId()) && mainRun == null) {
                    mainRun = s.runId();
                } else if (event instanceof RunEvent.TurnStart t && MAIN.equals(t.agentId())) {
                    last.setLength(0);
                } else if (event instanceof RunEvent.TextDelta d && MAIN.equals(d.agentId())) {
                    last.append(d.text());
                } else if (event instanceof RunEvent.RunEnd e && e.runId().equals(mainRun)) {
                    stop = e.stopReason();
                }
            }
        }
        return new ChatTurn(stop, last.toString().strip());
    }

    @Override
    public Playbook.ModelRef chatModel() {
        SpectroConfig c = config.get();
        return new Playbook.ModelRef(c.provider(), c.model());
    }

    @Override
    public String switchChat(Playbook.ModelRef ref) {
        return switcher.apply(ref.provider(), ref.model());
    }

    @Override
    public LlmProvider providerFor(Playbook.ModelRef ref) {
        try {
            return new SwitchableProvider(builder.apply(config.get().withProvider(ref.provider(), ref.model())),
                    ref.provider());
        } catch (RuntimeException refused) {
            throw new IllegalStateException(refused.getMessage(), refused);
        }
    }

    @Override
    public Probe probe(String provider) {
        ProviderRow row = check.apply(provider);
        return new Probe(row.id(), row.kind(), row.state(), row.endpoint(), row.reason(), row.models(), row.live(),
                row.checkedAt());
    }

    @Override
    public String kindOf(String provider) {
        return kindOf.apply(provider);
    }

    @Override
    public void permissionFloor(String mode) {
        floor.accept(mode);
    }

    @Override
    public PermissionBroker broker() {
        return broker;
    }

    @Override
    public Asker asker() {
        return asker;
    }
}
