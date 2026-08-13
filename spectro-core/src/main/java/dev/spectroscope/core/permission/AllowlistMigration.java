package dev.spectroscope.core.permission;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.List;

/**
 * The one-time, in-place migration of allowlist entries onto tiers
 * (card 199, criteria 6 and 8).
 *
 * <p><b>What it is for.</b> After card 199 an entry that names no tier approves
 * READ and nothing above. Applied to the entries already in people's settings
 * files, that rule would silently stop approving every write and every command
 * they had allowed — a prompt storm, and the measured answer to a prompt storm
 * on this product is a blanket approval. So each existing entry is rewritten
 * once to carry the tier its tool holds in the shipped map on the day of the
 * migration. No entry starts approving anything new, none stops approving what
 * it approved, and only entries written AFTER the migration fall under the
 * read-by-default rule.
 *
 * <p><b>What it deliberately does not fix.</b> A migrated bare {@code write_file}
 * entry keeps approving every write_file call, and a migrated entry for an
 * eval-class tool keeps approving that tool. The wildcard hole closes; the
 * exact-name hole stays open, and it stays open for precisely the entry an
 * injected page would tell a user to add. What card 199 buys against that is
 * visibility rather than a block: the settings page lists every entry with its
 * tier, and the gate audit names the entry that approved each call.
 *
 * <p><b>A legacy wildcard is left exactly as it stands.</b> Before this change
 * the matcher compared tool names with {@code equals}, so an entry like
 * {@code mcp__playwright__*} matched nothing at all. Stamping it with a tier
 * would turn dead config into a live family grant — the precise widening this
 * card exists to prevent. It stays unqualified, and an unqualified wildcard
 * approves nothing.
 */
public final class AllowlistMigration {

    private static final ObjectMapper JSON = new ObjectMapper();

    /**
     * What happened to one entry — the record criterion 8 asks for, so a reader
     * can see which tier each grandfathered entry was pinned at and when.
     *
     * @param before  the entry as it stood in the settings file
     * @param after   the entry as it stands now
     * @param tier    the tier it was pinned at, or null when it was left alone
     * @param changed whether the file's line actually changed
     * @param note    one sentence naming why, for the entries that were left alone
     */
    public record EntryRecord(String before, String after, String tier,
                              boolean changed, String note) {}

    /**
     * The migrated list plus its record.
     *
     * @param entries the entries as they should now stand in the file, in file order
     * @param records one record per entry, in the same order
     */
    public record Result(List<String> entries, List<EntryRecord> records) {}

    private AllowlistMigration() {
    }

    /**
     * Migrates a list of entries. Pure: it reads nothing and writes nothing.
     *
     * @param entries the raw autoApprove entries, in file order
     * @param tiers   the tier map whose verdict each entry is pinned at
     * @return the migrated entries and the entry-by-entry record
     */
    public static Result migrate(List<String> entries, ToolTierMap tiers) {
        List<String> migrated = new ArrayList<>();
        List<EntryRecord> records = new ArrayList<>();
        for (String entry : entries) {
            if (entry == null || entry.isBlank()) {
                continue;
            }
            int colon = entry.indexOf(':');
            String head = colon < 0 ? entry : entry.substring(0, colon);
            String tail = colon < 0 ? "" : entry.substring(colon);
            if (head.indexOf(Allowlist.TIER_MARK) >= 0) {
                migrated.add(entry);
                records.add(new EntryRecord(entry, entry, null, false,
                        "already carries a tier — written after the migration, or migrated before"));
                continue;
            }
            String tool = head.strip();
            if (tool.endsWith("*")) {
                migrated.add(entry);
                records.add(new EntryRecord(entry, entry, null, false,
                        "a wildcard matched nothing under the old name-only gate; "
                                + "stamping it with a tier would widen it, so it stays inert"));
                continue;
            }
            ToolTier tier = tiers.resolve(tool).tier();
            String after = tool + Allowlist.TIER_MARK + tier.wireName() + tail;
            migrated.add(after);
            records.add(new EntryRecord(entry, after, tier.wireName(), true,
                    "pinned at the tier " + tool + " holds in map version " + tiers.mapVersion()));
        }
        return new Result(List.copyOf(migrated), List.copyOf(records));
    }

