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
 */
public record AgentOptions(LlmProvider provider, String systemPrompt, ToolRegistry registry,
                           Path cwd, PermissionBroker onPermission, String agentId, String parentId,
                           List<ProviderMessage> initialMessages, String providerName,
                           Integer maxTokens, Integer compactionThreshold, Boolean introspection,
                           Boolean thinking, HookRunner hooks, LlmWireRecorder llmWire,
                           dev.spectroscope.core.provider.ExchangeLatency latency) {

    /** Compat: the pre-270 arity. A caller without a latency window measures
     *  nothing and behaves exactly as before. */
    public AgentOptions(LlmProvider provider, String systemPrompt, ToolRegistry registry,
                        Path cwd, PermissionBroker onPermission, String agentId, String parentId,
                        List<ProviderMessage> initialMessages, String providerName,
                        Integer maxTokens, Integer compactionThreshold, Boolean introspection,
                        Boolean thinking, HookRunner hooks, LlmWireRecorder llmWire) {
        this(provider, systemPrompt, registry, cwd, onPermission, agentId, parentId,
                initialMessages, providerName, maxTokens, compactionThreshold,
                introspection, thinking, hooks, llmWire, null);
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
                introspection, thinking, hooks, null, null);
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

        /** Freezes the wiring.
         *  @return the immutable options record as configured so far */
        public AgentOptions build() {
            return new AgentOptions(provider, systemPrompt, registry, cwd, onPermission,
                    agentId, parentId, initialMessages, providerName, maxTokens, compactionThreshold,
                    introspection, thinking, hooks, llmWire, latency);
        }
    }
}
