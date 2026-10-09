package dev.spectroscope.core;

import dev.spectroscope.core.hooks.HookRunner;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.provider.LlmProvider.ProviderMessage;
import dev.spectroscope.core.tools.ToolRegistry;
import dev.spectroscope.core.wire.LlmWireRecorder;

import java.nio.file.Path;
import java.util.List;

/**
 * All inputs an {@link Agent} needs. Built with {@link #builder()} — many fields are
 * optional. {@code agentId} defaults to "main". Fields beyond {@code maxTokens} are
 * consumed (sessions, subagents, config); they are declared now so the
 * options type never has to change.
 *
 * @param provider            the LLM backend the loop streams from
 * @param systemPrompt        system prompt sent with every provider request; may be empty
 * @param registry            the tool belt — specs go to the provider, implementations run here
 * @param cwd                 working directory the file tools resolve and sandbox against
 * @param onPermission        blocking human gate consulted before permission-needing tools
 * @param agentId             id stamped on every emitted event; "main" for the top-level agent
 * @param parentId            the spawning agent's id; null for the main agent
 * @param initialMessages     history seed of a resumed session; null starts fresh
 * @param providerName        build-time provider label for {@code run_start}, used when the
 *                            provider reports no live name of its own
 * @param maxTokens           output-token budget per provider call; null falls back to 32k
 * @param compactionThreshold input-token level that triggers compaction; null falls back to 100k
 * @param introspection       TRUE emits a {@code context_info} estimate each turn (additive)
 * @param thinking            TRUE requests the model's reasoning stream
 * @param hooks               external shell hooks around tool calls; null means no hooks
 * @param llmWire             the session's backend-to-LLM recorder; null records nothing
 * @param latency             the session's shared window of measured exchange
 *                            durations (card 270). Every completed provider
 *                            stream of this agent lands in it, and
 *                            {@code ChildBudget} derives a child's price from it —
 *                            so the parent's own measurements are what pay for
 *                            the children. Null measures nothing and changes no
 *                            behaviour
 * @param maxTurns            the runaway-loop brake — how many turns ONE run may
 *                            spend in total, continuations included (card 266).
 *                            Null falls back to 15, the number that was a
 *                            private constant until this card. It is an option
 *                            because a continuation effectively raises the
 *                            ceiling, and a ceiling that is the product of two
 *                            numbers, only one of which is visible, is not a
 *                            ceiling anybody can reason about
 * @param continuationLeash   the harness's leash on a run that stopped with its
 *                            own plan still open (card 266); null never
 *                            continues anything and leaves the loop exactly as
 *                            it was. Wired only on the faces where somebody is
 *                            watching the bill, the same fence card 262 uses
 * @param progressGuard       the harness's eye on a run that is going nowhere
 *                            (card 262); null watches nothing and leaves the
 *                            loop byte-identical to before. It carries its own
 *                            {@link dev.spectroscope.core.Asker}, so nothing
 *                            about the ask reaches this record — the guard is
 *                            one field, not a guard plus a person
 * @param goal                what this run is FOR, and the check that decides it
 *                            (card 267); null states nothing and leaves the loop
 *                            byte-identical to before. It carries its own
 *                            {@link dev.spectroscope.core.goal.GoalCheck}, for
 *                            the same reason the guard carries its own asker —
 *                            a statement wired without its teeth would be a goal
 *                            that grades itself
 * @param steering            what the operator typed while the run was already
 *                            working (card 380); null leaves the loop
 *                            byte-identical to before, which is what every
 *                            headless face wires. The holder is polled, never
 *                            called back: the socket thread writes into it and
 *                            the loop reads it once per turn, the shape card
 *                            267's goal already uses
 * @param rtkFilter           card 379: the last look at a tool call's input
 *                            before the permission gate sees it, so the gate is
 *                            asked about the line that will actually run. Null
 *                            rewrites nothing, which is the shipped state
 * @param sessionWindow       the context window the operator set for this session
 *                            (card 390), shared with every child the session
 *                            spawns; null sets nothing and leaves the loop
 *                            byte-identical to before. The loop reads it at the
 *                            top of every turn, the shape card 267's goal uses
 * @param toolResultElision   card 467: {@code "on"} or {@code "off"}, the
 *                            settings key of the same name. On, a tool result
 *                            more than a few turns old and above a size leaves
 *                            the outgoing request as a one-line stub, while the
 *                            history and the session file keep it whole. Null
 *                            is the shipped value, on
 * @param toolGroupsOff       card 466: the tool groups the operator switched off
 *                            for this session, read once at the start of every
 *                            run. A switched-off group is left out of the
 *                            provider request and out of the context ring, and
 *                            a call to one of its tools is refused as unknown.
 *                            Null switches nothing off, which is the shipped state
 */
