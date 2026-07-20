package dev.spectroscope.server;

import dev.spectroscope.core.subagents.RoleCatalog;

import java.util.List;

/**
 * What goes to the LLM BEFORE any user message — the main agent's assembled
 * context, plus the subagent role profiles. Served read-only by GET /api/context
 * so the web UI can show "was VOR deiner Nachricht ans LLM geht". Assembled the
 * same way {@link SessionConnection} builds the live agent, but without creating
 * an Agent or connecting MCP (the server names are listed; their tools load on
 * connect).
 *
 * @param systemPrompt the fully assembled system prompt — base prompt + cwd + SPECTRO.md + skill catalog
 * @param tools every tool the main agent would see, in registration order
 * @param skills the installed skill catalog (names + one-liners; bodies stay on demand)
 * @param mcpServers the configured MCP server names — their tools are unknown until connect
 * @param thinking whether reasoning visibility is on at boot
 * @param provider the boot LLM backend; the client overlays any live switch
 * @param model the boot model name, same overlay rule as the provider
 * @param subagentProfiles per role: the prompt and tool profile a spawned child would get
 */
public record ContextInfo(
        String systemPrompt,
        List<ToolInfo> tools,
        List<SkillInfo> skills,
        List<String> mcpServers,
        boolean thinking,
        String provider,
        String model,
        List<RoleCatalog.RoleProfile> subagentProfiles) {

    /**
     * One tool exactly as the LLM would see it in the request.
     *
     * @param name the wire name the model calls
     * @param description the description sent to the LLM — its only usage hint
     * @param needsPermission whether a call must pass the permission gate first
     */
    public record ToolInfo(String name, String description, boolean needsPermission) {}

    /**
     * One installed skill from the catalog section of the system prompt.
     *
     * @param name the skill's frontmatter name — what {@code use_skill} takes
     * @param description the one-liner advertising when the skill should be loaded
     */
    public record SkillInfo(String name, String description) {}
}
