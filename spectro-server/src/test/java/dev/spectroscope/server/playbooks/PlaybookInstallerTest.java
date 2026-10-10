package dev.spectroscope.server.playbooks;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.playbook.Playbook;
import dev.spectroscope.core.playbook.PlaybookReader;
import dev.spectroscope.core.skills.SkillLibrary;
import dev.spectroscope.server.playbooks.PlaybookInstaller.Result;
import dev.spectroscope.server.playbooks.PlaybookInstaller.Status;
import dev.spectroscope.server.settings.StagedInstall;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Installing and removing what a playbook folder brings, against a temp home and the folder of
 * {@link PlaybookContentsTest}: two skills in a pack, a command, a hook with a script, an agent and
 * a workflow, plus the licence and provenance at the root.
 */
class PlaybookInstallerTest {

    @TempDir Path tmp;

    private final ObjectMapper json = new ObjectMapper();
    private Path dir;
    private Path home;
    private Path project;
    private Path settings;
    private InstallLedger ledger;

    @BeforeEach
    void fixture() throws IOException {
        dir = Files.createDirectories(tmp.resolve("pb")).toRealPath();
        home = tmp.resolve("home/.spectro");
        project = tmp.resolve("launch/.spectro/skills");
        settings = home.resolve("settings.json");
        ledger = new InstallLedger(home.resolve("playbook-installs.json"));
        write("playbook.json", PlaybookLoaderTest.MINIMAL.replace(
                "\"contents\": { \"skills\": [\"skills/spectropowers\"] }", PlaybookContentsTest.CONTENTS));
        write("skills/spectropowers/brainstorming/SKILL.md", "---\nname: brainstorming\ndescription: Shape an idea.\n---\nbody one\n");
        write("skills/spectropowers/debugging/SKILL.md", "---\nname: debugging\ndescription: Find the cause first.\n---\nbody two\n");
        write("agents/reviewer.md", "---\nname: reviewer\ndescription: Reads the diff.\ntype: explore\n---\nYou are the reviewer.\n");
        write("hooks/hooks.json", PlaybookContentsTest.HOOKS);
        write("hooks/guard.sh", "#!/bin/sh\nexit 0\n");
        write("commands/ship.md", "---\ndescription: Ship it.\n---\nRun the release.\n");
        write("workflows/build.js", "export default 1;\n");
        write("LICENSE", "MIT\n");
        write("PROVENANCE.md", "made here\n");
    }

    private void write(String rel, String text) throws IOException {
        Path file = dir.resolve(rel);
        Files.createDirectories(file.getParent());
        Files.writeString(file, text);
    }

    private Playbook playbook() throws IOException {
        return PlaybookReader.read(Files.readString(dir.resolve("playbook.json"))).playbook();
    }

    private String shownHash() throws IOException {
        return PlaybookContents.preview(dir, playbook(), home, project, ledger, null).contentsHash();
    }

    private PlaybookInstaller installer() {
        return new PlaybookInstaller(home, project, settings, ledger);
    }

    private Result install(boolean withHooks) throws IOException {
        return installer().install(dir, playbook(), shownHash(), withHooks);
    }

    private String hookCommand() {
        return "sh " + home.resolve("playbook-hooks/p") + "/guard.sh";
    }

    private List<String> settingsCommands() throws IOException {
        List<String> out = new ArrayList<>();
        for (JsonNode hook : json.readTree(Files.readString(settings)).path("hooks")) {
            out.add(hook.path("command").asText());
        }
        return out;
    }

    private static List<String> tree(Path root) throws IOException {
        if (!Files.exists(root)) {
            return List.of();
        }
        try (Stream<Path> walk = Files.walk(root)) {
            return walk.filter(Files::isRegularFile).map(p -> root.relativize(p).toString()).sorted().toList();
        }
    }

    // ---- install -----------------------------------------------------------------------------

