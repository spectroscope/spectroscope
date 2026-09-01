package dev.spectroscope.core.subagents;

import dev.spectroscope.core.PermissionBroker;
import dev.spectroscope.core.hooks.HookRunner;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.wire.LlmWireRecorder;

import java.nio.file.Path;
import java.util.List;

/**
 * Everything the SubagentManager needs to build child agents. Built once per
 * CLI session from the same values the parent agent is built with.
 *
 * @param provider      the provider the children run on — the model lives in
 *                      the provider; pass the parent's instance
 * @param cwd           sandbox root, same as the parent's
 * @param parentAgentId agentId of the parent agent (CLI: "main")
 * @param onPermission  the same blocking y/N broker the parent uses;
 *                      request.agentId() tells the prompt who is asking
 * @param baseTools     the belt a child inherits, WITHOUT the spawn tools —
 *                      children must never be able to spawn (nesting depth 1 by
 *                      construction). Since card 270 the faces build this from
 *                      the SAME supplier step the parent's own belt comes from
 *                      (settings belt + MCP), so a tool added to the parent
 *                      cannot silently miss the children; what a role gives up
 *                      out of it is declared in {@link RoleCatalog#beltPolicy}
 * @param hooks         the same pre/post_tool_use hooks the parent runs — a
 *                      hook that blocks a tool must also block it on a child,
 *                      or delegation becomes a bypass (nullable → none)
 * @param llmWire       the session's backend-to-LLM recorder (card 184), the
 *                      SAME instance the parent writes on — children bind their
 *                      own agentId onto it (nullable → children record nothing)
 * @param webTools      the parent session's web tools (web_search, web_fetch,
 *                      browse_page), granted to RESEARCH children only (card
 *                      205). The SAME instances the parent registry carries, so
 *                      the card-199 tiers gate a child's call exactly like the
 *                      parent's — the role grants reach, never approval. A
 *                      face without web tools (headless, fleet) passes none,
 *                      and its research children hold none — the unattended
 *                      lanes stay closed (nullable → none)
 * @param compactionThreshold the parent's explicit {@code compactionThreshold},
 *                      or null when the operator set none. AC 3 of card 263 says
 *                      an explicit setting wins; without carrying it here a
 *                      parent pinned to 5,000 spawned children that derived
 *                      153,216 from the shared provider — a 30x divergence from
 *                      a stated instruction, and invisible, because children are
 *                      built without introspection and emit no {@code context_info}
 * @param budget        what a child may spend (card 270). Default: derived from
 *                      a fresh, unfed {@link dev.spectroscope.core.provider.ExchangeLatency},
 *                      which means the {@link ChildBudget#FLOOR_MS} floor governs.
 *                      A face that shares its parent agent's latency window pays
 *                      the measured price instead of the floor
 * @param maxTurns      the parent's turn ceiling, so a child stops where the
 *                      operator said a run stops (card 364). Until that card
 *                      {@code AgentOptions.Builder.maxTurns} had ONE caller in
 *                      the whole tree — the browser session — and every child
 *                      ran on {@code Agent.DEFAULT_MAX_TURNS} with the settings
 *                      key resolving perfectly and reaching nothing (nullable →
 *                      the child falls back to that default)
 * @param maxTokens     the parent's completion budget per provider call, same
 *                      card and same argument: the builder method existed, was
 *                      public, and had zero callers anywhere (nullable → the
 *                      child spends {@code Agent.DEFAULT_MAX_TOKENS})
 * @param thinking      whether reasoning is surfaced, carried for the reason
 *                      card 263 carries the threshold: an operator who turned
 *                      reasoning ON meant it for the tree, and a child's events
 *                      are merged into the very stream they would show up in.
 *                      Read ONCE, when the session's tool belt is built — a
 *                      grain coarser than the parent's, and this card's review
 *                      measured the gap rather than assuming it away. The
 *                      parent has a live setter ({@code Agent#setThinking});
 *                      the web header toggle and the REPL's {@code /think}
 *                      reach it and stop there, so a mid-session toggle moves
 *                      the parent alone and the children of that session go on
 *                      asking for what this field was built with until the next
 *                      one. {@code SubagentReachTest.aLiveThinkingToggleMoves
 *                      TheParentAloneUntilTheNextSession} holds that measured
 *                      (nullable → the provider's default)
 */
