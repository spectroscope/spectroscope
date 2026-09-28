package dev.spectroscope.core;

import dev.spectroscope.core.events.RunEvent.PermissionRequest;

/**
 * The permission callback the frontend injects. Blocking by design: the agent loop runs
 * on a virtual thread, so waiting for a human (a terminal y/N, a WebSocket response) is a
 * plain blocking call. The broker lives in the core, the decision in the frontend.
 */
@FunctionalInterface
public interface PermissionBroker {
    /**
     * Blocks until the verdict exists — a terminal y/N, a WebSocket round-trip, or an
     * allowlist hit; the asking virtual thread simply waits.
     *
     * @param request the pending call — tool name, call id and the model-supplied input
     * @return true to execute the tool, false to refuse (the model sees an ERROR result)
     */
    boolean decide(PermissionRequest request);

    /**
     * Card 399: who answers this request without asking a person, asked BEFORE
     * the request is emitted, so the event can carry the answer in
     * {@link PermissionRequest#decidedBy()} and a viewer does not open a window
     * for a call that is already decided.
     *
     * <p>The loop still emits both events and still takes the verdict from
     * {@link #decide}, which it hands the stamped request. A broker that returns
     * a label here must answer that stamped request in {@code decide} without
     * parking. The default returns null: the request goes out unstamped, as it
     * did before this method existed.</p>
     *
     * @param request the call about to be emitted, not yet stamped
     * @return the label the gate audit writes for the decider ({@code mode:auto},
     *         {@code mode:readonly}, {@code allowlist}), or null when a person decides
     */
    default String decidedBy(PermissionRequest request) {
        return null;
    }

    /**
     * Card 453: whether the file tools may reach paths outside the working
     * directory on the NEXT call. Asked once per tool call, so a mode switched
     * mid-session applies to the call after the switch, and a child agent that
     * shares its parent's broker follows the parent's current mode.
     *
     * <p>The default is false: the fence stays where it always was.</p>
     *
     * @return true only while the {@code extended} permission mode is in force
     */
    default boolean reachesOutsideTheWorkingDirectory() {
        return false;
    }
}
