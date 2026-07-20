package dev.spectroscope.server;

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
        if ("auto".equals(mode)) {
            return Boolean.TRUE;
        }
        if ("readonly".equals(mode)) {
            return Boolean.FALSE;
        }
        return null;
    }
}