    @Test
    void anInstallWithTheShownHashAndHooksWritesEveryPackTheHookAndTheLedger() throws IOException {
        Result result = install(true);

        assertEquals(Status.INSTALLED, result.status(), result.message());
        for (String skill : List.of("brainstorming", "debugging")) {
            Path folder = home.resolve("skills/spectropowers").resolve(skill);
            assertTrue(Files.isRegularFile(folder.resolve("SKILL.md")), skill);
            assertEquals("MIT\n", Files.readString(folder.resolve("LICENSE")), skill);
            assertEquals("made here\n", Files.readString(folder.resolve("PROVENANCE.md")), skill);
            JsonNode record = json.readTree(Files.readString(folder.resolve("spectro-install.json")));
            assertEquals("playbook", record.path("source").asText(null));
            assertEquals("spectropowers", record.path("pack").asText(null));
            assertEquals(skill, record.path("skill").asText(null));
            assertEquals("p", record.path("playbook").asText(null));
            assertEquals(dir.toString(), record.path("dir").asText(null));
            assertEquals(LocalDate.now().toString(), record.path("installedOn").asText(null));
            InstallLedger.Item item = ledger.find("p").orElseThrow().items().stream()
                    .filter(i -> i.name().equals("spectropowers:" + skill)).findFirst().orElseThrow();
            assertEquals(item.sha256(), record.path("sha256").asText(null));
            assertFalse(record.has("repo") || record.has("commit") || record.has("licence"),
                    "a playbook carries prose provenance, so the catalogue's three fields are left out");
        }

        String ship = Files.readString(home.resolve("skills/p/ship/SKILL.md"));
        assertTrue(ship.contains("\nname: ship\n"), ship);
        assertTrue(ship.contains("Ship it."), ship);
        assertTrue(ship.contains("Run the release."), ship);
        assertTrue(Files.isRegularFile(home.resolve("skills/p/ship/LICENSE")));
        assertTrue(Files.isRegularFile(home.resolve("skills/p/ship/PROVENANCE.md")));
        assertTrue(Files.isRegularFile(home.resolve("skills/p/ship/spectro-install.json")));

        assertEquals(List.of(hookCommand()), settingsCommands());
        Path guard = home.resolve("playbook-hooks/p/guard.sh");
        assertEquals("#!/bin/sh\nexit 0\n", Files.readString(guard));
        Set<PosixFilePermission> perms = Files.getPosixFilePermissions(guard);
        assertFalse(perms.contains(PosixFilePermission.OWNER_EXECUTE), perms.toString());
        assertFalse(Files.exists(home.resolve("playbook-hooks/p/hooks.json")), "the hooks file itself is not a script");

        InstallLedger.Install installed = ledger.find("p").orElseThrow();
        assertEquals(dir.toString(), installed.dir());
        assertEquals(shownHash(), installed.contentsHash());
        assertEquals(List.of("skill spectropowers:brainstorming", "skill spectropowers:debugging", "command p:ship",
                        "hook pre_tool_use run_command", "agent reviewer", "workflow build.js"),
                installed.items().stream().map(i -> i.kind() + " " + i.name()).toList());

        SkillLibrary library = SkillLibrary.load(List.of(home.resolve("skills")));
        assertTrue(library.find("spectropowers:brainstorming").isPresent());
        assertTrue(library.find("p:ship").isPresent());
        assertEquals("Ship it.", library.find("p:ship").orElseThrow().description());

        assertEquals(List.of("same", "same", "same", "same", "same", "not-run"),
                PlaybookContents.preview(dir, playbook(), home, project, ledger, null).items().stream()
                        .map(PlaybookContents.Item::state).toList(),
                "the preview after an install reads every installed item as unchanged");
        assertFalse(Files.exists(home.resolve(".skill-install")), "the staging folder is cleared");
    }

    @Test
    void aSecondInstallIsAlreadyAndNamesTheFolderAndTheDate() throws IOException {
        assertEquals(Status.INSTALLED, install(true).status());

        Result again = install(true);

        assertEquals(Status.ALREADY, again.status());
        assertTrue(again.message().contains(dir.toString()), again.message());
        assertTrue(again.message().contains(LocalDate.now().toString()), again.message());
    }

