package dev.spectroscope.server.session;

import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.config.WorkspaceResolver;
import dev.spectroscope.core.image.GenerateImageTool;
import dev.spectroscope.core.skills.SkillLibrary;
import dev.spectroscope.core.subagents.RoleCatalog;
import dev.spectroscope.core.tools.StandardTools;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.tools.UpdatePlanTool;
import dev.spectroscope.core.tools.WebFetchTool;
import dev.spectroscope.core.web.BrowsePageTool;
import dev.spectroscope.core.web.WebSearchTool;

import java.nio.file.Path;
import java.util.List;
import java.util.stream.Stream;

/**
 * Builds the stateless {@code GET /api/context} answer: the main agent's
 * context EXACTLY as the live session assembles it (base prompt + cwd +
 * SPECTRO.md + skill catalog, the full tool list, MCP server names) plus the
 * subagent role profiles. Extracted from SessionConnection (clean-code night
 * job) — no Agent is built and MCP is NOT connected (its tools load on
 * connect); provider/model/thinking are the boot defaults, which the client
 * overlays with any live switch.
 */
final class ContextDescriber {

    /** Static assembly only — never instantiated. */
    private ContextDescriber() {
    }

    /**
     * Assembles the full context answer, stateless and fresh per request — the
     * skill roots are re-scanned every call, so the answer tracks the disk.
     *
     * @param config the boot config supplying MCP server names, thinking, provider and model
     * @param cwd the working directory the prompt quotes and the skill roots resolve against
     * @return the complete introspection payload the "System-Kontext" tab renders
     */
    static ContextInfo describe(SpectroConfig config, Path cwd) {
        SkillLibrary skills = SkillLibrary.load(SkillLibrary.defaultRoots(cwd));
        // The endpoint is stateless (no session), so the prompt names the
        // configured workspace or the per-session pattern — the live prompt
        // substitutes the real folder (see SessionConnection.buildAgentOnce).
        // A configured workspace resolves to a real folder we can read AGENTS.md
        // from; a per-session temp folder does not exist yet (stateless endpoint),
        // so it has no AGENTS.md to append (loadAgentsMd tolerates the null).
        Path configuredWorkspace = config.workspace() != null
                ? WorkspaceResolver.locate(config.workspace(), null)
                : null;
        String workspaceShown = configuredWorkspace != null
                ? configuredWorkspace.toString()
                : Path.of(System.getProperty("java.io.tmpdir"), "spectroscope-ws") + "/<session-id>";
        String systemPrompt = SessionConnection.BASE_SYSTEM_PROMPT + workspaceShown
                + SpectroConfig.loadProjectMd(cwd) + SpectroConfig.loadAgentsMd(configuredWorkspace)
                + skills.systemPromptSection();

        List<Tool> standardTools = StandardTools.all();
        List<String> mcpServerNames = config.mcpServers().stream()
                .map(server -> server.name())
                .toList();
        List<ContextInfo.SkillInfo> skillCatalog = skills.skills().stream()
                .map(skill -> new ContextInfo.SkillInfo(skill.name(), skill.description()))
                .toList();

        return new ContextInfo(systemPrompt, mainAgentTools(config, standardTools, skills), skillCatalog,
                mcpServerNames, config.thinking(), config.provider(), config.model(),
                RoleCatalog.roleProfiles(childBaseToolNames(standardTools, skills)));
    }

    /**
     * Every SESSION-INDEPENDENT tool the main agent sees, in registration order:
     * the standard set, the extras (image / web_fetch / update_plan), use_skill
     * when skills are installed, then the parent-only spawn + dev tools. The
     * extras need runtime seams in the live path; for introspection a throwaway
     * instance is enough — reading name/description/needsPermission from the REAL
     * tool objects keeps this list from drifting (the old hand-written strings
     * had already diverged, and update_plan was missing entirely).
     *
     * <p><b>It is deliberately not the whole registry, and the qualifier above is
     * the correction.</b> This method can be called without a session, so it can
     * only describe what a session does not own. The session-scoped families are
     * registered in {@code SessionConnection} against that connection's own
     * browser and launch supervisor — seven {@code browser_*} tools from card 201
     * and five {@code launch_*} tools from card 202, twelve as of 2026-08-13 —
     * and none of them can be built here. Making this list complete means handing
     * the describer a live session, which is a change to its contract and its
     * callers, so it is filed rather than smuggled in: what got fixed here is the
     * sentence that claimed completeness it never had.
     *
     * @param config the SAME resolved configuration the caller described — see
     *               the web_search line below
     * @param standardTools the shared standard set, loaded once by the caller
     * @param skills the installed skill library — decides whether use_skill appears
     * @return name/description/needsPermission triples in exact registration order
     */
    private static List<ContextInfo.ToolInfo> mainAgentTools(SpectroConfig config,
            List<Tool> standardTools, SkillLibrary skills) {
        Stream<Tool> extras = Stream.of(
                new GenerateImageTool(() -> null, null),
                new WebFetchTool(url -> null),
                // Built from the configuration THIS CALL was handed, not from a
                // second load of the hierarchy: the introspection must name the
                // ACTIVE search tier of the config it is describing, exactly like
                // the live registry does, and both ask WebSearchTiers (card 203).
                // This line used to call SpectroConfig.load() again and so
                // described whatever the process-wide load resolved — harmless
                // only while every caller happened to pass an identical config,
                // and a second copy of one decision is what this card removed.
                WebSearchTool.fromConfig(config),
                new BrowsePageTool(),
                new UpdatePlanTool());
        Stream<Tool> useSkill = skills.skills().isEmpty()
                ? Stream.empty()
                : Stream.of(skills.useSkillTool());
        Stream<ContextInfo.ToolInfo> registered = Stream.of(standardTools.stream(), extras, useSkill)
                .flatMap(tools -> tools)
                .map(ContextDescriber::asToolInfo);
        Stream<ContextInfo.ToolInfo> parentOnly = RoleCatalog.parentTools().stream()
                .map(summary -> new ContextInfo.ToolInfo(summary.name(), summary.description(), false));
        return Stream.concat(registered, parentOnly).toList();
    }

    /**
     * The base tools a child inherits: the standard set plus use_skill.
     *
     * @param standardTools the shared standard set
     * @param skills the installed skill library — empty drops use_skill from the profile
     */
    private static List<String> childBaseToolNames(List<Tool> standardTools, SkillLibrary skills) {
        Stream<String> standard = standardTools.stream().map(Tool::name);
        Stream<String> useSkill = skills.skills().isEmpty()
                ? Stream.empty()
                : Stream.of(skills.useSkillTool().name());
        return Stream.concat(standard, useSkill).toList();
    }

    /**
     * Projects one live tool onto its introspection triple.
     *
     * @param tool the real tool object — name, description and gate flag are read from it
     */
    private static ContextInfo.ToolInfo asToolInfo(Tool tool) {
        return new ContextInfo.ToolInfo(tool.name(), tool.description(), tool.needsPermission());
    }
}
