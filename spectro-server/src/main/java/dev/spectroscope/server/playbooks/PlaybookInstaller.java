package dev.spectroscope.server.playbooks;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.HookConfig;
import dev.spectroscope.core.config.SettingsWriter;
import dev.spectroscope.core.playbook.ContentHash;
import dev.spectroscope.core.playbook.Finding;
import dev.spectroscope.core.playbook.Playbook;
import dev.spectroscope.core.playbook.PlaybookValidator;
import dev.spectroscope.core.playbook.SafeWalk;
import dev.spectroscope.core.skills.Skill;
import dev.spectroscope.core.skills.SkillLibrary;
import dev.spectroscope.server.settings.StagedInstall;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.TreeSet;
import java.util.stream.Stream;

/**
 * Installs and removes what a playbook folder brings: its skill packs and its commands under
 * {@code ~/.spectro/skills}, its hook scripts under {@code ~/.spectro/playbook-hooks/<id>}, its hook
 * entries in the user settings (only when the owner ticked them), and one entry in the install
 * ledger. Agents and workflows are recorded and never copied.
 *
 * <p>An install binds to the list the owner saw: the contents hash of the preview is computed again
 * and must equal the shown one. Every pack is built in a staging folder beside the skills root and
 * moved into place with one atomic move; a failure after a move takes the earlier moves back. The
 * hooks are appended after the moves and the ledger is written last.
 *
 * <p>A remove takes out what the ledger records and keeps every copy that was edited after the
 * install, because it holds work the installer did not write.
 */
public final class PlaybookInstaller {

    /** How an install or a remove ended. */
    public enum Status { INSTALLED, REMOVED, FINDINGS, UNLICENSED, CHANGED, ALREADY, TAKEN, TOO_LARGE, NOT_INSTALLED, FAILED }

    /** The move of a staged folder into place; the seam the take back test breaks. */
    @FunctionalInterface
    interface Promoter {
        StagedInstall.Outcome promote(Path staged, Path target) throws IOException;
    }

    /**
     * The answer. {@code names} holds the installed item names, the taken targets with their owner,
     * the findings, or on a remove the items that were kept. {@code leftover} names folders a failed
     * install or remove could not take back.
     */
    public record Result(Status status, String message, List<String> names, List<String> leftover) {
        public Result {
            names = names == null ? List.of() : List.copyOf(names);
            leftover = leftover == null ? List.of() : List.copyOf(leftover);
        }
    }

    /** The catalogue's ceilings, {@code SkillCatalogue.MAX_FILES} and {@code MAX_BYTES}. */
    static final int MAX_FILES = 400;
    static final long MAX_BYTES = 24L * 1024 * 1024;

    static final String STAGING_DIR = ".skill-install";
    static final String REMOVE_HOLDING_DIR = ".skill-remove";
    static final String LICENCE_FILE = "LICENSE";
    static final String PROVENANCE_FILE = "PROVENANCE.md";
    static final String INSTALL_RECORD = "spectro-install.json";
    static final String SKILL_FILE = "SKILL.md";

    private static final String UNLICENSED_MESSAGE = "The playbook folder has no readable LICENSE and PROVENANCE.md at "
            + "its root; refusing to install an unlicensed copy.";

    private static final ObjectMapper JSON = new ObjectMapper();

    private final Path spectroHome;
    private final Path projectSkills;
    private final Path userSettings;
    private final InstallLedger ledger;
    private final int maxFiles;
    private final long maxBytes;
    private final Promoter promoter;

    /**
     * @param spectroHome   {@code ~/.spectro}
     * @param projectSkills the launch directory's {@code .spectro/skills}
     * @param userSettings  the user settings file the hooks are appended to
     * @param ledger        the install ledger
     */
    public PlaybookInstaller(Path spectroHome, Path projectSkills, Path userSettings, InstallLedger ledger) {
        this(spectroHome, projectSkills, userSettings, ledger, MAX_FILES, MAX_BYTES, StagedInstall::promote);
    }

    PlaybookInstaller(Path spectroHome, Path projectSkills, Path userSettings, InstallLedger ledger,
                      int maxFiles, long maxBytes, Promoter promoter) {
        this.spectroHome = spectroHome.toAbsolutePath().normalize();
        this.projectSkills = projectSkills.toAbsolutePath().normalize();
        this.userSettings = userSettings;
        this.ledger = ledger;
        this.maxFiles = maxFiles;
        this.maxBytes = maxBytes;
        this.promoter = promoter;
    }

