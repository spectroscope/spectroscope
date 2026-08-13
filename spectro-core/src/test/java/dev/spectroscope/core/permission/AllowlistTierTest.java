package dev.spectroscope.core.permission;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.events.RunEvent.PermissionRequest;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The tier-qualified allowlist (card 199).
 *
 * <p>The entry grammar gained one character: {@code <tool>[#<tier>][:<prefix>]}.
 * The hash rather than a second colon because the colon is already spent — an
 * entry is parsed on its FIRST colon into a tool name plus a value prefix, and
 * the "remember this decision" path writes entries in exactly that shape. The
 * card parks the final spelling as an owner call; the hash is what this build
 * implements, and everything below tests the SEMANTICS, which the owner's
 * choice of separator would not change.
 *
 * <p>Two rules carry the card: an entry without a tier approves read and
 * nothing above it, and a wildcard without a tier approves nothing at all.
 * Together they make widening a deliberate, visible act.
 */
class AllowlistTierTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static PermissionRequest request(String tool) {
        return new PermissionRequest("main", "c1", tool, JSON.createObjectNode(), 1L);
    }

    private static PermissionRequest request(String tool, String field, String value) {
        ObjectNode input = JSON.createObjectNode();
        input.put(field, value);
        return new PermissionRequest("main", "c1", tool, input, 1L);
    }

    @Test
    void anEntryWithoutATierApprovesReadAndNothingAbove() {
        Allowlist allowlist = Allowlist.fromEntries(List.of("read_file", "write_file"));
        assertTrue(allowlist.allows(request("read_file")), "read_file is a read tool");
        assertFalse(allowlist.allows(request("write_file")),
                "an unqualified entry written after this change approves read only");
    }

    @Test
    void anEntryThatNamesTheTierApprovesThatTier() {
        Allowlist allowlist = Allowlist.fromEntries(List.of("write_file#write"));
        assertTrue(allowlist.allows(request("write_file")));
    }

    @Test
    void aWildcardWithoutATierApprovesNothing() {
        Allowlist allowlist = Allowlist.fromEntries(List.of("mcp__spectro-notes__*"));
        assertFalse(allowlist.allows(request("mcp__spectro-notes__search_notes")),
                "widening a whole family is never a default");
        assertFalse(allowlist.allows(request("mcp__spectro-notes__add_note")));
    }

    @Test
    void aReadWildcardApprovesTheReadersAndStopsEverythingAbove() {
        Allowlist allowlist = Allowlist.fromEntries(List.of("mcp__spectro-notes__*#read"));
        assertTrue(allowlist.allows(request("mcp__spectro-notes__search_notes")),
                "the reader runs without a prompt");
        assertFalse(allowlist.allows(request("mcp__spectro-notes__add_note")),
                "the writer still stops at the gate");
    }

    @Test
    void aReadWildcardNeverCoversAToolTheMapDoesNotList() {
        Allowlist allowlist = Allowlist.fromEntries(List.of("mcp__spectro-notes__*#read"));
        assertFalse(allowlist.allows(request("mcp__spectro-notes__a_tool_added_after_this_release")),
                "an unmapped tool is eval-execute and cannot ride a read entry");
    }

    @Test
    void theNodeContextEvalNeverRidesInOnAReadOrAWriteEntry() {
        String evalTool = "mcp__playwright__browser_run_code_unsafe";
        assertFalse(Allowlist.fromEntries(List.of("mcp__playwright__*#read")).allows(request(evalTool)));
        assertFalse(Allowlist.fromEntries(List.of("mcp__playwright__*#write")).allows(request(evalTool)));
        assertTrue(Allowlist.fromEntries(List.of("mcp__playwright__*#eval-execute")).allows(request(evalTool)),
                "an owner who writes eval-execute in full gets what they asked for");
    }

    @Test
    void anUnknownTierWordMakesTheEntryInertRatherThanPermissive() {
        Allowlist allowlist = Allowlist.fromEntries(List.of("mcp__spectro-notes__*#reed"));
        assertFalse(allowlist.allows(request("mcp__spectro-notes__search_notes")),
                "a typo must not become a grant");
    }

    @Test
    void theValuePrefixStillGuardsBesideATier() {
        Allowlist allowlist = Allowlist.fromEntries(List.of("run_command#eval-execute:git status*"));
        assertTrue(allowlist.allows(request("run_command", "command", "git status --short")));
        assertFalse(allowlist.allows(request("run_command", "command", "rm -rf /")));
    }

    @Test
    void aStarInsideTheToolSegmentIsNotAWildcard() {
        Allowlist allowlist = Allowlist.fromEntries(List.of("mcp__*__search_notes#read"));
        assertFalse(allowlist.allows(request("mcp__spectro-notes__search_notes")),
                "only a TRAILING star widens; a star in the middle is a literal");
    }

    @Test
    void aRememberedRuleCarriesTheTierOfTheToolItRemembers() {
        assertEquals("write_file#write:docs/a.md*",
                Allowlist.rememberRule("write_file",
                        JSON.createObjectNode().put("path", "docs/a.md")));
        assertEquals("read_file#read",
                Allowlist.rememberRule("read_file", JSON.createObjectNode()));
        assertEquals("run_command#eval-execute:git*",
                Allowlist.rememberRule("run_command",
                        JSON.createObjectNode().put("command", "git status")));
    }

    @Test
    void aRememberedRuleApprovesExactlyWhatWasApproved() {
        String rule = Allowlist.rememberRule("write_file",
                JSON.createObjectNode().put("path", "docs/a.md"));
        Allowlist allowlist = Allowlist.fromEntries(List.of(rule));
        assertTrue(allowlist.allows(request("write_file", "path", "docs/a.md")));
        assertFalse(allowlist.allows(request("write_file", "path", "src/Main.java")));
        assertFalse(allowlist.allows(request("run_command", "command", "docs/a.md")),
                "the tool name still has to match");
    }

    @Test
    void theVerdictNamesTheEntryTheTierAndTheMapVersionForTheAuditTrail() {
        Allowlist allowlist = Allowlist.fromEntries(List.of("mcp__spectro-notes__*#read"));
        Allowlist.Verdict approved = allowlist.decide(request("mcp__spectro-notes__search_notes"));
        assertTrue(approved.approved());
        assertEquals("mcp__spectro-notes__*#read", approved.entry());
        assertEquals(ToolTier.READ, approved.ceiling());
        assertEquals(ToolTier.READ, approved.toolTier());
        assertEquals(ToolTierMap.shipped().mapVersion(), approved.mapVersion());

        Allowlist.Verdict refused = allowlist.decide(request("mcp__spectro-notes__add_note"));
        assertFalse(refused.approved());
        assertNull(refused.entry(), "no entry approved it — the audit line says so");
        assertEquals(ToolTier.WRITE, refused.toolTier(),
                "the refusal still names the tier the tool actually holds");
    }
}
