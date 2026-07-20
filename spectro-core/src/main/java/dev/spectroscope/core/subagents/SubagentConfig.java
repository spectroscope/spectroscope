package dev.spectroscope.core.subagents;

import dev.spectroscope.core.PermissionBroker;
import dev.spectroscope.core.hooks.HookRunner;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.tools.Tool;

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
 */
public record SubagentConfig(
        LlmProvider provider,
        Path cwd,
        String parentAgentId,
        PermissionBroker onPermission,
        List<Tool> baseTools,
        HookRunner hooks) {

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
        this(provider, cwd, parentAgentId, onPermission, baseTools, null);
    }
}
