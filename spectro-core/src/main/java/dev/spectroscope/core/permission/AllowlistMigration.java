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

    private static final org.slf4j.Logger LOG =
            org.slf4j.LoggerFactory.getLogger(AllowlistMigration.class);

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

    /** What one call to {@link #migrateFileOnce} did — named, because "false" used
     *  to mean four different things and one of them was a failure nobody saw. */
    public enum Outcome {
        /** The file was rewritten by this call. */
        MIGRATED,
        /** There was nothing to do: no file, no {@code autoApprove}, or nothing in it to change. */
        NOTHING_TO_DO,
        /** This file has been migrated before — by the ledger, or by its own entries. */
        ALREADY_DONE,
        /** The file could not be read or written. Logged, NOT recorded as migrated. */
        FAILED
    }

    /**
     * Every settings file whose {@code autoApprove} block can reach the gate, in
     * fold order — the ONE list, because three hand-written copies of it drifted
     * and the workspace-local layer fell out of all three.
     *
     * <p>{@code settings.local.json} is not a lesser file: {@code autoApprove} is
     * whole-block replacement, so a workspace's local layer can BE the entire
     * effective allowlist. Leaving it unmigrated fails closed — its entries stop
     * approving what they approved yesterday — which is not a hole but is exactly
     * the prompt storm card 199 promised not to create.
     *
     * @param projectDir the launch directory, whose {@code .spectro/settings.json} is read
     * @param workspace  the resolved workspace, or null before one exists (boot);
     *                   only a workspace contributes the project+local pair
     * @return the files to migrate, in the order the config fold reads them
     */
    public static List<Path> settingsChain(Path projectDir, Path workspace) {
        List<Path> chain = new ArrayList<>(List.of(
                dev.spectroscope.core.config.SpectroConfig.USER_SETTINGS_PATH,
                dev.spectroscope.core.config.SpectroConfig.CONFIG_PATH,
                projectDir.resolve(dev.spectroscope.core.config.SpectroConfig.PROJECT_SETTINGS)));
        if (workspace != null) {
            chain.add(workspace.resolve(
                    dev.spectroscope.core.config.SpectroConfig.PROJECT_SETTINGS));
            chain.add(workspace.resolve(
                    dev.spectroscope.core.config.SpectroConfig.WS_LOCAL_SETTINGS));
        }
        return List.copyOf(chain);
    }

    /**
     * Migrates one settings file in place, at most once ever.
     *
     * <p><b>"Once" has two witnesses, because one was not enough.</b> The ledger
     * names every file it has migrated — by its REAL path, so the same file
     * reached through a symlinked home or through {@code /tmp} instead of
     * {@code /private/tmp} is the same file and not a second one. And the file's
     * own entries are read: a settings file that already carries a tier mark has
     * been through a build that knows about tiers, so it is left alone even when
     * the ledger has been rotated away. Either witness is enough to skip.
     *
     * <p><b>Why that matters more than tidiness.</b> A second pass over an
     * already-migrated file would stamp the entries a user added AFTERWARDS — and
     * a bare {@code run_command} written today deliberately approves nothing,
     * while {@code run_command#eval-execute} approves every command there is.
     * Re-running the migration must never widen anything, and with both witnesses
     * the only way left to reach that is a file whose every legacy entry was a
     * wildcard (so no tier mark was ever written) AND a lost ledger AND a bare
     * entry added in between.
     *
     * <p>Never throws — a failed migration must not take down the face that
     * called it. A file that cannot be read or written comes back as
     * {@link Outcome#FAILED} with a warning in the operator log, and is NOT
     * written to the ledger: it stays unmigrated, its entries approve read only
     * until a later boot succeeds (the strict direction), and the next boot tries
     * again instead of believing a migration that never happened.
     *
     * @param settingsFile the settings file to rewrite; a missing file is a no-op
     * @param tiers        the tier map whose verdict each entry is pinned at
     * @param ledger       the JSONL ledger recording every migration, appended to
     * @return what this call did
     */
    public static synchronized Outcome migrateFileOnce(Path settingsFile, ToolTierMap tiers,
                                                       Path ledger) {
        if (settingsFile == null || !Files.isRegularFile(settingsFile)) {
            return Outcome.NOTHING_TO_DO;
        }
        try {
            List<String> spellings = spellingsOf(settingsFile);
            if (alreadyMigrated(ledger, spellings)) {
                return Outcome.ALREADY_DONE;
            }
            JsonNode tree = JSON.readTree(Files.readString(settingsFile, StandardCharsets.UTF_8));
            if (!tree.isObject()) {
                return Outcome.NOTHING_TO_DO;
            }
            ObjectNode root = (ObjectNode) tree;
            JsonNode existing = root.path("autoApprove");
            if (!existing.isArray() || existing.isEmpty()) {
                return Outcome.NOTHING_TO_DO;
            }
            List<String> before = new ArrayList<>();
            existing.forEach(node -> before.add(node.asText()));
            if (before.stream().anyMatch(AllowlistMigration::carriesATier)) {
                // The second witness: these entries were written or rewritten by a
                // build that knows tiers, so this file's migration is behind it.
                return Outcome.ALREADY_DONE;
            }
            Result result = migrate(before, tiers);
            String identity = spellings.get(0);
            if (result.records().stream().noneMatch(EntryRecord::changed)) {
                // Nothing to rewrite, but the file has now been considered: record
                // that, so the pass is genuinely once-ever rather than once-per-boot.
                appendLedger(ledger, identity, tiers, result);
                return Outcome.NOTHING_TO_DO;
            }
            ArrayNode array = JSON.createArrayNode();
            result.entries().forEach(array::add);
            root.set("autoApprove", array);
            writeAtomically(settingsFile,
                    JSON.writerWithDefaultPrettyPrinter().writeValueAsString(root));
            appendLedger(ledger, identity, tiers, result);
            return Outcome.MIGRATED;
        } catch (IOException | RuntimeException cannot) {
            LOG.warn("the allowlist migration could not rewrite {} ({}) — its entries approve "
                            + "read only until a later run succeeds", settingsFile,
                    cannot.toString());
            return Outcome.FAILED;
        }
    }

    /** The production ledger: {@code ~/.spectro/gate-audit/allowlist-migration.jsonl}. */
    public static Path defaultLedger() {
        return Path.of(System.getProperty("user.home"), ".spectro", "gate-audit",
                "allowlist-migration.jsonl");
    }

    /** Whether an entry already names a tier — the file's own witness that a
     *  tier-aware build has written here. Read off the TOOL segment only: the
     *  value prefix after the first colon is free text and may contain anything. */
    private static boolean carriesATier(String entry) {
        if (entry == null) {
            return false;
        }
        int colon = entry.indexOf(':');
        String head = colon < 0 ? entry : entry.substring(0, colon);
        return head.indexOf(Allowlist.TIER_MARK) >= 0;
    }

    /**
     * How this file may be spelled in a ledger, canonical first.
     *
     * <p>{@code toRealPath} is what makes "once ever" true: one server run already
     * writes {@code /tmp/...} for a home-derived path and {@code /private/tmp/...}
     * for a {@code user.dir}-derived one, and a symlinked home or project folder
     * is the everyday version of the same thing. The absolute-normalized spelling
     * stays in the list so a ledger written by an older build still counts.
     *
     * @param file an existing file
     * @return the real path first, then the absolute normalized path
     */
    private static List<String> spellingsOf(Path file) {
        String absolute = file.toAbsolutePath().normalize().toString();
        try {
            String real = file.toRealPath().toString();
            return real.equals(absolute) ? List.of(real) : List.of(real, absolute);
        } catch (IOException notResolvable) {
            return List.of(absolute);
        }
    }

    /** Whether the ledger already carries a completed migration for this file,
     *  under any spelling of its path. */
    private static boolean alreadyMigrated(Path ledger, List<String> spellings) throws IOException {
        if (ledger == null || !Files.isRegularFile(ledger)) {
            return false;
        }
        for (String line : Files.readAllLines(ledger, StandardCharsets.UTF_8)) {
            if (line.isBlank()) {
                continue;
            }
            try {
                if (spellings.contains(JSON.readTree(line).path("file").asText(""))) {
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
