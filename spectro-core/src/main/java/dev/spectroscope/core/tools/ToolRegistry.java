package dev.spectroscope.core.tools;

import dev.spectroscope.core.provider.LlmProvider.ToolSpec;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/** Holds the tools of a run and advertises them to the provider. Insertion order is preserved. */
public final class ToolRegistry {

    private final Map<String, Tool> tools = new LinkedHashMap<>();

    /**
     * Adds a tool under its wire name — registering the same name again replaces
     * the earlier tool. The registry is the autologging injection point
     * : every tool goes in Logged-wrapped, so each execute()
     * logs entry/exit at DEBUG with no call-site changes anywhere — and stays
     * silent below DEBUG.
     *
     * @param tool the capability to expose to the model
     */
    public void register(Tool tool) {
        tools.put(tool.name(), dev.spectroscope.core.log.Logged.wrap(Tool.class, tool));
    }

    /**
     * Empty if the model asked for a tool that is not registered — the loop reports that as an error result.
     *
     * @param name the tool name exactly as the model requested it
     * @return the registered tool, or empty for unknown names
     */
    public Optional<Tool> get(String name) {
        return Optional.ofNullable(tools.get(name));
    }

    /**
     * The provider-neutral advertisement of every registered tool.
     *
     * @return one spec per tool, in registration order
     */
    public List<ToolSpec> specs() {
        return tools.values().stream()
                .map(tool -> new ToolSpec(tool.name(), tool.description(), tool.inputSchema()))
                .toList();
    }
}
