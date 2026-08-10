package dev.spectroscope.server.fleet;

/**
 * The JSON body of {@code POST /api/fleet/{node}/message} — the operator's own
 * words, addressed to a fleet node that stays (card 166's server leg).
 *
 * <p>One field, and it is required. Blank counts as missing: a message is not a
 * verb with a default, it is the whole content of the request, and an empty one
 * would spend a node's turn on nothing while the operator watched a 202.</p>
 *
 * @param text the operator's words, carried verbatim to the node
 */
public record NodeMessage(String text) {
}
