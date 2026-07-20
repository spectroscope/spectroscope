package dev.spectroscope.server;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.events.RunEvent.PermissionRequest;
import dev.spectroscope.core.permission.Allowlist;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The server broker's short-circuit predicate: config.autoApprove() folded with the
 * session's remembered rules. Proven in isolation (the broker is a plain lambda over
 * an Allowlist + a rule list — no socket needed).
 */
class SessionRememberTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static PermissionRequest command(String command) {
        return new PermissionRequest("main", "c1", "run_command",
                JSON.createObjectNode().put("command", command), 1L);
    }

    /** Mirrors SessionConnection.allowlistNow(): boot rules + remembered rules. */
    private static Allowlist consult(List<String> autoApprove, List<String> remembered) {
        List<String> rules = new ArrayList<>(autoApprove);
        rules.addAll(remembered);
        return Allowlist.fromEntries(rules);
    }

    @Test
    void aRememberedRuleApprovesTheSamePrefixButNotAnotherCommand() {
        // The user allowed "git status --short" with "remember" → the scoped rule.
        String remembered = Allowlist.rememberRule("run_command",
                JSON.createObjectNode().put("command", "git status --short"));

        Allowlist afterRemember = consult(List.of(), List.of(remembered));
        assertTrue(afterRemember.allows(command("git log")), "same tool + prefix is auto-approved");
        assertFalse(afterRemember.allows(command("npm install")), "a different command still asks");
    }

    @Test
    void withoutARememberedRuleEveryGuardedCallStillParks() {
        Allowlist emptySession = consult(List.of(), List.of());
        assertFalse(emptySession.allows(command("git status")),
                "no boot rule, nothing remembered → the request must park/ask");
    }
}