    // ---- install -----------------------------------------------------------------------------

    /** One folder to build and move into place, with the ledger items it carries. */
    private record Pack(String label, Path target, List<StagedInstall.FileCopy> files, long bytes) {}

    /**
     * Installs the contents of a playbook folder.
     *
     * @param dir       the playbook folder, already checked to be registered
     * @param playbook  the playbook read from its {@code playbook.json}
     * @param shownHash the contents hash of the list the owner saw
     * @param withHooks true when the owner ticked the hooks
     * @return what happened; only {@link Status#INSTALLED} wrote anything
     */
    public Result install(Path dir, Playbook playbook, String shownHash, boolean withHooks) {
        Path root;
        PlaybookContents.Preview preview;
        try {
            root = dir.toRealPath();
            preview = PlaybookContents.preview(root, playbook, spectroHome, projectSkills, ledger, null);
        } catch (IOException | RuntimeException unreadable) {
            return result(Status.FAILED, "The contents could not be read: " + unreadable.getMessage(), List.of());
        }

        // 1. Findings: the format, the contents paths and every source.
        List<Finding> findings = new ArrayList<>(PlaybookValidator.validate(playbook));
        findings.addAll(PlaybookLoader.contentsFindings(root, playbook.contents()));
        findings.addAll(preview.findings());
        if (!findings.isEmpty()) {
            return result(Status.FINDINGS, "The playbook has findings; nothing was written.",
                    findings.stream().map(f -> f.path() + ": " + f.message()).distinct().toList());
        }

        // 2. The click binds to the list that was shown.
        if (!preview.contentsHash().equals(shownHash)) {
            return result(Status.CHANGED, "The folder changed since the list was shown; nothing was written.", List.of());
        }

        // 3. One install per playbook id, and no target that belongs to someone else.
        String id = playbook.id();
        Optional<InstallLedger.Install> earlier;
        try {
            earlier = ledger.find(id);
        } catch (IllegalStateException unreadable) {
            return result(Status.FAILED, unreadable.getMessage(), List.of());
        }
        if (earlier.isPresent()) {
            // The English sentence of pc.already in the web strings, word for word.
            return result(Status.ALREADY, "Already installed from " + earlier.get().dir() + " on "
                    + earlier.get().installedOn() + ". Remove it first, then install again.", List.of());
        }
        List<PlaybookContents.Item> items = preview.items().stream()
                .filter(i -> withHooks || !i.kind().equals("hook"))
                .toList();
        List<String> taken = taken(items);
        if (!taken.isEmpty()) {
            return result(Status.TAKEN, "Some targets already exist and were not installed from this playbook: "
                    + String.join(", ", taken) + ".", taken);
        }

        // 4 and 5. Build every file list first, so the ceilings count all of it before anything is written.
        Path licence = root.resolve(LICENCE_FILE);
        Path provenance = root.resolve(PROVENANCE_FILE);
        boolean licensed = Files.isRegularFile(licence, LinkOption.NOFOLLOW_LINKS)
                && Files.isRegularFile(provenance, LinkOption.NOFOLLOW_LINKS)
                && Files.isReadable(licence) && Files.isReadable(provenance);
        String installedOn = LocalDate.now().toString();
        List<Pack> packs = new ArrayList<>();
        List<InstallLedger.Item> recorded = new ArrayList<>();
        List<HookConfig> hookEntries = new ArrayList<>();
        try {
            long licenceBytes = licensed ? Files.size(licence) : 0;
            long provenanceBytes = licensed ? Files.size(provenance) : 0;
            Map<String, List<PlaybookContents.Item>> skillPacks = new LinkedHashMap<>();
            for (PlaybookContents.Item item : items) {
                if (item.kind().equals("skill")) {
                    skillPacks.computeIfAbsent(Path.of(item.target()).getParent().getFileName().toString(),
                            k -> new ArrayList<>()).add(item);
                }
            }
            for (Map.Entry<String, List<PlaybookContents.Item>> pack : skillPacks.entrySet()) {
                packs.add(skillPack(root, id, pack.getKey(), pack.getValue(), licence, provenance, licenceBytes,
                        provenanceBytes, installedOn, recorded));
            }
            List<PlaybookContents.Item> commands = items.stream().filter(i -> i.kind().equals("command")).toList();
            if (!commands.isEmpty()) {
                packs.add(commandPack(root, id, commands, licence, provenance, licenceBytes, provenanceBytes,
                        installedOn, recorded));
            }
            List<PlaybookContents.Item> hooks = items.stream().filter(i -> i.kind().equals("hook")).toList();
            if (!hooks.isEmpty()) {
                packs.add(hookPack(root, id, hooks, hookEntries, recorded));
            }
            for (PlaybookContents.Item item : items) {
                if (item.kind().equals("agent") || item.kind().equals("workflow")) {
                    recorded.add(new InstallLedger.Item(item.kind(), item.name(), item.source(), item.sha256(), null,
                            List.of(), null));
                }
            }
        } catch (IOException | RuntimeException unreadable) {
            return result(Status.FAILED, "The playbook folder could not be read: " + unreadable.getMessage(), List.of());
        }
        int files = packs.stream().mapToInt(p -> p.files().size()).sum();
        long bytes = packs.stream().mapToLong(Pack::bytes).sum();
        if (files > maxFiles || bytes > maxBytes) {
            return result(Status.TOO_LARGE, "Too large to install: " + files + " files and " + bytes
                    + " bytes; the limit is " + maxFiles + " files and " + maxBytes + " bytes.", List.of());
        }
        if (!licensed) {
            return result(Status.UNLICENSED, UNLICENSED_MESSAGE, List.of());
        }

        // 6 to 8. Stage, promote, append the hooks, write the ledger.
        Path stagingRoot = spectroHome.resolve(STAGING_DIR);
        List<Path> staged = new ArrayList<>();
        List<Path> promoted = new ArrayList<>();
        List<Path> createdParents = new ArrayList<>();
        List<HookConfig> appended = List.of();
        try {
            for (Pack pack : packs) {
                staged.add(StagedInstall.build(stagingRoot, pack.label(), pack.files()));
            }
            for (int i = 0; i < packs.size(); i++) {
                Path target = packs.get(i).target();
                boolean parentExisted = Files.isDirectory(target.getParent());
                StagedInstall.Outcome outcome = promoter.promote(staged.get(i), target);
                if (!parentExisted && Files.isDirectory(target.getParent())) {
                    createdParents.add(target.getParent());
                }
                if (outcome == StagedInstall.Outcome.TAKEN) {
                    List<String> leftover = takeBack(promoted, createdParents);
                    return new Result(leftover.isEmpty() ? Status.TAKEN : Status.FAILED,
                            target + " appeared while the install ran; nothing was installed.",
                            List.of(target + " (user root)"), leftover);
                }
                promoted.add(target);
            }
            if (!hookEntries.isEmpty()) {
                appended = SettingsWriter.appendHooks(userSettings, hookEntries);
            }
            ledger.put(new InstallLedger.Install(id, root.toString(), preview.contentsHash(), installedOn, recorded));
        } catch (IOException | RuntimeException failure) {
            List<String> leftover = new ArrayList<>();
            if (!appended.isEmpty()) {
                try {
                    SettingsWriter.removeHooks(userSettings, appended);
                } catch (IOException | RuntimeException stuck) {
                    leftover.add(userSettings + " (hooks)");
                }
            }
            leftover.addAll(takeBack(promoted, createdParents));
            String message = "The install failed: " + failure.getMessage()
                    + (leftover.isEmpty() ? "; everything written was taken back." : "; these could not be taken back: "
                    + String.join(", ", leftover) + ".");
            return new Result(Status.FAILED, message, List.of(), leftover);
        } finally {
            for (Path folder : staged) {
                StagedInstall.discard(folder, stagingRoot);
            }
            StagedInstall.discard(null, stagingRoot);
        }
        return result(Status.INSTALLED, "Installed " + recorded.size() + " items from " + id + ".",
                recorded.stream().map(InstallLedger.Item::name).toList());
    }

