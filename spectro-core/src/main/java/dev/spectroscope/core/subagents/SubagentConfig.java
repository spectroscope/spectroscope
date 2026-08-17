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
 * @param baseTools     standard tools WITHOUT the spawn tools — children must
 *                      never be able to spawn (nesting depth 1 by construction)
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
 * @param budget        what a child may spend (card 270). Default: derived from
 *                      a fresh, unfed {@link dev.spectroscope.core.provider.ExchangeLatency},
 *                      which means the {@link ChildBudget#FLOOR_MS} floor governs.
 *                      A face that shares its parent agent's latency window pays
 *                      the measured price instead of the floor
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
        ChildBudget budget) {

    /** Null-tolerant canonical: an absent web grant normalizes to an empty list,
     *  and an absent budget to the derived one over an unfed window (the floor). */
    public SubagentConfig {
        webTools = webTools == null ? List.of() : List.copyOf(webTools);
        budget = budget == null
                ? ChildBudget.derivedFrom(new dev.spectroscope.core.provider.ExchangeLatency())
                : budget;
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

        /** @return the finished config, normalized by the canonical constructor */
        public SubagentConfig build() {
            return new SubagentConfig(provider, cwd, parentAgentId, onPermission,
                    baseTools, hooks, llmWire, webTools, budget);
        }
    }
}
