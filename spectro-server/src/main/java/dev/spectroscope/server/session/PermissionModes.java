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
        if ("auto".equals(mode)) {
            return Boolean.TRUE;
        }
        if ("readonly".equals(mode)) {
            return Boolean.FALSE;
        }
        return null;
    }

    /**
     * Whether this mode has taken the human out of the loop (card 265).
     *
     * <p>It lives here rather than at the ask's call site so the two answers can
     * never disagree: a mode that short-circuits {@link #decide} is a mode where
     * nobody is being consulted, and a question put to that loop can only ever go
     * unanswered. Somebody who set {@code auto} or {@code readonly} declared "do
     * not bother me", and a question is a bother — so {@code ask_user_question}
     * returns "unanswered" immediately, without parking. It is not answered on
     * their behalf either; silence is the honest record.</p>
     *
     * @param mode the session's live permission mode; null means the default, ask
     * @return true when no human decides anything in this mode
     */
    static boolean unattended(String mode) {
        return decide(mode, null) != null;
    }
}
