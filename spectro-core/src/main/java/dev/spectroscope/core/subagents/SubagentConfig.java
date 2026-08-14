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
 */
public record SubagentConfig(
        LlmProvider provider,
        Path cwd,
        String parentAgentId,
        PermissionBroker onPermission,
        List<Tool> baseTools,
        HookRunner hooks,
        LlmWireRecorder llmWire,
        List<Tool> webTools) {

    /** Null-tolerant canonical: an absent web grant normalizes to an empty list. */
    public SubagentConfig {
        webTools = webTools == null ? List.of() : List.copyOf(webTools);
    }

    /**
     * Compat: the pre-webTools arity (callers without a web grant — their
     * research children run on the read tools alone).
     *
     * @param provider      the provider the children run on — the parent's instance
     * @param cwd           sandbox root, same as the parent's
     * @param parentAgentId agentId of the parent agent (CLI: "main")
     * @param onPermission  the same blocking broker the parent uses
     * @param baseTools     standard tools WITHOUT the spawn tools
     * @param hooks         the same pre/post_tool_use hooks the parent runs
     * @param llmWire       the session's backend-to-LLM recorder
     */
    public SubagentConfig(LlmProvider provider, Path cwd, String parentAgentId,
                          PermissionBroker onPermission, List<Tool> baseTools,
                          HookRunner hooks, LlmWireRecorder llmWire) {
        this(provider, cwd, parentAgentId, onPermission, baseTools, hooks, llmWire, List.of());
    }

    /**
     * Compat: the pre-wire arity (callers without an llm-wire recorder).
     *
     * @param provider      the provider the children run on — the parent's instance
     * @param cwd           sandbox root, same as the parent's
     * @param parentAgentId agentId of the parent agent (CLI: "main")
     * @param onPermission  the same blocking broker the parent uses
     * @param baseTools     standard tools WITHOUT the spawn tools
     * @param hooks         the same pre/post_tool_use hooks the parent runs
     */
    public SubagentConfig(LlmProvider provider, Path cwd, String parentAgentId,
                          PermissionBroker onPermission, List<Tool> baseTools,
                          HookRunner hooks) {
        this(provider, cwd, parentAgentId, onPermission, baseTools, hooks, null, List.of());
    }

    /**
     * Compat: no hooks (tests and callers without a hook config).
     *
     * @param provider      the provider the children run on — the parent's instance
     * @param cwd           sandbox root, same as the parent's
     * @param parentAgentId agentId of the parent agent (CLI: "main")
     * @param onPermission  the same blocking broker the parent uses
     * @param baseTools     standard tools WITHOUT the spawn tools
     */
    public SubagentConfig(LlmProvider provider, Path cwd, String parentAgentId,
                          PermissionBroker onPermission, List<Tool> baseTools) {
        this(provider, cwd, parentAgentId, onPermission, baseTools, null, null, List.of());
    }
}
