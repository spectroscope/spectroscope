package dev.spectroscope.core.permission;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.events.RunEvent.PermissionRequest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The one-time migration (card 199, criteria 6 and 8).
 *
 * <p>The card's promise is exact: every entry that exists today approves the
 * same calls after the change as before it, and it gets there THROUGH the
 * migration rather than through an exemption. So the proof here is not "the
 * suite still passes" — it is a battery of every entry shape against every tool
 * class, with the PRE-CHANGE matcher as the oracle. That matcher is frozen into
 * this file ({@link #legacyAllows}) because it no longer exists anywhere else;
 * a copy that drifts would prove nothing, and this copy cannot drift, because
 * the behaviour it describes is finished history.
 */
class AllowlistMigrationTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /**
     * The allowlist matcher exactly as it stood before card 199: split the entry
     * on its FIRST colon into a tool name and a value prefix, require the tool
     * name to be EQUAL, and require the guarded value to start with the prefix.
     * No tiers, no wildcards. This is the oracle criterion 6 is measured against.
     */
    private static boolean legacyAllows(List<String> entries, PermissionRequest request) {
        for (String entry : entries) {
            if (entry == null || entry.isBlank()) {
                continue;
            }
            int colon = entry.indexOf(':');
            String tool = (colon < 0 ? entry : entry.substring(0, colon)).strip();
            String prefix = null;
            if (colon >= 0) {
                prefix = entry.substring(colon + 1).strip();
                if (prefix.endsWith("*")) {
                    prefix = prefix.substring(0, prefix.length() - 1);
                }
            }
            if (!tool.equals(request.name())) {
                continue;
            }
            if (prefix == null) {
                return true;
            }
            String field = switch (request.name()) {
                case "run_command" -> "command";
                case "write_file", "edit_file" -> "path";
                case "web_fetch", "browse_page" -> "url";
                default -> null;
            };
            if (field == null) {
                continue;
            }
            String value = request.input().path(field).asText("");
            if (!value.isEmpty() && value.startsWith(prefix)) {
                return true;
            }
        }
        return false;
    }

    /** Every entry shape a settings file carries today. */
    private static final List<String> LEGACY_ENTRIES = List.of(
            "read_file",
            "write_file",
            "edit_file",
            "run_command",
            "run_command:git status*",
            "write_file:docs/a.md*",
            "web_fetch:https://example.com*",
            "browse_page:https://example.com*",
            "web_search",
            "mcp__spectro-notes__search_notes",
            "mcp__spectro-notes__add_note",
            "mcp__playwright__browser_run_code_unsafe",
            "mcp__some_unblessed_server__anything",
            "mcp__spectro-notes__*",
            "spawn_agent");

    /** Every call the battery decides, across all three tiers and both faces. */
    private static List<PermissionRequest> battery() {
        return List.of(
                request("read_file", "path", "src/Main.java"),
                request("write_file", "path", "docs/a.md"),
                request("write_file", "path", "src/Main.java"),
                request("edit_file", "path", "src/Main.java"),
                request("run_command", "command", "git status --short"),
                request("run_command", "command", "rm -rf /"),
                request("web_fetch", "url", "https://example.com/a"),
                request("web_fetch", "url", "https://evil.test/a"),
                request("browse_page", "url", "https://example.com/a"),
                request("web_search", "query", "spectroscope"),
                request("grep", "pattern", "x"),
                request("mcp__spectro-notes__search_notes", "q", "x"),
                request("mcp__spectro-notes__add_note", "text", "x"),
                request("mcp__playwright__browser_run_code_unsafe", "code", "x"),
                request("mcp__some_unblessed_server__anything", "x", "y"),
                request("spawn_agent", "task", "x"));
    }

    private static PermissionRequest request(String tool, String field, String value) {
        ObjectNode input = JSON.createObjectNode();
        input.put(field, value);
        return new PermissionRequest("main", "c1", tool, input, 1L);
    }

    @Test
    void everyLegacyEntryApprovesExactlyWhatItApprovedBefore() {
        List<String> migrated = AllowlistMigration.migrate(LEGACY_ENTRIES, ToolTierMap.shipped())
                .entries();
        Allowlist after = Allowlist.fromEntries(migrated);
        for (PermissionRequest call : battery()) {
            assertEquals(legacyAllows(LEGACY_ENTRIES, call), after.allows(call),
                    "migration changed the verdict for " + call.name() + " " + call.input());
        }
    }

    @Test
    void theMigrationIsNotAnExemptionItStampsTheTierEachToolActuallyHolds() {
        List<String> migrated = AllowlistMigration.migrate(LEGACY_ENTRIES, ToolTierMap.shipped())
                .entries();
        assertTrue(migrated.contains("read_file#read"));
        assertTrue(migrated.contains("write_file#write"));
        assertTrue(migrated.contains("run_command#eval-execute"));
        assertTrue(migrated.contains("run_command#eval-execute:git status*"));
        assertTrue(migrated.contains("mcp__spectro-notes__search_notes#read"));
        assertTrue(migrated.contains("mcp__playwright__browser_run_code_unsafe#eval-execute"));
        assertTrue(migrated.contains("mcp__some_unblessed_server__anything#eval-execute"),
                "an unmapped tool keeps working through the widest tier, not through an exemption");
    }

    @Test
    void aLegacyWildcardWasInertBeforeAndStaysInertAfter() {
        List<String> migrated = AllowlistMigration.migrate(LEGACY_ENTRIES, ToolTierMap.shipped())
                .entries();
        assertTrue(migrated.contains("mcp__spectro-notes__*"),
                "it is left exactly as it stands — stamping it would WIDEN it");
        // On its own the wildcard approves nothing, before and after. (In the full
        // battery above the same server's reader IS approved, by the separate
        // entry that names it — which is the point: only the named one rides.)
        Allowlist wildcardAlone = Allowlist.fromEntries(
                AllowlistMigration.migrate(List.of("mcp__spectro-notes__*"), ToolTierMap.shipped())
                        .entries());
        assertFalse(wildcardAlone.allows(request("mcp__spectro-notes__search_notes", "q", "x")));
        assertFalse(wildcardAlone.allows(request("mcp__spectro-notes__add_note", "text", "x")));
    }

    @Test
    void anEntryThatAlreadyCarriesATierIsLeftAlone() {
        AllowlistMigration.Result result =
                AllowlistMigration.migrate(List.of("write_file#write", "read_file"),
                        ToolTierMap.shipped());
        assertEquals(List.of("write_file#write", "read_file#read"), result.entries());
        assertEquals(1, result.records().stream().filter(r -> r.changed()).count());
    }

    @Test
    void theMigrationIsRecordedEntryByEntry() {
        AllowlistMigration.Result result =
                AllowlistMigration.migrate(List.of("write_file", "mcp__spectro-notes__*"),
                        ToolTierMap.shipped());
        assertEquals(2, result.records().size());
        AllowlistMigration.EntryRecord write = result.records().get(0);
        assertEquals("write_file", write.before());
        assertEquals("write_file#write", write.after());
        assertEquals("write", write.tier());
        assertTrue(write.changed());
        AllowlistMigration.EntryRecord wildcard = result.records().get(1);
        assertFalse(wildcard.changed());
        assertTrue(wildcard.note().contains("wildcard"),
                "a reader has to see WHY this one was left alone, was: " + wildcard.note());
    }

    @Test
    void aSettingsFileIsMigratedInPlaceAndOnlyOnce(@TempDir Path home) throws IOException {
        Path settings = home.resolve(".spectro").resolve("settings.json");
        Files.createDirectories(settings.getParent());
        Files.writeString(settings, """
                {"provider":"ollama","autoApprove":["write_file","run_command:git status*"]}""");
        Path ledger = home.resolve("allowlist-migration.jsonl");

        assertTrue(AllowlistMigration.migrateFileOnce(settings, ToolTierMap.shipped(), ledger));
        JSON.readTree(Files.readString(settings));
        assertEquals(List.of("write_file#write", "run_command#eval-execute:git status*"),
                autoApprove(settings));
        assertEquals("ollama", JSON.readTree(Files.readString(settings)).path("provider").asText(),
                "every other key in the file survives");
        assertTrue(Files.readString(ledger).contains("\"before\":\"write_file\""),
                "the migration is itself auditable, entry by entry");

        // A second run must not touch the file — and must not re-stamp an entry
        // the user has since replaced with a bare one (that is a NEW entry, and
        // new entries are read-by-default on purpose).
        Files.writeString(settings, """
                {"provider":"ollama","autoApprove":["write_file#write","edit_file"]}""");
        assertFalse(AllowlistMigration.migrateFileOnce(settings, ToolTierMap.shipped(), ledger));
        assertEquals(List.of("write_file#write", "edit_file"), autoApprove(settings));
    }

    @Test
    void aFileWithoutAnAllowlistIsNeverRewritten(@TempDir Path home) throws IOException {
        Path settings = home.resolve("settings.json");
        Files.writeString(settings, """
                {"provider":"ollama"}""");
        String before = Files.readString(settings);
        assertFalse(AllowlistMigration.migrateFileOnce(settings, ToolTierMap.shipped(),
                home.resolve("ledger.jsonl")));
        assertEquals(before, Files.readString(settings));
    }

    private static List<String> autoApprove(Path settings) throws IOException {
        JsonNode array = JSON.readTree(Files.readString(settings)).path("autoApprove");
        List<String> entries = new java.util.ArrayList<>();
        array.forEach(node -> entries.add(node.asText()));
        return List.copyOf(entries);
    }
}