    /** The English text of {@code pc.already} in the web strings, or null outside a source checkout. */
    private static String alreadyInTheDialog() throws IOException {
        for (Path at = Path.of("").toAbsolutePath(); at != null; at = at.getParent()) {
            Path i18n = at.resolve("spectro-web/src/i18n/i18n.ts");
            if (Files.isRegularFile(at.resolve("settings.gradle.kts")) && Files.isRegularFile(i18n)) {
                java.util.regex.Matcher m = java.util.regex.Pattern.compile(
                        "\"pc\\.already\":\\s*\\{\\s*de:\\s*\"(?:[^\"\\\\]|\\\\.)*\",\\s*en:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"")
                        .matcher(Files.readString(i18n));
                assertTrue(m.find(), "no English text for pc.already in " + i18n);
                return m.group(1);
            }
        }
        return null;
    }

    @Test
    void theAlreadyRefusalSaysOnTheWireWhatTheDialogSaysInEnglish() throws IOException {
        assertEquals(Status.INSTALLED, install(true).status());

        Result again = install(true);

        String expected = "Already installed from " + dir + " on " + LocalDate.now()
                + ". Remove it first, then install again.";
        assertEquals(expected, again.message(), "the refusal on the wire");
        String dialog = alreadyInTheDialog();
        org.junit.jupiter.api.Assumptions.assumeTrue(dialog != null, "not running from a source checkout");
        assertEquals(expected, dialog.replace("{dir}", dir.toString()).replace("{date}", LocalDate.now().toString()),
                "the English sentence of pc.already in spectro-web/src/i18n/i18n.ts and the wire differ");
    }

    @Test
    void aShownHashThatIsNotTheCurrentOneIsChangedAndWritesNothing() throws IOException {
        String shown = shownHash();
        write("skills/spectropowers/debugging/SKILL.md", "---\nname: debugging\ndescription: Find the cause first.\n---\nedited\n");

        Result result = installer().install(dir, playbook(), shown, true);

        assertEquals(Status.CHANGED, result.status());
        assertEquals(List.of(), tree(home.resolve("skills")));
        assertFalse(Files.exists(settings));
        assertFalse(Files.exists(home.resolve("playbook-hooks")));
        assertTrue(ledger.find("p").isEmpty());
    }

    @Test
    void withoutTheHooksTickNoHookIsWrittenOrRecorded() throws IOException {
        Result result = install(false);

        assertEquals(Status.INSTALLED, result.status(), result.message());
        assertFalse(Files.exists(settings));
        assertFalse(Files.exists(home.resolve("playbook-hooks")));
        assertTrue(ledger.find("p").orElseThrow().items().stream().noneMatch(i -> i.kind().equals("hook")));
        assertTrue(Files.isRegularFile(home.resolve("skills/spectropowers/debugging/SKILL.md")));
    }

    @Test
    void anInstallOverTheCeilingIsTooLargeWithBothNumbersAndWritesNothing() throws IOException {
        PlaybookInstaller small = new PlaybookInstaller(home, project, settings, ledger, 3, 24L * 1024 * 1024,
                StagedInstall::promote);

        Result result = small.install(dir, playbook(), shownHash(), true);

        assertEquals(Status.TOO_LARGE, result.status());
        // Two skills and one command with three generated files each, and one hook script.
        assertTrue(result.message().contains("13 files"), result.message());
        assertTrue(result.message().contains(" bytes"), result.message());
        assertTrue(result.message().contains("3 files"), result.message());
        assertEquals(List.of(), tree(home));
    }

    @Test
    void aPromoteThatFailsOnTheSecondFolderTakesTheFirstBackAndRecordsNothing() throws IOException {
        int[] calls = {0};
        PlaybookInstaller.Promoter failing = (staged, target) -> {
            if (++calls[0] == 2) {
                throw new IOException("disk full");
            }
            return StagedInstall.promote(staged, target);
        };
        PlaybookInstaller breaking = new PlaybookInstaller(home, project, settings, ledger, 400, 24L * 1024 * 1024,
                failing);

        Result result = breaking.install(dir, playbook(), shownHash(), true);

        assertEquals(Status.FAILED, result.status());
        assertEquals(2, calls[0], "the second promote is the one that failed");
        assertFalse(Files.exists(home.resolve("skills/spectropowers")), "the first pack is taken back");
        assertEquals(List.of(), result.leftover());
        assertTrue(ledger.find("p").isEmpty());
        assertFalse(Files.exists(settings), "the hooks are appended after the promotes, so none were written");
        assertEquals(List.of(), tree(home.resolve("skills")));
    }

    @Test
    void aPlaybookWithoutProvenanceIsUnlicensedAndWritesNothing() throws IOException {
        Files.delete(dir.resolve("PROVENANCE.md"));

        Result result = install(true);

        assertEquals(Status.UNLICENSED, result.status());
        assertTrue(result.message().contains("unlicensed copy"), result.message());
        assertEquals(List.of(), tree(home));
    }

    @Test
    void aTakenSkillRefusesTheInstallAndNamesTheTargetAndItsOwner() throws IOException {
        Files.createDirectories(home.resolve("skills/spectropowers/debugging"));

        Result result = install(true);

        assertEquals(Status.TAKEN, result.status());
        assertEquals(List.of(home.resolve("skills/spectropowers/debugging") + " (user root)"), result.names());
        assertFalse(Files.exists(home.resolve("skills/spectropowers/brainstorming")));
    }

    @Test
    void aPlaybookWithAFindingIsRefusedWithTheFinding() throws IOException {
        write("commands/ship.md", "---\n---\nRun the release.\n");

        Result result = install(true);

        assertEquals(Status.FINDINGS, result.status());
        assertTrue(result.names().stream().anyMatch(n -> n.startsWith("commands/ship.md#description")),
                result.names().toString());
        assertEquals(List.of(), tree(home));
    }

    // ---- remove ------------------------------------------------------------------------------

    @Test
    void removeKeepsAnEditedSkillAndTakesOutTheRestAndOnlyTheRecordedHook() throws IOException {
        Files.createDirectories(home);
        String own = "{\"event\":\"post_tool_use\",\"command\":\"echo mine\"}";
        Files.writeString(settings, "{\"hooks\":[" + own + "]}");
        assertEquals(Status.INSTALLED, install(true).status());
        assertEquals(List.of("echo mine", hookCommand()), settingsCommands());
        Path edited = home.resolve("skills/spectropowers/brainstorming/SKILL.md");
        Files.writeString(edited, "---\nname: brainstorming\ndescription: Shape an idea.\n---\nmy own notes\n");

        Result result = installer().remove(dir, playbook());

        assertEquals(Status.REMOVED, result.status(), result.message());
        assertEquals(List.of("spectropowers:brainstorming"), result.names());
        assertTrue(Files.isRegularFile(edited), "the edited copy stays");
        assertFalse(Files.exists(home.resolve("skills/spectropowers/debugging")));
        assertFalse(Files.exists(home.resolve("skills/p")), "the command pack is gone");
        assertFalse(Files.exists(home.resolve("playbook-hooks/p")));
        assertEquals(List.of("echo mine"), settingsCommands(), "the user's own hook is kept");
        assertEquals(List.of("skill spectropowers:brainstorming"),
                ledger.find("p").orElseThrow().items().stream().map(i -> i.kind() + " " + i.name()).toList());
        assertFalse(Files.exists(home.resolve(".skill-remove")), "the holding folder is cleared");
    }

    @Test
    void removeOfAnUntouchedInstallTakesEverythingAndDropsTheLedgerEntry() throws IOException {
        assertEquals(Status.INSTALLED, install(true).status());

        Result result = installer().remove(dir, playbook());

        assertEquals(Status.REMOVED, result.status(), result.message());
        assertEquals(List.of(), result.names());
        assertEquals(List.of(), tree(home.resolve("skills")));
        assertFalse(Files.exists(home.resolve("playbook-hooks")));
        assertEquals(List.of(), settingsCommands());
        assertTrue(ledger.find("p").isEmpty());
        assertEquals(Status.INSTALLED, install(true).status(), "after a remove the playbook installs again");
    }

    @Test
    void removeOfAPlaybookThatIsNotInstalledIsNotInstalled() throws IOException {
        assertEquals(Status.NOT_INSTALLED, installer().remove(dir, playbook()).status());
    }
}
