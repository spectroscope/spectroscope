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
}