public record SubagentConfig(
        LlmProvider provider,
        Path cwd,
        String parentAgentId,
        PermissionBroker onPermission,
        List<Tool> baseTools,
        HookRunner hooks,
        LlmWireRecorder llmWire,
        List<Tool> webTools,
        ChildBudget budget,
        Integer compactionThreshold,
        Integer maxTurns,
        Integer maxTokens,
        Boolean thinking) {

    /** Null-tolerant canonical: an absent web grant normalizes to an empty list,
     *  and an absent budget to the derived one over an unfed window (the floor). */
    public SubagentConfig {
        webTools = webTools == null ? List.of() : List.copyOf(webTools);
        budget = budget == null
                ? ChildBudget.derivedFrom(new dev.spectroscope.core.provider.ExchangeLatency())
                : budget;
    }

    /** The pre-card-364 arity, kept so a caller that does not carry the
     *  operator's ceilings still compiles — the children then run on
     *  {@code Agent}'s own defaults, which is what they did before.
     *  @param provider      the provider the children run on
     *  @param cwd           sandbox root, same as the parent's
     *  @param parentAgentId agentId of the parent agent
     *  @param onPermission  the same blocking broker the parent uses
     *  @param baseTools     the belt a child inherits, WITHOUT the spawn tools
     *  @param hooks         the parent's hooks (nullable → none)
     *  @param llmWire       the session's recorder (nullable → children record nothing)
     *  @param webTools      the parent's web tools (nullable → none)
     *  @param budget        what a child may spend (nullable → derived)
     *  @param compactionThreshold the parent's explicit threshold (nullable → derived) */
    public SubagentConfig(LlmProvider provider, Path cwd, String parentAgentId,
                          PermissionBroker onPermission, List<Tool> baseTools,
                          HookRunner hooks, LlmWireRecorder llmWire, List<Tool> webTools,
                          ChildBudget budget, Integer compactionThreshold) {
        this(provider, cwd, parentAgentId, onPermission, baseTools, hooks, llmWire,
                webTools, budget, compactionThreshold, null, null, null);
    }

    /** The pre-card-263 arity, kept so a caller that does not carry the
     *  operator's threshold still compiles — the children then derive it from
     *  the same provider the parent uses, which is what they did before.
     *  @param provider      the provider the children run on
     *  @param cwd           sandbox root, same as the parent's
     *  @param parentAgentId agentId of the parent agent
     *  @param onPermission  the same blocking broker the parent uses
     *  @param baseTools     the belt a child inherits, WITHOUT the spawn tools
     *  @param hooks         the parent's hooks (nullable → none)
     *  @param llmWire       the session's recorder (nullable → children record nothing)
     *  @param webTools      the parent's web tools (nullable → none)
     *  @param budget        what a child may spend (nullable → derived) */
    public SubagentConfig(LlmProvider provider, Path cwd, String parentAgentId,
                          PermissionBroker onPermission, List<Tool> baseTools,
                          HookRunner hooks, LlmWireRecorder llmWire, List<Tool> webTools,
                          ChildBudget budget) {
        this(provider, cwd, parentAgentId, onPermission, baseTools, hooks, llmWire,
                webTools, budget, null, null, null, null);
    }

    /**
     * The labeled way to build one. The telescoping compat constructors that
     * used to sit here are gone on purpose: their unlabeled {@code null} slots
     * are what let both faces drop the llm-wire recorder for a month while
     * every suite stayed green (card 231). An optional seam is now set by NAME
     * or not at all.
     *
     * @return a builder whose optional seams default exactly as the record's
     *         javadoc states: no hooks, no recorder, no web grant
     */
    public static Builder builder() {
        return new Builder();
    }

    /** The named-seam builder — same defaults the old arities implied, spelled out. */
    public static final class Builder {
        private LlmProvider provider;
        private Path cwd;
        private String parentAgentId;
        private PermissionBroker onPermission;
        private List<Tool> baseTools = List.of();
        private HookRunner hooks;               // nullable -> none
        private LlmWireRecorder llmWire;        // nullable -> children record nothing
        private List<Tool> webTools = List.of();
        private ChildBudget budget;             // nullable -> derived, floor governs
        private Integer compactionThreshold;    // nullable -> the child derives it too
        private Integer maxTurns;               // nullable -> Agent.DEFAULT_MAX_TURNS
        private Integer maxTokens;              // nullable -> Agent.DEFAULT_MAX_TOKENS
        private Boolean thinking;               // nullable -> the provider's default

        private Builder() {
        }

        /** @param value the provider the children run on — the parent's instance
         *  @return this builder */
        public Builder provider(LlmProvider value) { this.provider = value; return this; }

        /** @param value sandbox root, same as the parent's
         *  @return this builder */
        public Builder cwd(Path value) { this.cwd = value; return this; }

        /** @param value agentId of the parent agent (CLI: "main")
         *  @return this builder */
        public Builder parentAgentId(String value) { this.parentAgentId = value; return this; }

        /** @param value the same blocking broker the parent uses
         *  @return this builder */
        public Builder onPermission(PermissionBroker value) { this.onPermission = value; return this; }

        /** @param value standard tools WITHOUT the spawn tools
         *  @return this builder */
        public Builder baseTools(List<Tool> value) { this.baseTools = value; return this; }

        /** @param value the same pre/post_tool_use hooks the parent runs
         *  @return this builder */
        public Builder hooks(HookRunner value) { this.hooks = value; return this; }

        /** @param value the session's recorder — the SAME instance the parent writes on
         *  @return this builder */
        public Builder llmWire(LlmWireRecorder value) { this.llmWire = value; return this; }

        /** @param value the parent session's web tools, research children only (card 205)
         *  @return this builder */
        public Builder webTools(List<Tool> value) { this.webTools = value; return this; }

        /** @param value what a child may spend (card 270) — pass one derived from
         *               the parent agent's OWN latency window so the price comes
         *               from the backend this session is talking to
         *  @return this builder */
        public Builder budget(ChildBudget value) { this.budget = value; return this; }

        /** @param value the parent's explicit compaction threshold, so the
         *               operator's number governs the whole tree and not just
         *               its root (card 263); null lets the child derive
         *  @return this builder */
        public Builder compactionThreshold(Integer value) {
            this.compactionThreshold = value;
            return this;
        }

        /** @param value the parent's turn ceiling, so the operator's number ends
         *               a child's run where it ends the parent's (card 364);
         *               null leaves the child on {@code Agent.DEFAULT_MAX_TURNS}
         *  @return this builder */
        public Builder maxTurns(Integer value) {
            this.maxTurns = value;
            return this;
        }

        /** @param value the parent's completion budget per provider call (card
         *               364); null leaves the child on
         *               {@code Agent.DEFAULT_MAX_TOKENS}
         *  @return this builder */
        public Builder maxTokens(Integer value) {
            this.maxTokens = value;
            return this;
        }

        /** @param value whether the children surface reasoning, carried from the
         *               parent's own build-time value (card 364); null leaves
         *               the provider's default
         *  @return this builder */
        public Builder thinking(Boolean value) {
            this.thinking = value;
            return this;
        }

        /** @return the finished config, normalized by the canonical constructor */
        public SubagentConfig build() {
            return new SubagentConfig(provider, cwd, parentAgentId, onPermission,
                    baseTools, hooks, llmWire, webTools, budget, compactionThreshold,
                    maxTurns, maxTokens, thinking);
        }
    }
}
