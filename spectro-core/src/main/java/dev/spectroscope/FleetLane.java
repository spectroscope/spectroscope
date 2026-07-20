package dev.spectroscope;

import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.tools.Tool;

import java.nio.file.Path;

/**
 * One agent of a {@link FleetPanel} — the same setters as the single-agent
 * facade, plus the task the lane runs on. Every setter chains; {@code task}
 * is what {@link FleetPanel#run()} hands the lane's agent.
 */
public interface FleetLane {

    /** The lane's own backend; without it the panel default serves.
     *  @param provider the LLM backend for this lane
     *  @return this lane, for chaining */
    FleetLane model(LlmProvider provider);

    /** The lane's tool belt; without it the standard belt rides.
     *  @param tools the tools this lane may call
     *  @return this lane, for chaining */
    FleetLane tools(Tool... tools);

    /** The lane's own working directory (overrides the panel root).
     *  @param workspace the directory this lane's file tools sandbox against
     *  @return this lane, for chaining */
    FleetLane workspace(Path workspace);

    /** Replaces the lane's unattended system prompt entirely.
     *  @param systemPrompt the full system prompt for this lane
     *  @return this lane, for chaining */
    FleetLane systemPrompt(String systemPrompt);

    /** The assignment this lane runs when the panel starts.
     *  @param task the lane's task text — also the A2A task message
     *  @return this lane, for chaining */
    FleetLane task(String task);
}
