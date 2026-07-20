package dev.spectroscope.core.permission;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.events.RunEvent.PermissionRequest;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** The allowlist matcher: exact tool rules, prefix rules per guarded field, and the remember-rule scoper. */
class AllowlistTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static PermissionRequest command(String command) {
        return new PermissionRequest("main", "c1", "run_command",
                JSON.createObjectNode().put("command", command), 1L);
    }

    private static PermissionRequest write(String path) {
        return new PermissionRequest("main", "c2", "write_file",
                JSON.createObjectNode().put("path", path).put("content", "x"), 1L);
    }

    @Test
    void exactToolRulesApproveEveryCallOfThatTool() {
        Allowlist allowlist = Allowlist.fromEntries(List.of("write_file"));
        assertTrue(allowlist.allows(write("notes/a.txt")));
        assertFalse(allowlist.allows(command("rm -rf /")), "other tools stay guarded");
    }

    @Test
    void prefixRulesGuardTheRightField() {
        Allowlist allowlist = Allowlist.fromEntries(
                List.of("run_command:git status*", "write_file:docs/*"));
        assertTrue(allowlist.allows(command("git status --short")));
        assertFalse(allowlist.allows(command("git push --force")));
        assertTrue(allowlist.allows(write("docs/readme.md")));
        assertFalse(allowlist.allows(write("src/Main.java")));
    }

    @Test
    void emptyAndBlankEntriesAreIgnored() {
        Allowlist allowlist = Allowlist.fromEntries(List.of("", "  "));
        assertTrue(allowlist.isEmpty());
        assertFalse(allowlist.allows(command("ls")));
    }

    @Test
    void rememberRuleScopesRiskyToolsAndKeepsOthersBare() {
        assertEquals("run_command:git*",
                Allowlist.rememberRule("run_command",
                        JSON.createObjectNode().put("command", "git status --short")));
        assertEquals("write_file:docs/a.md*",
                Allowlist.rememberRule("write_file",
                        JSON.createObjectNode().put("path", "docs/a.md")));
        assertEquals("read_file",
                Allowlist.rememberRule("read_file", JSON.createObjectNode()),
                "a non-risky tool remembers its bare name");

        // The scoped rule then approves the same prefix and rejects a different command.
        Allowlist remembered = Allowlist.fromEntries(List.of(
                Allowlist.rememberRule("run_command",
                        JSON.createObjectNode().put("command", "git status --short"))));
        assertTrue(remembered.allows(command("git log")));
        assertFalse(remembered.allows(command("npm install")));
    }

    private static PermissionRequest edit(String path) {
        return new PermissionRequest("main", "c3", "edit_file",
                JSON.createObjectNode().put("path", path).put("old_string", "a").put("new_string", "b"), 1L);
    }

    private static PermissionRequest fetch(String url) {
        return new PermissionRequest("main", "c4", "web_fetch",
                JSON.createObjectNode().put("url", url), 1L);
    }

    @Test
    void editFileAndWebFetchAreScopedNeverBlanketApproved() {
        // One remembered click covers THIS path/url, not every future call.
        assertEquals("edit_file:docs/a.md*",
                Allowlist.rememberRule("edit_file",
                        JSON.createObjectNode().put("path", "docs/a.md")));
        assertEquals("web_fetch:https://example.com*",
                Allowlist.rememberRule("web_fetch",
                        JSON.createObjectNode().put("url", "https://example.com")));

        Allowlist remembered = Allowlist.fromEntries(List.of(
                Allowlist.rememberRule("edit_file",
                        JSON.createObjectNode().put("path", "docs/a.md")),
                Allowlist.rememberRule("web_fetch",
                        JSON.createObjectNode().put("url", "https://example.com"))));
        assertTrue(remembered.allows(edit("docs/a.md")));
        assertFalse(remembered.allows(edit(".spectro/settings.json")),
                "a remembered edit_file must not cover other paths");
        assertTrue(remembered.allows(fetch("https://example.com/docs")));
        assertFalse(remembered.allows(fetch("https://evil.example.net")),
                "a remembered web_fetch must not cover other hosts");
    }

    @Test
    void handWrittenPrefixRulesMatchEditFileAndWebFetch() {
        Allowlist allowlist = Allowlist.fromEntries(
                List.of("edit_file:src/*", "web_fetch:https://docs.example.com*"));
        assertTrue(allowlist.allows(edit("src/Main.java")));
        assertFalse(allowlist.allows(edit("build.gradle.kts")));
        assertTrue(allowlist.allows(fetch("https://docs.example.com/guide")));
        assertFalse(allowlist.allows(fetch("https://example.com")));
    }

    private static PermissionRequest browse(String url) {
        return new PermissionRequest("main", "c5", "browse_page",
                JSON.createObjectNode().put("url", url), 1L);
    }

    @Test
    void browsePageIsUrlScopedExactlyLikeWebFetch() {
        // browse_page reaches the network through a real browser — one
        // remembered click covers THIS url prefix, never every page.
        assertEquals("browse_page:https://docs.example.com*",
                Allowlist.rememberRule("browse_page",
                        JSON.createObjectNode().put("url", "https://docs.example.com")));

        Allowlist remembered = Allowlist.fromEntries(List.of(
                Allowlist.rememberRule("browse_page",
                        JSON.createObjectNode().put("url", "https://docs.example.com"))));
        assertTrue(remembered.allows(browse("https://docs.example.com/guide")));
        assertFalse(remembered.allows(browse("https://evil.example.net")),
                "a remembered browse_page must not cover other hosts");
    }

    @Test
    void webSearchRemembersItsBareName() {
        // Queries vary every call — a prefix scope would make remembering
        // useless, so web_search remembers like the other bare-name tools.
        assertEquals("web_search",
                Allowlist.rememberRule("web_search",
                        JSON.createObjectNode().put("query", "gradle dsl")));
    }
}