    private Pack skillPack(Path root, String id, String pack, List<PlaybookContents.Item> skills, Path licence,
                           Path provenance, long licenceBytes, long provenanceBytes, String installedOn,
                           List<InstallLedger.Item> recorded) throws IOException {
        List<StagedInstall.FileCopy> files = new ArrayList<>();
        long bytes = 0;
        for (PlaybookContents.Item item : skills) {
            String folder = Path.of(item.target()).getFileName().toString();
            Path source = root.resolve(item.source());
            SafeWalk.Walk walk = SafeWalk.walk(root, source);
            if (!walk.refused().isEmpty()) {
                throw new IOException("refused: " + String.join(", ", walk.refused()));
            }
            Set<String> own = new LinkedHashSet<>(walk.files());
            for (String rel : walk.files()) {
                files.add(new StagedInstall.FileCopy(folder + "/" + rel, open(source.resolve(rel))));
            }
            String licenceName = free(own, LICENCE_FILE, pack);
            String provenanceName = free(own, PROVENANCE_FILE, pack);
            byte[] record = record(pack, folder, id, root, item.sha256(), installedOn);
            files.add(new StagedInstall.FileCopy(folder + "/" + licenceName, open(licence)));
            files.add(new StagedInstall.FileCopy(folder + "/" + provenanceName, open(provenance)));
            files.add(new StagedInstall.FileCopy(folder + "/" + INSTALL_RECORD, () -> new ByteArrayInputStream(record)));
            bytes += walk.bytes() + licenceBytes + provenanceBytes + record.length;
            recorded.add(new InstallLedger.Item("skill", item.name(), item.source(), item.sha256(), item.target(),
                    List.of(licenceName, provenanceName, INSTALL_RECORD), null));
        }
        return new Pack(pack, spectroHome.resolve("skills").resolve(pack), files, bytes);
    }

