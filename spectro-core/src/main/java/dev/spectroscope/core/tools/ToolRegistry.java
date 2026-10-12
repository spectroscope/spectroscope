package dev.spectroscope.core.tools;

import dev.spectroscope.core.provider.LlmProvider.ToolSpec;

import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.stream.Collectors;

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

    /**
     * Card 493: the advertisement for one run, each tool described with what
     * the run read when it started ({@link Tool#descriptionForRun}).
     *
     * @param run what the run read when it started
     * @return one spec per tool, in registration order
     */
    public List<ToolSpec> specs(Tool.RunFacts run) {
        return tools.values().stream()
                .map(tool -> new ToolSpec(tool.name(), tool.descriptionForRun(run), tool.inputSchema()))
                .toList();
    }

    /**
     * Card 547: the names of the tools that are not offered in a folder
     * ({@link Tool#offeredIn}). Each tool is asked once per call.
     *
     * @param cwd the run's folder, may be null
     * @return the names to leave out of a request, empty when every tool is offered
     */
    public Set<String> notOfferedIn(Path cwd) {
        return notOfferedIn(cwd, tools.values());
    }

    /**
     * Card 547: the system prompt lines of the offered tools, in registration
     * order, each after a blank line.
     *
     * @param notOffered the names {@link #notOfferedIn} returned for the run
     * @return the text to append to the system prompt, empty when no offered tool has a line
     */
    public String promptLines(Set<String> notOffered) {
        StringBuilder out = new StringBuilder();
        for (Tool tool : tools.values()) {
            String line = tool.systemPromptLine();
            if (line != null && !line.isBlank() && !notOffered.contains(tool.name())) {
                out.append("\n\n").append(line);
            }
        }
        return out.toString();
    }

    private static Set<String> notOfferedIn(Path cwd, java.util.Collection<Tool> tools) {
        return tools.stream()
                .filter(tool -> !tool.offeredIn(cwd))
                .map(Tool::name)
                .collect(Collectors.toUnmodifiableSet());
    }
}
