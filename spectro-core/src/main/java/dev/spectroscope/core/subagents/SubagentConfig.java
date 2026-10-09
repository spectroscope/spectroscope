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
 *                      which means {@code subagentBudgetSeconds} below governs
 *                      (card 372).
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
 * @param subagentBudgetSeconds the operator's floor for every child's run budget,
 *                      in seconds (card 372). Nullable: the shipped default. It is
 *                      applied to {@code budget} in the canonical constructor, so a
 *                      face passes its window and its number and never composes
 *                      the two by hand
 * @param sessionWindow the context window the operator set for the parent's
 *                      session (card 390), the SAME holder the parent reads, so
 *                      a child compacts against the window the operator stated
 *                      and sees a change from its next turn (nullable: the
 *                      children derive their window as before)
 * @param subagentBudgetTokens the spend, input plus output as its usage events
 *                      report them, past which {@code SubagentManager} cuts ONE
 *                      child at its next turn (card 394). Nullable: the
 *                      shipped default. Zero or less is refused here, by name
 * @param toolResultElision the session's {@code toolResultElision} (card 467),
 *                      handed to every child so the tree follows the rule its
 *                      root follows. Nullable: the shipped value, on
 * @param toolGroupsOff the parent session's switched-off tool groups (card
 *                      466), the SAME reader the parent agent is built with.
 *                      While a parent run is in flight a child takes the set
 *                      that run read at its start, not this reader, so a gear
 *                      change mid-run reaches parent and children together at
 *                      the next run. Applied after the role policy and after
 *                      the role's grant, so it can only take tools away
 *                      (nullable: nothing is switched off)
 * @param sessionsPerChat the chat's session count (card 490), the main agent
 *                      and its helpers together. The manager's slot pool
 *                      admits at most this count minus one helper at a time;
 *                      while a parent run is in flight the pool reads the
 *                      parent agent's live count instead, so this value
 *                      governs between runs and for a parent built without
 *                      one. Nullable: no count, as in v0.14.4. A value below
 *                      its floor of 2 is refused here, by name
 * @param careParagraph the session's {@code careParagraph} (card 492). While a
 *                      parent run is in flight a child takes the setting that
 *                      run read at its start, not this value. A child offers
 *                      no spawn tool, so its paragraph never carries the
 *                      sentence about subagents (nullable: the shipped off)
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
        Boolean thinking,
        Integer subagentBudgetSeconds,
        dev.spectroscope.core.session.SessionWindow sessionWindow,
        Integer subagentBudgetTokens,
        String toolResultElision,
        java.util.function.Supplier<java.util.Set<dev.spectroscope.core.ToolGroup>> toolGroupsOff,
        Integer sessionsPerChat,
        String careParagraph) {

    /** Null-tolerant canonical: an absent web grant normalizes to an empty list,
     *  and an absent budget to the derived one over an unfed window. The
     *  operator's floor is applied here, to the budget either way, so a face
     *  hands over its latency window and its number separately and the two are
     *  composed in one place (card 372). An explicit {@link ChildBudget#fixed}
     *  override keeps winning: {@link ChildBudget#withFloorMs} returns itself. */
    public SubagentConfig {
        webTools = webTools == null ? List.of() : List.copyOf(webTools);
        long floorMs = (subagentBudgetSeconds == null
                ? dev.spectroscope.core.config.SpectroConfig.DEFAULT_SUBAGENT_BUDGET_SECONDS
                : subagentBudgetSeconds) * 1000L;
        budget = budget == null
                ? ChildBudget.derivedFrom(new dev.spectroscope.core.provider.ExchangeLatency(), floorMs)
                : budget.withFloorMs(floorMs);
        // Card 394. The settings path cannot bring a zero here: SettingFloors
        // refuses it on save and skips it on load. What can is code that builds
        // this record with its own number, and that code gets the key's name.
        if (subagentBudgetTokens == null) {
            subagentBudgetTokens =
                    dev.spectroscope.core.config.SpectroConfig.DEFAULT_SUBAGENT_BUDGET_TOKENS;
        } else if (subagentBudgetTokens <= 0) {
            throw new IllegalArgumentException(
                    "subagentBudgetTokens must be positive, got " + subagentBudgetTokens);
        }
        // Card 490: the same refusal, by name, for a count below its floor.
        SessionCount.of(sessionsPerChat);
    }

    /** Compat: the arity of v0.14.4, which knew no session count (card 490).
     *  Its children run with no limit per chat, as before.
     *
     * @param provider      the provider the children run on
     * @param cwd           sandbox root, same as the parent's
     * @param parentAgentId agentId of the parent agent
     * @param onPermission  the same blocking broker the parent uses
     * @param baseTools     the belt a child inherits, WITHOUT the spawn tools
     * @param hooks         the parent's hooks (nullable → none)
     * @param llmWire       the session's recorder (nullable → children record nothing)
     * @param webTools      the parent's web tools (nullable → none)
     * @param budget        what a child may spend in time (nullable → derived)
     * @param compactionThreshold the parent's explicit threshold (nullable → derived)
     * @param maxTurns      the parent's turn ceiling (nullable → the default)
     * @param maxTokens     the parent's completion budget (nullable → the default)
     * @param thinking      whether reasoning is surfaced (nullable → the provider's default)
     * @param subagentBudgetSeconds the operator's floor (nullable → the shipped one)
     * @param sessionWindow the parent session's window holder (nullable → children derive)
     * @param subagentBudgetTokens a child's token budget (nullable → the shipped one)
     * @param toolResultElision the session's elision switch (nullable → on)
     * @param toolGroupsOff the parent session's switched-off groups (nullable → none) */
    public SubagentConfig(LlmProvider provider, Path cwd, String parentAgentId,
                          PermissionBroker onPermission, List<Tool> baseTools,
                          HookRunner hooks, LlmWireRecorder llmWire, List<Tool> webTools,
                          ChildBudget budget, Integer compactionThreshold, Integer maxTurns,
                          Integer maxTokens, Boolean thinking, Integer subagentBudgetSeconds,
                          dev.spectroscope.core.session.SessionWindow sessionWindow,
                          Integer subagentBudgetTokens, String toolResultElision,
                          java.util.function.Supplier<java.util.Set<dev.spectroscope.core.ToolGroup>>
                                  toolGroupsOff) {
        this(provider, cwd, parentAgentId, onPermission, baseTools, hooks, llmWire,
                webTools, budget, compactionThreshold, maxTurns, maxTokens, thinking,
                subagentBudgetSeconds, sessionWindow, subagentBudgetTokens, toolResultElision,
                toolGroupsOff, null, null);
    }

    /** Compat: the arity before cards 467 and 466, which knew no elision
     *  switch and no tool groups. The children get the shipped elision, on,
     *  and are advertised the whole belt, as before.
     *
     * @param provider              the provider the children stream from
     * @param cwd                   the children's working directory
     * @param parentAgentId         the spawning agent's id
     * @param onPermission          the parent's permission broker
     * @param baseTools             the tools a child may be handed
     * @param hooks                 the parent's hooks
     * @param llmWire               the session's wire record
     * @param webTools              the gated web grant
     * @param budget                a child's run budget
     * @param compactionThreshold   the operator's threshold, or null
     * @param maxTurns              the operator's turn ceiling, or null
     * @param maxTokens             the operator's completion budget, or null
     * @param thinking              whether reasoning is surfaced, or null
     * @param subagentBudgetSeconds the run budget floor, or null
     * @param sessionWindow         the session's window holder, or null
     * @param subagentBudgetTokens  a child's token budget, or null */
    public SubagentConfig(LlmProvider provider, Path cwd, String parentAgentId,
                          PermissionBroker onPermission, List<Tool> baseTools,
                          HookRunner hooks, LlmWireRecorder llmWire, List<Tool> webTools,
                          ChildBudget budget, Integer compactionThreshold, Integer maxTurns,
                          Integer maxTokens, Boolean thinking, Integer subagentBudgetSeconds,
                          dev.spectroscope.core.session.SessionWindow sessionWindow,
                          Integer subagentBudgetTokens) {
        this(provider, cwd, parentAgentId, onPermission, baseTools, hooks, llmWire,
                webTools, budget, compactionThreshold, maxTurns, maxTokens, thinking,
                subagentBudgetSeconds, sessionWindow, subagentBudgetTokens, null, null, null,
                null);
    }

    /** The pre-card-394 arity, kept so a caller that does not carry a token
     *  budget still compiles; its children run on the shipped one.
     *  @param provider      the provider the children run on
     *  @param cwd           sandbox root, same as the parent's
     *  @param parentAgentId agentId of the parent agent
     *  @param onPermission  the same blocking broker the parent uses
     *  @param baseTools     the belt a child inherits, WITHOUT the spawn tools
     *  @param hooks         the parent's hooks (nullable → none)
     *  @param llmWire       the session's recorder (nullable → children record nothing)
     *  @param webTools      the parent's web tools (nullable → none)
     *  @param budget        what a child may spend in time (nullable → derived)
     *  @param compactionThreshold the parent's explicit threshold (nullable → derived)
     *  @param maxTurns      the parent's turn ceiling (nullable → the default)
     *  @param maxTokens     the parent's completion budget (nullable → the default)
     *  @param thinking      whether reasoning is surfaced (nullable → the provider's default)
     *  @param subagentBudgetSeconds the operator's floor (nullable → the shipped one)
     *  @param sessionWindow the parent session's window holder (nullable → children derive) */
    public SubagentConfig(LlmProvider provider, Path cwd, String parentAgentId,
                          PermissionBroker onPermission, List<Tool> baseTools,
                          HookRunner hooks, LlmWireRecorder llmWire, List<Tool> webTools,
                          ChildBudget budget, Integer compactionThreshold, Integer maxTurns,
                          Integer maxTokens, Boolean thinking, Integer subagentBudgetSeconds,
                          dev.spectroscope.core.session.SessionWindow sessionWindow) {
        this(provider, cwd, parentAgentId, onPermission, baseTools, hooks, llmWire,
                webTools, budget, compactionThreshold, maxTurns, maxTokens, thinking,
                subagentBudgetSeconds, sessionWindow, null);
    }

    /** The pre-card-390 arity, kept so a caller that does not carry a session
     *  window still compiles; its children derive their window as before.
     *  @param provider      the provider the children run on
     *  @param cwd           sandbox root, same as the parent's
     *  @param parentAgentId agentId of the parent agent
     *  @param onPermission  the same blocking broker the parent uses
     *  @param baseTools     the belt a child inherits, WITHOUT the spawn tools
     *  @param hooks         the parent's hooks (nullable → none)
     *  @param llmWire       the session's recorder (nullable → children record nothing)
     *  @param webTools      the parent's web tools (nullable → none)
     *  @param budget        what a child may spend (nullable → derived)
     *  @param compactionThreshold the parent's explicit threshold (nullable → derived)
     *  @param maxTurns      the parent's turn ceiling (nullable → the default)
     *  @param maxTokens     the parent's completion budget (nullable → the default)
     *  @param thinking      whether reasoning is surfaced (nullable → the provider's default)
     *  @param subagentBudgetSeconds the operator's floor (nullable → the shipped one) */
    public SubagentConfig(LlmProvider provider, Path cwd, String parentAgentId,
                          PermissionBroker onPermission, List<Tool> baseTools,
                          HookRunner hooks, LlmWireRecorder llmWire, List<Tool> webTools,
                          ChildBudget budget, Integer compactionThreshold, Integer maxTurns,
                          Integer maxTokens, Boolean thinking, Integer subagentBudgetSeconds) {
        this(provider, cwd, parentAgentId, onPermission, baseTools, hooks, llmWire,
                webTools, budget, compactionThreshold, maxTurns, maxTokens, thinking,
                subagentBudgetSeconds, null);
    }

    /** The 0.12.0 arity, before card 372 added the floor setting and card 390
     *  the session window (card 412). It passes neither, so it builds the record
     *  the 14 argument form builds with a null {@code subagentBudgetSeconds}:
     *  the children run on the shipped floor and derive their window.
     *  @param provider      the provider the children run on
     *  @param cwd           sandbox root, same as the parent's
     *  @param parentAgentId agentId of the parent agent
     *  @param onPermission  the same blocking broker the parent uses
     *  @param baseTools     the belt a child inherits, WITHOUT the spawn tools
     *  @param hooks         the parent's hooks (nullable → none)
     *  @param llmWire       the session's recorder (nullable → children record nothing)
     *  @param webTools      the parent's web tools (nullable → none)
     *  @param budget        what a child may spend (nullable → derived)
     *  @param compactionThreshold the parent's explicit threshold (nullable → derived)
     *  @param maxTurns      the parent's turn ceiling (nullable → the default)
     *  @param maxTokens     the parent's completion budget (nullable → the default)
     *  @param thinking      whether reasoning is surfaced (nullable → the provider's default) */
    public SubagentConfig(LlmProvider provider, Path cwd, String parentAgentId,
                          PermissionBroker onPermission, List<Tool> baseTools,
                          HookRunner hooks, LlmWireRecorder llmWire, List<Tool> webTools,
                          ChildBudget budget, Integer compactionThreshold, Integer maxTurns,
                          Integer maxTokens, Boolean thinking) {
        this(provider, cwd, parentAgentId, onPermission, baseTools, hooks, llmWire,
                webTools, budget, compactionThreshold, maxTurns, maxTokens, thinking, null);
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
                webTools, budget, compactionThreshold, null, null, null, null);
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
                webTools, budget, null, null, null, null, null);
    }

    /**
     * The labeled way to build one, and the one to use in new code: here a
     * seam is set by NAME, never by its position. Card 231 deleted the
     * telescoping compat constructors of its day, because their unlabeled
     * {@code null} slots let both faces drop the llm-wire recorder for a month
     * while every suite stayed green. The positional compat constructors above
     * were added after that card, each so that code written against an earlier
     * component list still compiles, and each names that list in its own
     * javadoc. One of them is the canonical form of 0.12.0, restored by card
     * 412.
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
        private Integer subagentBudgetSeconds;   // nullable -> the shipped floor
        private dev.spectroscope.core.session.SessionWindow sessionWindow; // nullable -> children derive
        private Integer subagentBudgetTokens;    // nullable -> the shipped budget
        private String toolResultElision;        // nullable -> the shipped "on"
        private java.util.function.Supplier<java.util.Set<dev.spectroscope.core.ToolGroup>> toolGroupsOff; // nullable -> none off
        private Integer sessionsPerChat;         // nullable -> no count per chat
        private String careParagraph;            // nullable -> the shipped "off"

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

        /** @param value the operator's {@code subagentBudgetSeconds}, the floor of
         *               every child's run budget (card 372); null means the shipped
         *               default
         *  @return this builder */
        public Builder subagentBudgetSeconds(Integer value) {
            this.subagentBudgetSeconds = value;
            return this;
        }

        /** The window the operator set for the parent's session (card 390).
         *  @param value the parent session's window holder, the SAME instance
         *               the parent reads; null lets the children derive
         *  @return this builder */
        public Builder sessionWindow(dev.spectroscope.core.session.SessionWindow value) {
            this.sessionWindow = value;
            return this;
        }

        /** @param value the operator's {@code subagentBudgetTokens}, the most
         *               tokens one child may spend (card 394); null means the
         *               shipped default
         *  @return this builder */
        public Builder subagentBudgetTokens(Integer value) {
            this.subagentBudgetTokens = value;
            return this;
        }

        /** Card 466: the parent session's switched-off tool groups.
         *  @param value the SAME reader the parent agent is built with; null
         *               switches nothing off
         *  @return this builder */
        public Builder toolGroupsOff(
                java.util.function.Supplier<java.util.Set<dev.spectroscope.core.ToolGroup>> value) {
            this.toolGroupsOff = value;
            return this;
        }

        /**
         * Card 467: the session's elision switch, for every child.
         *
         * @param value {@code "on"}, {@code "off"}, or null for the shipped on
         * @return this builder
         */
        public Builder toolResultElision(String value) {
            this.toolResultElision = value;
            return this;
        }

        /** Card 490: the chat's session count, the main agent and its helpers.
         *  @param value the count; null sets none, as v0.14.4 did
         *  @return this builder */
        public Builder sessionsPerChat(Integer value) {
            this.sessionsPerChat = value;
            return this;
        }

        /**
         * Card 492: the session's care paragraph switch, for every child.
         *
         * @param value {@code "on"}, {@code "off"}, or null for the shipped off
         * @return this builder
         */
        public Builder careParagraph(String value) {
            this.careParagraph = value;
            return this;
        }

        /** @return the finished config, normalized by the canonical constructor */
        public SubagentConfig build() {
            return new SubagentConfig(provider, cwd, parentAgentId, onPermission,
                    baseTools, hooks, llmWire, webTools, budget, compactionThreshold,
                    maxTurns, maxTokens, thinking, subagentBudgetSeconds, sessionWindow,
                    subagentBudgetTokens, toolResultElision, toolGroupsOff, sessionsPerChat, careParagraph);
        }
    }
}