    /** The commands become one file skills in a pack named by the playbook id. */
    private Pack commandPack(Path root, String id, List<PlaybookContents.Item> commands, Path licence, Path provenance,
                             long licenceBytes, long provenanceBytes, String installedOn,
                             List<InstallLedger.Item> recorded) throws IOException {
        List<StagedInstall.FileCopy> files = new ArrayList<>();
        long bytes = 0;
        for (PlaybookContents.Item item : commands) {
            String stem = Path.of(item.target()).getFileName().toString();
            Path source = root.resolve(item.source());
            Skill parsed = SkillLibrary.parse(Files.readString(source, StandardCharsets.UTF_8), stem, source);
            byte[] skill = ("---\nname: " + stem + "\ndescription: \"" + parsed.description() + "\"\n---\n"
                    + parsed.body() + "\n").getBytes(StandardCharsets.UTF_8);
            byte[] record = record(id, stem, id, root, item.sha256(), installedOn);
            files.add(new StagedInstall.FileCopy(stem + "/" + SKILL_FILE, () -> new ByteArrayInputStream(skill)));
            files.add(new StagedInstall.FileCopy(stem + "/" + LICENCE_FILE, open(licence)));
            files.add(new StagedInstall.FileCopy(stem + "/" + PROVENANCE_FILE, open(provenance)));
            files.add(new StagedInstall.FileCopy(stem + "/" + INSTALL_RECORD, () -> new ByteArrayInputStream(record)));
            bytes += skill.length + licenceBytes + provenanceBytes + record.length;
            recorded.add(new InstallLedger.Item("command", item.name(), item.source(), item.sha256(), item.target(),
                    List.of(SKILL_FILE, LICENCE_FILE, PROVENANCE_FILE, INSTALL_RECORD), null));
        }
        return new Pack(id, spectroHome.resolve("skills").resolve(id), files, bytes);
    }