    /**
     * Migrates one settings file in place, at most once ever.
     *
     * <p>"Once" is decided by the ledger, not by a marker inside the settings
     * file: the settings schema stays untouched, and the ledger is the auditable
     * record criterion 8 asks for anyway. A file already named in the ledger is
     * never rewritten again, so a bare entry a user adds later stays bare — that
     * is a NEW entry, and new entries are read-by-default on purpose.
     *
     * <p>Never throws. A settings file that cannot be read or written is left
     * alone: a failed migration must not take down the face that called it, and
     * an unmigrated file's entries still approve exactly what they approved (they
     * simply approve read only until the file is migrated, which is the strict
     * direction).
     *
     * @param settingsFile the settings file to rewrite; a missing file is a no-op
     * @param tiers        the tier map whose verdict each entry is pinned at
     * @param ledger       the JSONL ledger recording every migration, appended to
     * @return true when the file was rewritten by this call
     */
    public static synchronized boolean migrateFileOnce(Path settingsFile, ToolTierMap tiers,
                                                       Path ledger) {
        try {
            if (settingsFile == null || !Files.isRegularFile(settingsFile)) {
                return false;
            }
            String absolute = settingsFile.toAbsolutePath().normalize().toString();
            if (alreadyMigrated(ledger, absolute)) {
                return false;
            }
            JsonNode tree = JSON.readTree(Files.readString(settingsFile, StandardCharsets.UTF_8));
            if (!tree.isObject()) {
                return false;
            }
            ObjectNode root = (ObjectNode) tree;
            JsonNode existing = root.path("autoApprove");
            if (!existing.isArray() || existing.isEmpty()) {
                return false;
            }
            List<String> before = new ArrayList<>();
            existing.forEach(node -> before.add(node.asText()));
            Result result = migrate(before, tiers);
            if (result.records().stream().noneMatch(EntryRecord::changed)) {
                // Nothing to rewrite, but the file has now been considered: record
                // that, so the pass is genuinely once-ever rather than once-per-boot.
                appendLedger(ledger, absolute, tiers, result);
                return false;
            }
            ArrayNode array = JSON.createArrayNode();
            result.entries().forEach(array::add);
            root.set("autoApprove", array);
            writeAtomically(settingsFile,
                    JSON.writerWithDefaultPrettyPrinter().writeValueAsString(root));
            appendLedger(ledger, absolute, tiers, result);
            return true;
        } catch (IOException | RuntimeException leaveItAlone) {
            return false;
        }
    }

    /** The production ledger: {@code ~/.spectro/gate-audit/allowlist-migration.jsonl}. */
    public static Path defaultLedger() {
        return Path.of(System.getProperty("user.home"), ".spectro", "gate-audit",
                "allowlist-migration.jsonl");
    }

    /** Whether the ledger already carries a completed migration for this file. */
    private static boolean alreadyMigrated(Path ledger, String absoluteFile) throws IOException {
        if (ledger == null || !Files.isRegularFile(ledger)) {
            return false;
        }
        for (String line : Files.readAllLines(ledger, StandardCharsets.UTF_8)) {
            if (line.isBlank()) {
                continue;
            }
            try {
                if (absoluteFile.equals(JSON.readTree(line).path("file").asText(""))) {
                    return true;
                }
            } catch (IOException notALine) {
                // a corrupt line is not a migration record; keep reading
            }
        }
        return false;
    }

    /** Appends the one record for this file: when, which map, and every entry. */
    private static void appendLedger(Path ledger, String absoluteFile, ToolTierMap tiers,
                                     Result result) throws IOException {
        if (ledger == null) {
            return;
        }
        ObjectNode line = JSON.createObjectNode();
        line.put("type", "allowlist_migration");
        line.put("file", absoluteFile);
        line.put("ts", System.currentTimeMillis());
        line.put("schemaVersion", tiers.schemaVersion());
        line.put("mapVersion", tiers.mapVersion());
        ArrayNode entries = line.putArray("entries");
        for (EntryRecord record : result.records()) {
            ObjectNode node = entries.addObject();
            node.put("before", record.before());
            node.put("after", record.after());
            if (record.tier() != null) {
                node.put("tier", record.tier());
            }
            node.put("changed", record.changed());
            node.put("note", record.note());
        }
        Files.createDirectories(ledger.toAbsolutePath().getParent());
        Files.writeString(ledger, JSON.writeValueAsString(line) + "\n",
                StandardCharsets.UTF_8, StandardOpenOption.CREATE, StandardOpenOption.APPEND);
    }

    /** Write-to-temp then move — the same shape SettingsWriter uses, so a crash
     *  mid-write can never leave a half-written settings file behind. */
    private static void writeAtomically(Path file, String content) throws IOException {
        Path temp = file.resolveSibling(file.getFileName() + ".tmp");
        Files.writeString(temp, content, StandardCharsets.UTF_8);
        Files.move(temp, file, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
    }
}
