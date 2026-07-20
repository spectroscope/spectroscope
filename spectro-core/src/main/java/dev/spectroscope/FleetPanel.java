package dev.spectroscope;

import dev.spectroscope.core.EventStream;

/**
 * The fleet behind {@link Spectro#panel()}: several agents, one merged event
 * stream. The surface follows the frozen five-lines style — fluent setters,
 * then a plain blocking for-loop over {@link EventStream}.
 *
 * <pre>{@code
 * var panel = Spectro.panel().model(Anthropic.opus());
 * panel.agent("bugs").task("Find bugs in the diff");
 * panel.agent("perf").task("Check the hot queries");
 *
 * for (RunEvent event : panel.run()) {
 *     System.out.println(event);   // every lane, one spectrum
 * }
 * }</pre>
 *
 * <p>The implementation lives in the {@code spectro-orchestrator} module and
 * is discovered through {@link FleetPanelFactory}; spectro-core stays free of
 * any dependency on the fleet.</p>
 */
public interface FleetPanel {

    /**
     * Panel-wide default backend — every lane without its own model uses it.
     *
     * @param provider the LLM backend, e.g. {@code Anthropic.opus()}
     * @return this panel, for chaining
     */
    FleetPanel model(dev.spectroscope.core.provider.LlmProvider provider);

    /**
     * Panel-wide workspace root; each lane works in {@code root/<agentId>}
     * unless it pins its own workspace.
     *
     * @param root the fleet's working directory root
     * @return this panel, for chaining
     */
    FleetPanel workspace(java.nio.file.Path root);

    /**
     * Adds (or returns) the lane with this id — one agent of the fleet.
     *
     * @param agentId the lane's agent id, e.g. "bugs"; also its event identity
     * @return the lane, for fluent per-agent configuration
     */
    FleetLane agent(String agentId);

    /**
     * Starts every lane on its own virtual thread and hands back ONE merged
     * stream: panel lifecycle, task/status/result messages and every lane's
     * events, ending with the panel's own {@code run_end}.
     *
     * @return the merged fleet stream; iterate it with a for-loop
     */
    EventStream run();
}
