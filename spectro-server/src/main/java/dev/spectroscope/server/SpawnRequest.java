package dev.spectroscope.server;

/**
 * The JSON body of {@code POST /api/fleet/nodes} — a request to spawn one
 * fleet node. Only {@code prompt} and {@code context} are required; {@code
 * role} defaults to worker, {@code id} is generated when absent, and a
 * UI-spawned node always runs READONLY (there is no permissions field on
 * purpose — see {@link NodeSpawner}).
 *
 * @param prompt  the task the node runs (required, free text)
 * @param context the fleet session to join (required, {@code [A-Za-z0-9._-]})
 * @param role    the node's role on its card (optional, defaults to worker)
 * @param id      the node's id (optional; generated when absent)
 * @param linger  keep the node alive after its run, controllable until stopped
 */
public record SpawnRequest(String prompt, String context, String role, String id, boolean linger) {
}
