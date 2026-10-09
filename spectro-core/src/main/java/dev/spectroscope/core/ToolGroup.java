package dev.spectroscope.core;

import dev.spectroscope.core.provider.LlmProvider.ToolSpec;
import dev.spectroscope.core.subagents.RoleCatalog;

import java.util.Arrays;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.function.Predicate;

/**
 * Card 466: a family of tools the operator can switch off for one session, so
 * a chat about a folder stops resending the schemas of a browser it never
 * opens.
 *
 * <p>Membership is read from the tool's own wire name, never from a list of
 * names: a {@code browser_*} tool added tomorrow joins {@link #BROWSER} without
 * anyone remembering to add it here. The roles group reads the role catalog
 * for the same reason. A tool that no group holds (the standard file tools,
 * {@code run_command}, {@code update_plan}, {@code ask_user_question}, the
 * skill tools) can never be switched off.</p>
 *
 * <p>Switching a group off removes its tools from the provider request and
 * from the context ring. It never lifts a permission gate: a tool that is on
 * asks exactly as before.</p>
 */
public enum ToolGroup {
    /** The {@code browser_*} tools that drive the attached browser. */
    BROWSER("browser", name -> name.startsWith("browser_")),
    /** The {@code launch_*} tools that start and read launch configurations. */
    LAUNCH("launch", name -> name.startsWith("launch_")),
    /** The image tools, {@code generate_image} and {@code view_image}. */
    IMAGES("images", name -> name.endsWith("_image")),
    /** The web tools, {@code web_fetch}, {@code web_search} and {@code browse_page}. */
    WEB("web", name -> name.startsWith("web_") || "browse_page".equals(name)),
    /** The spawn verbs, {@code spawn_agent} and {@code spawn_agents}. */
    AGENTS("agents", name -> name.startsWith("spawn_")),
    /** The dev role tools, as the role catalog names them. */
    ROLES("roles", name -> RoleCatalog.devToolNames().contains(name)),
    /** Every MCP tool, {@code mcp__<server>__<tool>}. */
    MCP("mcp", name -> false);

    /** The prefix every MCP tool name carries. */
    private static final String MCP_PREFIX = "mcp__";

    private final String wireName;
    private final Predicate<String> member;

    ToolGroup(String wireName, Predicate<String> member) {
        this.wireName = wireName;
        this.member = member;
    }

    /**
     * The name the settings key, the socket frame and the composer gear use.
     *
     * @return the group's lowercase wire name
     */
    public String wireName() {
        return wireName;
    }

    /**
     * Whether a tool belongs to this group, read from its wire name.
     *
     * @param toolName the tool's wire name
     * @return true when switching this group off hides the tool
     */
    public boolean holds(String toolName) {
        if (toolName == null) {
            return false;
        }
        // An MCP tool belongs to MCP whatever its own name looks like: a
        // server's "generate_image" must not go off with the image group.
        if (toolName.startsWith(MCP_PREFIX)) {
            return this == MCP;
        }
        return member.test(toolName);
    }

    /**
     * The group a tool belongs to.
     *
     * @param toolName the tool's wire name
     * @return the group, or empty for a tool that can never be switched off
     */
    public static Optional<ToolGroup> of(String toolName) {
        return Arrays.stream(values()).filter(group -> group.holds(toolName)).findFirst();
    }

    /**
     * Looks a group up by its exact wire name.
     *
     * @param wireName the name as a settings file or a socket frame carries it
     * @return the group, or empty for a name no group carries
     */
    public static Optional<ToolGroup> named(String wireName) {
        return Arrays.stream(values()).filter(group -> group.wireName.equals(wireName)).findFirst();
    }

    /**
     * Every wire name, in the order the composer gear lists them.
     *
     * @return the seven names, immutable
     */
    public static List<String> wireNames() {
        return Arrays.stream(values()).map(ToolGroup::wireName).toList();
    }

    /**
     * Whether a tool is hidden by a set of switched-off groups.
     *
     * @param toolName the tool's wire name
     * @param off      the switched-off groups
     * @return true when the tool belongs to one of them
     */
    public static boolean switchedOff(String toolName, Set<ToolGroup> off) {
        return !off.isEmpty() && of(toolName).map(off::contains).orElse(false);
    }

    /**
     * The specs a request may carry: every spec whose tool is not in a
     * switched-off group, in the order given.
     *
     * @param specs the registry's specs
     * @param off   the switched-off groups; empty keeps every spec
     * @return the remaining specs; the same list when nothing is off
     */
    public static List<ToolSpec> visible(List<ToolSpec> specs, Set<ToolGroup> off) {
        if (off.isEmpty()) {
            return specs;
        }
        return specs.stream().filter(spec -> !switchedOff(spec.name(), off)).toList();
    }
}
