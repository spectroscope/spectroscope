package dev.spectroscope.server.session;

import dev.spectroscope.core.events.RunEvent.PermissionRequest;

/**
 * The three permission modes, decided BEFORE allowlist and dialog: gated
 * calls all auto-allow in "auto" (demo mode), all deny in "readonly"; "ask"
 * (and anything unknown) falls through to allowlist + dialog. Every decision
 * still travels the core's permission_request/permission_decision events, so
 * the JSONL stays the audit trail.
 */
final class PermissionModes {
    private PermissionModes() { }

    static Boolean decide(String mode, PermissionRequest request) {
        if ("auto".equals(mode) || "extended".equals(mode)) {
            return Boolean.TRUE; // card 453: extended approves exactly like auto
        }
        if ("readonly".equals(mode)) {
            return Boolean.FALSE;
        }
        return null;
    }

    /**
     * Card 399: the verdict a gate audit label stands for. {@code mode:auto} and
     * {@code mode:readonly} answer as {@link #decide} does for that mode,
     * {@code allowlist} allows; anything else, null included, has no verdict of
     * its own and the call parks.
     *
     * @param decidedBy the label, as {@code SessionConnection} stamps and audits it
     * @return the verdict, or null when a person has to decide
     */
    static Boolean verdictOf(String decidedBy) {
        if ("allowlist".equals(decidedBy)) {
            return Boolean.TRUE;
        }
        // Card 503: a call the relay rule blocked is refused.
        if (dev.spectroscope.core.peer.PeerRelayRule.DECIDED_BY.equals(decidedBy)) {
            return Boolean.FALSE;
        }
        if (decidedBy != null && decidedBy.startsWith("mode:")) {
            return decide(decidedBy.substring("mode:".length()), null);
        }
        return null;
    }

    /**
     * Card 503: whether the auto modes refuse a gated call because it relays
     * an action a peer said it was denied ({@link dev.spectroscope.core.peer.PeerRelayRule}).
     * In {@code ask} the dialog shows the call and the person decides; in
     * {@code readonly} it is refused anyway.
     *
     * @param mode    the session's mode
     * @param bodies  the peer messages the calling agent's run absorbed
     * @param request the gated call
     * @return true when the call is refused
     */
    static boolean relayBlocked(String mode, java.util.List<String> bodies, PermissionRequest request) {
        if (!"auto".equals(mode) && !"extended".equals(mode)) {
            return false;
        }
        return request != null
                && dev.spectroscope.core.peer.PeerRelayRule.blocks(bodies, request.name(), request.input());
    }
}