    /**
     * The scripts beside every hooks file go into one folder, {@code playbook-hooks/<id>}, which is
     * what {@code {hooks}} resolves to; the hooks files themselves are not copied.
     */
    private Pack hookPack(Path root, String id, List<PlaybookContents.Item> hooks, List<HookConfig> entries,
                          List<InstallLedger.Item> recorded) throws IOException {
        Map<String, StagedInstall.FileCopy> files = new LinkedHashMap<>();
        long bytes = 0;
        Map<String, JsonNode> read = new LinkedHashMap<>();
        for (PlaybookContents.Item item : hooks) {
            int hash = item.source().lastIndexOf('#');
            String fileRel = item.source().substring(0, hash);
            int index = Integer.parseInt(item.source().substring(hash + 1));
            Path hooksFile = root.resolve(fileRel);
            if (!read.containsKey(fileRel)) {
                read.put(fileRel, JSON.readTree(Files.readString(hooksFile, StandardCharsets.UTF_8)));
                Path folder = hooksFile.getParent();
                SafeWalk.Walk walk = SafeWalk.walk(root, folder);
                if (!walk.refused().isEmpty()) {
                    throw new IOException("refused: " + String.join(", ", walk.refused()));
                }
                for (String rel : walk.files()) {
                    if (rel.equals(hooksFile.getFileName().toString()) || files.containsKey(rel)) {
                        continue;
                    }
                    files.put(rel, new StagedInstall.FileCopy(rel, open(folder.resolve(rel))));
                    bytes += Files.size(folder.resolve(rel));
                }
            }
            JsonNode node = read.get(fileRel).get(index);
            String matcher = node.path("matcher").isTextual() ? node.get("matcher").asText() : null;
            Integer timeout = node.path("timeoutSeconds").isIntegralNumber() ? node.get("timeoutSeconds").asInt() : null;
            HookConfig entry = new HookConfig(matcher, node.path("event").asText(), item.command(), timeout);
            entries.add(entry);
            Map<String, Object> recordedEntry = new LinkedHashMap<>();
            recordedEntry.put("event", entry.event());
            if (matcher != null) {
                recordedEntry.put("matcher", matcher);
            }
            recordedEntry.put("command", entry.command());
            if (timeout != null) {
                recordedEntry.put("timeoutSeconds", timeout);
            }
            recorded.add(new InstallLedger.Item("hook", item.name(), item.source(), item.sha256(), item.target(),
                    List.of(), recordedEntry));
        }
        return new Pack(id, spectroHome.resolve("playbook-hooks").resolve(id), new ArrayList<>(files.values()), bytes);
    }

    /**
     * Every target that exists and is not this playbook's, named with its owner: the items the
     * preview reads as {@code taken}, and a pack, command or hook folder that is already there.
     */
    private List<String> taken(List<PlaybookContents.Item> items) {
        Set<String> out = new LinkedHashSet<>();
        Set<Path> namedPacks = new LinkedHashSet<>();
        for (PlaybookContents.Item item : items) {
            if (!item.state().equals("taken")) {
                continue;
            }
            if (item.kind().equals("hook")) {
                out.add(item.command() + " (settings)");
                continue;
            }
            Path target = Path.of(item.target());
            Path inProject = projectSkills.resolve(target.getParent().getFileName().toString())
                    .resolve(target.getFileName().toString());
            if (Files.exists(target, LinkOption.NOFOLLOW_LINKS)) {
                out.add(target + " (" + owner(target) + ")");
            }
            if (Files.exists(inProject, LinkOption.NOFOLLOW_LINKS)) {
                out.add(inProject + " (project root)");
            }
            namedPacks.add(target.getParent());
        }
        Set<Path> folders = new LinkedHashSet<>();
        for (PlaybookContents.Item item : items) {
            switch (item.kind()) {
                case "skill", "command" -> folders.add(Path.of(item.target()).getParent());
                case "hook" -> folders.add(Path.of(item.target()));
                default -> { }
            }
        }
        for (Path folder : folders) {
            if (!namedPacks.contains(folder) && Files.exists(folder, LinkOption.NOFOLLOW_LINKS)) {
                out.add(folder + " (" + owner(folder) + ")");
            }
        }
        return List.copyOf(out);
    }

    /** {@code catalogue} when the folder or a skill in it carries the catalogue's install record, else {@code user root}. */
    private static String owner(Path folder) {
        List<Path> records = new ArrayList<>();
        records.add(folder.resolve(INSTALL_RECORD));
        try (Stream<Path> children = Files.list(folder)) {
            children.forEach(child -> records.add(child.resolve(INSTALL_RECORD)));
        } catch (IOException | RuntimeException notAFolder) {
            // a file or an unreadable folder has no records to read
        }
        for (Path record : records) {
            try {
                if (Files.isRegularFile(record, LinkOption.NOFOLLOW_LINKS)
                        && "bundled catalogue".equals(JSON.readTree(record.toFile()).path("source").asText(null))) {
                    return "catalogue";
                }
            } catch (IOException | RuntimeException unreadable) {
                // a record that does not read says nothing about the owner
            }
        }
        return "user root";
    }