public record AgentOptions(LlmProvider provider, String systemPrompt, ToolRegistry registry,
                           Path cwd, PermissionBroker onPermission, String agentId, String parentId,
                           List<ProviderMessage> initialMessages, String providerName,
                           Integer maxTokens, Integer compactionThreshold, Boolean introspection,
                           Boolean thinking, HookRunner hooks, LlmWireRecorder llmWire,
                           dev.spectroscope.core.provider.ExchangeLatency latency,
                           dev.spectroscope.core.progress.ProgressGuard progressGuard,
                           Integer maxTurns,
                           dev.spectroscope.core.loop.ContinuationLeash continuationLeash,
                           dev.spectroscope.core.goal.SessionGoal goal,
                           dev.spectroscope.core.steering.SteeringInbox steering,
                           dev.spectroscope.core.tools.RtkFilter rtkFilter,
                           dev.spectroscope.core.session.SessionWindow sessionWindow,
                           String toolResultElision,
                           java.util.function.Supplier<java.util.Set<ToolGroup>> toolGroupsOff) {

    /** Compat: the arity before cards 467 and 466, which knew no elision
     *  switch and no tool groups. A caller without them gets the shipped
     *  elision, on, and sends every registered tool, as before.
     *
     * @param provider            the LLM backend the loop streams from
     * @param systemPrompt        system prompt sent with every provider request
     * @param registry            the tool belt
     * @param cwd                 working directory the file tools resolve against
     * @param onPermission        blocking human gate
     * @param agentId             id stamped on every emitted event
     * @param parentId            the spawning agent's id; null for the main agent
     * @param initialMessages     history seed of a resumed session
     * @param providerName        build-time provider label for run_start
     * @param maxTokens           output-token budget per provider call
     * @param compactionThreshold input-token level that triggers compaction
     * @param introspection       TRUE emits a context_info estimate each turn
     * @param thinking            TRUE requests the model's reasoning stream
     * @param hooks               external shell hooks around tool calls
     * @param llmWire             the session's backend-to-LLM recorder
     * @param latency             the session's shared window of exchange durations
     * @param progressGuard       the harness's eye on a run going nowhere
     * @param maxTurns            the runaway-loop brake, in turns per run
     * @param continuationLeash   the leash that keeps an unfinished run going
     * @param goal                what this run is FOR, and the check that decides it
     * @param steering            what the operator typed while the run was working
     * @param rtkFilter           the rtk rewrite of a shell line before the gate
     * @param sessionWindow       the context window the operator set for this session */
    public AgentOptions(LlmProvider provider, String systemPrompt, ToolRegistry registry,
                        Path cwd, PermissionBroker onPermission, String agentId, String parentId,
                        List<ProviderMessage> initialMessages, String providerName,
                        Integer maxTokens, Integer compactionThreshold, Boolean introspection,
                        Boolean thinking, HookRunner hooks, LlmWireRecorder llmWire,
                        dev.spectroscope.core.provider.ExchangeLatency latency,
                        dev.spectroscope.core.progress.ProgressGuard progressGuard,
                        Integer maxTurns,
                        dev.spectroscope.core.loop.ContinuationLeash continuationLeash,
                        dev.spectroscope.core.goal.SessionGoal goal,
                        dev.spectroscope.core.steering.SteeringInbox steering,
                        dev.spectroscope.core.tools.RtkFilter rtkFilter,
                        dev.spectroscope.core.session.SessionWindow sessionWindow) {
        this(provider, systemPrompt, registry, cwd, onPermission, agentId, parentId,
                initialMessages, providerName, maxTokens, compactionThreshold, introspection,
                thinking, hooks, llmWire, latency, progressGuard, maxTurns, continuationLeash,
                goal, steering, rtkFilter, sessionWindow, null, null);
    }

    /** Compat: the arity before card 390, with cards 379 and 380 in it. Never
     *  released. A caller without a session window sets nothing, and the
     *  window is derived as before.
     *
     * @param provider            the LLM backend the loop streams from
     * @param systemPrompt        system prompt sent with every provider request
     * @param registry            the tool belt
     * @param cwd                 working directory the file tools resolve against
     * @param onPermission        blocking human gate
     * @param agentId             id stamped on every emitted event
     * @param parentId            the spawning agent's id; null for the main agent
     * @param initialMessages     history seed of a resumed session
     * @param providerName        build-time provider label for run_start
     * @param maxTokens           output-token budget per provider call
     * @param compactionThreshold input-token level that triggers compaction
     * @param introspection       TRUE emits a context_info estimate each turn
     * @param thinking            TRUE requests the model's reasoning stream
     * @param hooks               external shell hooks around tool calls
     * @param llmWire             the session's backend-to-LLM recorder
     * @param latency             the session's shared window of exchange durations
     * @param progressGuard       the harness's eye on a run going nowhere
     * @param maxTurns            the runaway-loop brake, in turns per run
     * @param continuationLeash   the leash that keeps an unfinished run going
     * @param goal                what this run is FOR, and the check that decides it
     * @param steering            what the operator typed while the run was working
     * @param rtkFilter           the rtk rewrite of a shell line before the gate */
    public AgentOptions(LlmProvider provider, String systemPrompt, ToolRegistry registry,
                        Path cwd, PermissionBroker onPermission, String agentId, String parentId,
                        List<ProviderMessage> initialMessages, String providerName,
                        Integer maxTokens, Integer compactionThreshold, Boolean introspection,
                        Boolean thinking, HookRunner hooks, LlmWireRecorder llmWire,
                        dev.spectroscope.core.provider.ExchangeLatency latency,
                        dev.spectroscope.core.progress.ProgressGuard progressGuard,
                        Integer maxTurns,
                        dev.spectroscope.core.loop.ContinuationLeash continuationLeash,
                        dev.spectroscope.core.goal.SessionGoal goal,
                        dev.spectroscope.core.steering.SteeringInbox steering,
                        dev.spectroscope.core.tools.RtkFilter rtkFilter) {
        this(provider, systemPrompt, registry, cwd, onPermission, agentId, parentId,
                initialMessages, providerName, maxTokens, compactionThreshold, introspection,
                thinking, hooks, llmWire, latency, progressGuard, maxTurns, continuationLeash,
                goal, steering, rtkFilter, null);
    }

    /** Compat: the arity of card 380's branch, goal and then the inbox. Never
     *  released. It is the one form of arity 21, and it is a prefix of the
     *  record. The branches of cards 379 and 390 each had a form of arity 21
     *  of their own; neither is kept, because two overloads of arity 21 would
     *  make a null in position 21 ambiguous. A caller without an rtk filter
     *  or a session window gets neither.
     *
     * @param provider            the LLM backend the loop streams from
     * @param systemPrompt        system prompt sent with every provider request
     * @param registry            the tool belt
     * @param cwd                 working directory the file tools resolve against
     * @param onPermission        blocking human gate
     * @param agentId             id stamped on every emitted event
     * @param parentId            the spawning agent's id; null for the main agent
     * @param initialMessages     history seed of a resumed session
     * @param providerName        build-time provider label for run_start
     * @param maxTokens           output-token budget per provider call
     * @param compactionThreshold input-token level that triggers compaction
     * @param introspection       TRUE emits a context_info estimate each turn
     * @param thinking            TRUE requests the model's reasoning stream
     * @param hooks               external shell hooks around tool calls
     * @param llmWire             the session's backend-to-LLM recorder
     * @param latency             the session's shared window of exchange durations
     * @param progressGuard       the harness's eye on a run going nowhere
     * @param maxTurns            the runaway-loop brake, in turns per run
     * @param continuationLeash   the leash that keeps an unfinished run going
     * @param goal                what this run is FOR, and the check that decides it
     * @param steering            what the operator typed while the run was working */
    public AgentOptions(LlmProvider provider, String systemPrompt, ToolRegistry registry,
                        Path cwd, PermissionBroker onPermission, String agentId, String parentId,
                        List<ProviderMessage> initialMessages, String providerName,
                        Integer maxTokens, Integer compactionThreshold, Boolean introspection,
                        Boolean thinking, HookRunner hooks, LlmWireRecorder llmWire,
                        dev.spectroscope.core.provider.ExchangeLatency latency,
                        dev.spectroscope.core.progress.ProgressGuard progressGuard,
                        Integer maxTurns,
                        dev.spectroscope.core.loop.ContinuationLeash continuationLeash,
                        dev.spectroscope.core.goal.SessionGoal goal,
                        dev.spectroscope.core.steering.SteeringInbox steering) {
        this(provider, systemPrompt, registry, cwd, onPermission, agentId, parentId,
                initialMessages, providerName, maxTokens, compactionThreshold, introspection,
                thinking, hooks, llmWire, latency, progressGuard, maxTurns, continuationLeash,
                goal, steering, null, null);
    }

    /** Compat: the arity before cards 379, 380 and 390, the canonical
     *  constructor 0.12.0 shipped. Every older compat below lands here. A
     *  caller without an inbox can never be steered, and the loop runs exactly
     *  as card 267 left it. A caller without an rtk filter runs every shell
     *  line exactly as the model wrote it, which is also what the shipped
     *  setting does. A caller without a session window sets nothing.
     *
     * @param provider            the LLM backend the loop streams from
     * @param systemPrompt        system prompt sent with every provider request
     * @param registry            the tool belt
     * @param cwd                 working directory the file tools resolve against
     * @param onPermission        blocking human gate
     * @param agentId             id stamped on every emitted event
     * @param parentId            the spawning agent's id; null for the main agent
     * @param initialMessages     history seed of a resumed session
     * @param providerName        build-time provider label for run_start
     * @param maxTokens           output-token budget per provider call
     * @param compactionThreshold input-token level that triggers compaction
     * @param introspection       TRUE emits a context_info estimate each turn
     * @param thinking            TRUE requests the model's reasoning stream
     * @param hooks               external shell hooks around tool calls
     * @param llmWire             the session's backend-to-LLM recorder
     * @param latency             the session's shared window of exchange durations
     * @param progressGuard       the harness's eye on a run going nowhere
     * @param maxTurns            the runaway-loop brake, in turns per run
     * @param continuationLeash   the leash that keeps an unfinished run going
     * @param goal                what this run is FOR, and the check that decides it */
    public AgentOptions(LlmProvider provider, String systemPrompt, ToolRegistry registry,
                        Path cwd, PermissionBroker onPermission, String agentId, String parentId,
                        List<ProviderMessage> initialMessages, String providerName,
                        Integer maxTokens, Integer compactionThreshold, Boolean introspection,
                        Boolean thinking, HookRunner hooks, LlmWireRecorder llmWire,
                        dev.spectroscope.core.provider.ExchangeLatency latency,
                        dev.spectroscope.core.progress.ProgressGuard progressGuard,
                        Integer maxTurns,
                        dev.spectroscope.core.loop.ContinuationLeash continuationLeash,
                        dev.spectroscope.core.goal.SessionGoal goal) {
        this(provider, systemPrompt, registry, cwd, onPermission, agentId, parentId,
                initialMessages, providerName, maxTokens, compactionThreshold, introspection,
                thinking, hooks, llmWire, latency, progressGuard, maxTurns, continuationLeash,
                goal, null, null, null);
    }

    /** Compat: the pre-267 arity. A caller without a goal states nothing, and
     *  the loop runs exactly as card 266 left it.
     *
     * @param provider            the LLM backend the loop streams from
     * @param systemPrompt        system prompt sent with every provider request
     * @param registry            the tool belt
     * @param cwd                 working directory the file tools resolve against
     * @param onPermission        blocking human gate
     * @param agentId             id stamped on every emitted event
     * @param parentId            the spawning agent's id; null for the main agent
     * @param initialMessages     history seed of a resumed session
     * @param providerName        build-time provider label for run_start
     * @param maxTokens           output-token budget per provider call
     * @param compactionThreshold input-token level that triggers compaction
     * @param introspection       TRUE emits a context_info estimate each turn
     * @param thinking            TRUE requests the model's reasoning stream
     * @param hooks               external shell hooks around tool calls
     * @param llmWire             the session's backend-to-LLM recorder
     * @param latency             the session's shared window of exchange durations
     * @param progressGuard       the harness's eye on a run going nowhere
     * @param maxTurns            the runaway-loop brake, in turns per run
     * @param continuationLeash   the leash that keeps an unfinished run going */
    public AgentOptions(LlmProvider provider, String systemPrompt, ToolRegistry registry,
                        Path cwd, PermissionBroker onPermission, String agentId, String parentId,
                        List<ProviderMessage> initialMessages, String providerName,
                        Integer maxTokens, Integer compactionThreshold, Boolean introspection,
                        Boolean thinking, HookRunner hooks, LlmWireRecorder llmWire,
                        dev.spectroscope.core.provider.ExchangeLatency latency,
                        dev.spectroscope.core.progress.ProgressGuard progressGuard,
                        Integer maxTurns,
                        dev.spectroscope.core.loop.ContinuationLeash continuationLeash) {
        this(provider, systemPrompt, registry, cwd, onPermission, agentId, parentId,
                initialMessages, providerName, maxTokens, compactionThreshold,
                introspection, thinking, hooks, llmWire, latency, progressGuard, maxTurns,
                continuationLeash, null);
    }

    /** Compat: the pre-266 arity. A caller without a turn cap gets the 15 that
     *  was a private constant, and one without a leash never continues a run.
     *
     * @param provider            the LLM backend the loop streams from
     * @param systemPrompt        system prompt sent with every provider request
     * @param registry            the tool belt
     * @param cwd                 working directory the file tools resolve against
     * @param onPermission        blocking human gate
     * @param agentId             id stamped on every emitted event
     * @param parentId            the spawning agent's id; null for the main agent
     * @param initialMessages     history seed of a resumed session
     * @param providerName        build-time provider label for run_start
     * @param maxTokens           output-token budget per provider call
     * @param compactionThreshold input-token level that triggers compaction
     * @param introspection       TRUE emits a context_info estimate each turn
     * @param thinking            TRUE requests the model's reasoning stream
     * @param hooks               external shell hooks around tool calls
     * @param llmWire             the session's backend-to-LLM recorder
     * @param latency             the session's shared window of exchange durations
     * @param progressGuard       the harness's eye on a run going nowhere */
    public AgentOptions(LlmProvider provider, String systemPrompt, ToolRegistry registry,
                        Path cwd, PermissionBroker onPermission, String agentId, String parentId,
                        List<ProviderMessage> initialMessages, String providerName,
                        Integer maxTokens, Integer compactionThreshold, Boolean introspection,
                        Boolean thinking, HookRunner hooks, LlmWireRecorder llmWire,
                        dev.spectroscope.core.provider.ExchangeLatency latency,
                        dev.spectroscope.core.progress.ProgressGuard progressGuard) {
        this(provider, systemPrompt, registry, cwd, onPermission, agentId, parentId,
                initialMessages, providerName, maxTokens, compactionThreshold,
                introspection, thinking, hooks, llmWire, latency, progressGuard, null, null, null);
    }

    /** Compat: the pre-262 arity. A caller without a guard watches nothing —
     *  which is the shipped state of every face where nobody could answer.
     *
     * @param provider            the LLM backend the loop streams from
     * @param systemPrompt        system prompt sent with every provider request
     * @param registry            the tool belt
     * @param cwd                 working directory the file tools resolve against
     * @param onPermission        blocking human gate
     * @param agentId             id stamped on every emitted event
     * @param parentId            the spawning agent's id; null for the main agent
     * @param initialMessages     history seed of a resumed session
     * @param providerName        build-time provider label for run_start
     * @param maxTokens           output-token budget per provider call
     * @param compactionThreshold input-token level that triggers compaction
     * @param introspection       TRUE emits a context_info estimate each turn
     * @param thinking            TRUE requests the model's reasoning stream
     * @param hooks               external shell hooks around tool calls
     * @param llmWire             the session's backend-to-LLM recorder
     * @param latency             the session's shared window of exchange durations */
    public AgentOptions(LlmProvider provider, String systemPrompt, ToolRegistry registry,
                        Path cwd, PermissionBroker onPermission, String agentId, String parentId,
                        List<ProviderMessage> initialMessages, String providerName,
                        Integer maxTokens, Integer compactionThreshold, Boolean introspection,
                        Boolean thinking, HookRunner hooks, LlmWireRecorder llmWire,
                        dev.spectroscope.core.provider.ExchangeLatency latency) {
        this(provider, systemPrompt, registry, cwd, onPermission, agentId, parentId,
                initialMessages, providerName, maxTokens, compactionThreshold,
                introspection, thinking, hooks, llmWire, latency, null, null, null, null);
    }

    /** Compat: the pre-270 arity. A caller without a latency window measures
     *  nothing and behaves exactly as before. */
    public AgentOptions(LlmProvider provider, String systemPrompt, ToolRegistry registry,
                        Path cwd, PermissionBroker onPermission, String agentId, String parentId,
                        List<ProviderMessage> initialMessages, String providerName,
                        Integer maxTokens, Integer compactionThreshold, Boolean introspection,
                        Boolean thinking, HookRunner hooks, LlmWireRecorder llmWire) {
        this(provider, systemPrompt, registry, cwd, onPermission, agentId, parentId,
                initialMessages, providerName, maxTokens, compactionThreshold,
                introspection, thinking, hooks, llmWire, null, null, null, null, null);
    }

    /** Compat: the pre-wire arity. A caller without a recorder records nothing
     *  and behaves byte-identically to before (card 184's additive rule). */
    public AgentOptions(LlmProvider provider, String systemPrompt, ToolRegistry registry,
                        Path cwd, PermissionBroker onPermission, String agentId, String parentId,
                        List<ProviderMessage> initialMessages, String providerName,
                        Integer maxTokens, Integer compactionThreshold, Boolean introspection,
                        Boolean thinking, HookRunner hooks) {
        this(provider, systemPrompt, registry, cwd, onPermission, agentId, parentId,
                initialMessages, providerName, maxTokens, compactionThreshold,
                introspection, thinking, hooks, null, null, null, null, null, null);
    }

    /** Entry point of the fluent wiring — chain setters, finish with {@link Builder#build()}.
     *  @return a fresh builder carrying the defaults ({@code agentId} "main", empty prompt) */
    public static Builder builder() {
        return new Builder();
    }

    /** Fluent assembly of {@link AgentOptions}; every setter returns {@code this} for chaining. */
    public static final class Builder {
        private LlmProvider provider;
        private String systemPrompt = "";
        private ToolRegistry registry;
        private Path cwd = Path.of(".");
        private PermissionBroker onPermission;
        private String agentId = "main";
        private String parentId;
        private List<ProviderMessage> initialMessages;
        private String providerName;
        private Integer maxTokens;
        private Integer compactionThreshold;
        private Boolean introspection;
        private Boolean thinking;
        private HookRunner hooks; // nullable → no hooks (a no-op in Agent.runGuarded)
        private LlmWireRecorder llmWire; // nullable, records nothing without one
        private dev.spectroscope.core.provider.ExchangeLatency latency; // nullable, measures nothing
        private dev.spectroscope.core.progress.ProgressGuard progressGuard; // nullable, watches nothing
        private Integer maxTurns; // nullable → the shipped 15
        private dev.spectroscope.core.loop.ContinuationLeash continuationLeash; // nullable, never continues
        private dev.spectroscope.core.goal.SessionGoal goal; // nullable, states nothing
        private dev.spectroscope.core.steering.SteeringInbox steering; // nullable, never steered
        private dev.spectroscope.core.tools.RtkFilter rtkFilter; // nullable, rewrites nothing
        private dev.spectroscope.core.session.SessionWindow sessionWindow; // nullable, sets nothing
        private String toolResultElision; // nullable, the shipped "on"
        private java.util.function.Supplier<java.util.Set<ToolGroup>> toolGroupsOff; // nullable, nothing off

        /** The LLM backend the loop streams from — the one field without a usable default.
         *  @param value the provider implementation (real, fake, or a decorator chain) */
        public Builder provider(LlmProvider value) { this.provider = value; return this; }
        /** The instruction the model sees before any message.
         *  @param value the full system prompt text; empty keeps the model uninstructed */
        public Builder systemPrompt(String value) { this.systemPrompt = value; return this; }
        /** The tool belt of this agent.
         *  @param value registry whose specs go to the provider and whose implementations execute */
        public Builder registry(ToolRegistry value) { this.registry = value; return this; }
        /** Sandbox root for the file tools.
         *  @param value the working directory tool paths resolve against */
        public Builder cwd(Path value) { this.cwd = value; return this; }
        /** The human gate.
         *  @param value blocking callback that decides each permission request */
        public Builder onPermission(PermissionBroker value) { this.onPermission = value; return this; }
        /** Identity stamped on every emitted event.
         *  @param value the agent id; subagents override the "main" default */
        public Builder agentId(String value) { this.agentId = value; return this; }
        /** Marks a subagent.
         *  @param value the spawning agent's id; null keeps this the main agent */
        public Builder parentId(String value) { this.parentId = value; return this; }
        /** Seeds the history of a resumed session.
         *  @param value the replayed provider messages; null starts fresh */
        public Builder initialMessages(List<ProviderMessage> value) { this.initialMessages = value; return this; }
        /** Build-time provider label for {@code run_start}.
         *  @param value the name recorded when the provider reports no live one */
        public Builder providerName(String value) { this.providerName = value; return this; }
        /** Output budget per provider call.
         *  @param value the token cap; null falls back to the 32k default */
        public Builder maxTokens(Integer value) { this.maxTokens = value; return this; }
        /** When compaction kicks in.
         *  @param value the input-token threshold; null falls back to 100k */
        public Builder compactionThreshold(Integer value) { this.compactionThreshold = value; return this; }
        /** per-turn context introspection.
         *  @param value true to emit the chars/4 {@code context_info} estimate each turn */
        public Builder introspection(boolean value) { this.introspection = value; return this; }
        /** The model's reasoning stream.
         *  @param value true to request thinking deltas from the provider */
        public Builder thinking(boolean value) { this.thinking = value; return this; }
        /** External shell hooks around tool calls.
         *  @param value the hook runner; null means no hooks (skipped in the guarded path) */
        public Builder hooks(HookRunner value) { this.hooks = value; return this; }
        /** The session's backend-to-LLM wire recorder (card 184).
         *  @param value the recorder the provider taps ride on; null records nothing */
        public Builder llmWire(LlmWireRecorder value) { this.llmWire = value; return this; }
        /** The session's shared window of measured exchange durations (card 270)
         *  — what a child's derived budget is priced from.
         *  @param value the window every completed provider stream lands in;
         *               null measures nothing */
        public Builder latency(dev.spectroscope.core.provider.ExchangeLatency value) {
            this.latency = value;
            return this;
        }
        /** The harness's eye on a run that is going nowhere (card 262).
         *  @param value the guard, carrying its own asker; null watches nothing
         *               and leaves the loop exactly as it was
         *  @return this builder */
        public Builder progressGuard(dev.spectroscope.core.progress.ProgressGuard value) {
            this.progressGuard = value;
            return this;
        }

        /** The runaway-loop brake, in turns per run (card 266).
         *  @param value the cap; null keeps the shipped 15
         *  @return this builder */
        public Builder maxTurns(Integer value) { this.maxTurns = value; return this; }
        /** The leash that keeps an unfinished run going (card 266).
         *  @param value the leash; null never continues a run and leaves the
         *               loop byte-identical to before
         *  @return this builder */
        public Builder continuationLeash(dev.spectroscope.core.loop.ContinuationLeash value) {
            this.continuationLeash = value;
            return this;
        }

        /** What this run is FOR, and the check that decides it (card 267).
         *  @param value the session's goal, carrying its own check; null states
         *               nothing and leaves the loop byte-identical to before
         *  @return this builder */
        public Builder goal(dev.spectroscope.core.goal.SessionGoal value) {
            this.goal = value;
            return this;
        }

        /** What the operator typed while the run was already working (card 380).
         *  @param value the session's inbox; null can never be steered and
         *               leaves the loop byte-identical to before
         *  @return this builder */
        public Builder steering(dev.spectroscope.core.steering.SteeringInbox value) {
            this.steering = value;
            return this;
        }

        /** Card 379: the rtk seam, read on every call rather than snapshotted.
         *  @param value the filter; null rewrites nothing, which is what the
         *               shipped {@code rtkFilter: "off"} amounts to
         *  @return this builder */
        public Builder rtkFilter(dev.spectroscope.core.tools.RtkFilter value) {
            this.rtkFilter = value;
            return this;
        }

        /** The context window the operator set for this session (card 390).
         *  @param value the session's holder, shared with its children; null
         *               sets nothing and leaves the loop byte-identical to before
         *  @return this builder */
        public Builder sessionWindow(dev.spectroscope.core.session.SessionWindow value) {
            this.sessionWindow = value;
            return this;
        }

        /** Card 466: the tool groups this session switched off, read once at
         *  the start of every run so a change reaches the NEXT run of an agent
         *  that is already built.
         *  @param value the reader; null switches nothing off
         *  @return this builder */
        public Builder toolGroupsOff(java.util.function.Supplier<java.util.Set<ToolGroup>> value) {
            this.toolGroupsOff = value;
            return this;
        }

        /**
         * Card 467: whether old, large tool results leave the outgoing request.
         *
         * @param value {@code "on"}, {@code "off"}, or null for the shipped on
         * @return this builder
         */
        public Builder toolResultElision(String value) {
            this.toolResultElision = value;
            return this;
        }

        /** Freezes the wiring.
         *  @return the immutable options record as configured so far */
        public AgentOptions build() {
            return new AgentOptions(provider, systemPrompt, registry, cwd, onPermission,
                    agentId, parentId, initialMessages, providerName, maxTokens, compactionThreshold,
                    introspection, thinking, hooks, llmWire, latency, progressGuard,
                    maxTurns, continuationLeash, goal, steering, rtkFilter, sessionWindow,
                    toolResultElision, toolGroupsOff);
        }
    }
}
