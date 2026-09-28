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
        if (decidedBy != null && decidedBy.startsWith("mode:")) {
            return decide(decidedBy.substring("mode:".length()), null);
        }
        return null;
    }
}
