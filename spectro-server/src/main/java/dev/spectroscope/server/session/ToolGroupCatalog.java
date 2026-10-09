package dev.spectroscope.server.session;

import dev.spectroscope.core.ToolGroup;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.subagents.RoleCatalog;
import dev.spectroscope.core.tools.StandardTools;
import dev.spectroscope.core.tools.Tool;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Card 466: what each tool group holds, for the composer gear's hint line.
 *
 * <p>Each name is listed under the group {@link ToolGroup#of} returns, the
 * same call {@link ToolGroup#switchedOff} makes, so a tool appears under a
 * group exactly when switching that group off hides it. A session that has built
 * its belt passes the belt's names; before the first prompt there is no belt
 * yet, and the names come from the same describe-time assembly
 * {@code GET /api/context} uses. MCP servers have not been dialled at that
 * moment, so each enabled server stands in as {@code mcp__<server>__*}.</p>
 */
final class ToolGroupCatalog {

    /** Static helpers only. */
    private ToolGroupCatalog() {
    }

    /**
     * One entry per group, in {@link ToolGroup} order.
     *
     * @param toolNames the names to sort into the groups, in belt order
     * @return {@code {name, tools}} maps, ready for the socket frame
     */
    static List<Map<String, Object>> groups(List<String> toolNames) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (ToolGroup group : ToolGroup.values()) {
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("name", group.wireName());
            entry.put("tools", toolNames.stream()
                    .filter(name -> ToolGroup.of(name).orElse(null) == group).toList());
            out.add(entry);
        }
        return out;
    }

    /**
     * The names a session of this config will carry, before it has built its
     * belt: the standard tools, the settings belt, the spawn and role tools,
     * and one stand-in per configured MCP server.
     *
     * @param config the session's resolved configuration
     * @return the tool names in registration order
     */
    static List<String> describeTimeNames(SpectroConfig config) {
        List<String> names = new ArrayList<>();
        StandardTools.all(config.commandTimeoutSeconds()).stream().map(Tool::name).forEach(names::add);
        SettingsToolBelt.assemble(SettingsToolBelt.describeSeams(config)).tools().stream()
                .map(Tool::name).forEach(names::add);
        config.mcpServers().stream().filter(server -> server.enabledOrDefault())
                .forEach(server -> names.add("mcp__" + server.name() + "__*"));
        RoleCatalog.parentTools().forEach(summary -> names.add(summary.name()));
        return names;
    }

    /**
     * The wire names of a set of groups, in {@link ToolGroup} order.
     *
     * @param off the switched-off groups
     * @return their names, sorted the way the gear lists them
     */
    static List<String> wireNames(Set<ToolGroup> off) {
        return java.util.Arrays.stream(ToolGroup.values()).filter(off::contains)
                .map(ToolGroup::wireName).toList();
    }
}