    /** Deletes the promoted folders in reverse order; names each one that would not go. */
    private static List<String> takeBack(List<Path> promoted, List<Path> createdParents) {
        List<String> leftover = new ArrayList<>();
        for (int i = promoted.size() - 1; i >= 0; i--) {
            if (!deleteTree(promoted.get(i))) {
                leftover.add(0, promoted.get(i).toString());
            }
        }
        for (Path parent : createdParents) {
            deleteIfEmpty(parent);
        }
        return leftover;
    }

    // ---- remove ------------------------------------------------------------------------------

    /**
     * Removes what the ledger records for the playbook's id. A skill whose copy no longer hashes to
     * what was installed stays and is named; a hook entry that was edited by hand stays in the
     * settings, and the hook folder stays with it while any settings entry still names the folder.
     *
     * @param dir      the playbook folder
     * @param playbook the playbook read from its {@code playbook.json}
     * @return {@link Status#REMOVED} with the kept item names, {@link Status#NOT_INSTALLED}, or
     *         {@link Status#FAILED} with what could not be put back
     */
    public Result remove(Path dir, Playbook playbook) {
        String id = playbook.id();
        Optional<InstallLedger.Install> found;
        try {
            found = ledger.find(id);
        } catch (IllegalStateException unreadable) {
            return result(Status.FAILED, unreadable.getMessage(), List.of());
        }
        if (found.isEmpty()) {
            return result(Status.NOT_INSTALLED, id + " is not installed.", List.of());
        }
        InstallLedger.Install install = found.get();
        List<HookConfig> userHooks = PlaybookContents.readUserHooks(userSettings);
        List<HookConfig> ours = install.items().stream()
                .filter(i -> i.kind().equals("hook"))
                .map(PlaybookContents::recordedEntry)
                .filter(Objects::nonNull)
                .toList();

        List<InstallLedger.Item> kept = new ArrayList<>();
        List<Path> folders = new ArrayList<>();
        List<HookConfig> hookEntries = new ArrayList<>();
        Path hookFolder = null;
        try {
            for (InstallLedger.Item item : install.items()) {
                switch (item.kind()) {
                    case "skill" -> {
                        Path target = Path.of(item.target());
                        if (Files.exists(target, LinkOption.NOFOLLOW_LINKS)) {
                            if (copyMatches(target, item)) {
                                folders.add(target);
                            } else {
                                kept.add(item);
                            }
                        }
                    }
                    case "command" -> {
                        Path target = Path.of(item.target());
                        if (Files.exists(target, LinkOption.NOFOLLOW_LINKS)) {
                            folders.add(target);
                        }
                    }
                    case "hook" -> {
                        hookFolder = Path.of(item.target());
                        HookConfig entry = PlaybookContents.recordedEntry(item);
                        if (entry != null && userHooks.contains(entry)) {
                            hookEntries.add(entry);
                        } else if (namesFolder(userHooks, hookFolder, ours)) {
                            kept.add(item);
                        }
                    }
                    default -> { } // agents and workflows were never copied
                }
            }
        } catch (IOException | RuntimeException unreadable) {
            return result(Status.FAILED, "The installed copies could not be read: " + unreadable.getMessage(), List.of());
        }
        boolean hookKept = kept.stream().anyMatch(i -> i.kind().equals("hook"));
        if (hookFolder != null && !hookKept && Files.exists(hookFolder, LinkOption.NOFOLLOW_LINKS)) {
            folders.add(hookFolder);
        }

        Path holdingRoot = spectroHome.resolve(REMOVE_HOLDING_DIR);
        Path holding = holdingRoot.resolve(String.valueOf(System.nanoTime()));
        List<Path> moved = new ArrayList<>();
        try {
            for (Path folder : folders) {
                Files.createDirectories(holding);
                Files.move(folder, holding.resolve(String.valueOf(moved.size())));
                moved.add(folder);
            }
            if (!hookEntries.isEmpty()) {
                SettingsWriter.removeHooks(userSettings, hookEntries);
            }
        } catch (IOException | RuntimeException failure) {
            List<String> leftover = new ArrayList<>();
            for (int back = moved.size() - 1; back >= 0; back--) {
                try {
                    Files.move(holding.resolve(String.valueOf(back)), moved.get(back));
                } catch (IOException | RuntimeException stuck) {
                    leftover.add(0, moved.get(back).toString());
                }
            }
            deleteIfEmpty(holding);
            deleteIfEmpty(holdingRoot);
            String message = "The remove failed: " + failure.getMessage()
                    + (leftover.isEmpty() ? "; nothing was removed." : "; these wait in " + holding + ": "
                    + String.join(", ", leftover) + ".");
            return new Result(Status.FAILED, message, List.of(), leftover);
        }
        deleteTree(holding);
        deleteIfEmpty(holdingRoot);
        for (Path folder : moved) {
            deleteIfEmpty(folder.getParent());
        }
        if (kept.isEmpty()) {
            ledger.drop(id);
        } else {
            ledger.put(new InstallLedger.Install(id, install.dir(), install.contentsHash(), install.installedOn(), kept));
        }
        List<String> keptNames = kept.stream().map(InstallLedger.Item::name).toList();
        return result(Status.REMOVED, keptNames.isEmpty() ? "Removed " + id + "."
                : "Removed " + id + "; kept the edited " + String.join(", ", keptNames) + ".", keptNames);
    }

    /** True when the installed copy, without the files the installer generated, hashes to what was installed. */
    private boolean copyMatches(Path target, InstallLedger.Item item) throws IOException {
        SafeWalk.Walk copy = SafeWalk.walk(spectroHome, target);
        if (!copy.refused().isEmpty()) {
            return false;
        }
        Set<String> skip = new TreeSet<>(item.generated());
        skip.add(".disabled");
        return ContentHash.tree(copy, skip).equals(item.sha256());
    }

    /** True when a settings entry the installer did not write still names the hook folder: an entry edited by hand. */
    private static boolean namesFolder(List<HookConfig> userHooks, Path hookFolder, List<HookConfig> ours) {
        String path = hookFolder.toString();
        return userHooks.stream()
                .filter(h -> !ours.contains(h))
                .anyMatch(h -> h.command() != null && h.command().contains(path));
    }

    // ---- shared ------------------------------------------------------------------------------

    private static StagedInstall.Source open(Path file) {
        return () -> Files.newInputStream(file, LinkOption.NOFOLLOW_LINKS);
    }

    /**
     * The catalogue's rule for the pack files: a name a skill's own files already use gets the pack
     * name before its extension, so the playbook's licence still travels beside the skill.
     */
    private static String free(Set<String> own, String fileName, String pack) {
        boolean used = own.stream().anyMatch(rel -> rel.equals(fileName) || rel.startsWith(fileName + "/"));
        if (!used) {
            return fileName;
        }
        int dot = fileName.lastIndexOf('.');
        return dot < 0 ? fileName + "." + pack : fileName.substring(0, dot) + "." + pack + fileName.substring(dot);
    }

    private static byte[] record(String pack, String skill, String playbook, Path dir, String sha256,
                                 String installedOn) throws IOException {
        Map<String, Object> record = new LinkedHashMap<>();
        record.put("pack", pack);
        record.put("skill", skill);
        record.put("source", "playbook");
        record.put("playbook", playbook);
        record.put("dir", dir.toString());
        record.put("sha256", sha256);
        record.put("installedOn", installedOn);
        return (JSON.writerWithDefaultPrettyPrinter().writeValueAsString(record) + "\n").getBytes(StandardCharsets.UTF_8);
    }

    private static Result result(Status status, String message, List<String> names) {
        return new Result(status, message, names, List.of());
    }

    private static boolean deleteTree(Path root) {
        if (!Files.exists(root, LinkOption.NOFOLLOW_LINKS)) {
            return true;
        }
        try (Stream<Path> walk = Files.walk(root)) {
            for (Path path : walk.sorted(Comparator.reverseOrder()).toList()) {
                Files.deleteIfExists(path);
            }
            return true;
        } catch (IOException | RuntimeException stubborn) {
            return false;
        }
    }

    private static void deleteIfEmpty(Path dir) {
        try (Stream<Path> entries = Files.list(dir)) {
            if (entries.findAny().isEmpty()) {
                Files.deleteIfExists(dir);
            }
        } catch (IOException | RuntimeException absentOrBusy) {
            // an absent or non empty folder stays as it is
        }
    }
}
