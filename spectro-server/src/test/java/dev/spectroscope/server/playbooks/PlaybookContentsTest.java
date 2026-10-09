package dev.spectroscope.server.playbooks;

import dev.spectroscope.core.playbook.ContentHash;
import dev.spectroscope.core.playbook.Finding;
import dev.spectroscope.core.playbook.Playbook;
import dev.spectroscope.core.playbook.PlaybookReader;
import dev.spectroscope.core.playbook.SafeWalk;
import dev.spectroscope.server.playbooks.PlaybookContents.Item;
import dev.spectroscope.server.playbooks.PlaybookContents.Preview;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The contents preview of a playbook folder: what each file of the folder becomes, with its source,
 * hash, state and reach, computed without writing anything.
 */
class PlaybookContentsTest {

    static final String CONTENTS = """
        "contents": { "skills": ["skills/spectropowers"], "agents": ["agents/reviewer.md"],
                      "hooks": ["hooks/hooks.json"], "commands": ["commands/ship.md"],
                      "workflows": ["workflows/build.js"] }""";

    static final String HOOKS = """
        [ { "event": "pre_tool_use", "matcher": "run_command", "command": "sh {hooks}/guard.sh", "timeoutSeconds": 5 } ]
        """;

    @TempDir Path tmp;

    private Path dir;
    private Path home;
    private Path project;
    private InstallLedger ledger;

    @BeforeEach
    void fixture() throws IOException {
        dir = Files.createDirectories(tmp.resolve("pb")).toRealPath();
        home = tmp.resolve("home/.spectro");
        project = tmp.resolve("launch/.spectro/skills");
        ledger = new InstallLedger(tmp.resolve("home/playbook-installs.json"));
        String json = PlaybookLoaderTest.MINIMAL.replace("\"contents\": { \"skills\": [\"skills/spectropowers\"] }", CONTENTS);
        assertNotEquals(PlaybookLoaderTest.MINIMAL, json, "the fixture replaced the contents block");
        write("playbook.json", json);
        write("skills/spectropowers/brainstorming/SKILL.md", "---\nname: brainstorming\ndescription: Shape an idea.\n---\nbody one\n");
        write("skills/spectropowers/debugging/SKILL.md", "---\nname: debugging\ndescription: Find the cause first.\n---\nbody two\n");
        write("agents/reviewer.md", "---\nname: reviewer\ndescription: Reads the diff.\ntype: explore\n---\nYou are the reviewer.\n");
        write("hooks/hooks.json", HOOKS);
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

    private Preview preview() throws IOException {
        return preview(null);
    }

    private Preview preview(String hooksOrigin) throws IOException {
        PlaybookReader.Read read = PlaybookReader.read(Files.readString(dir.resolve("playbook.json")));
        Playbook playbook = read.playbook();
        return PlaybookContents.preview(dir, playbook, home, project, ledger, hooksOrigin);
    }

    private static List<String> kindNameState(Preview p) {
        return p.items().stream().map(i -> i.kind() + " " + i.name() + " " + i.state()).toList();
    }

    private static Item item(Preview p, String kind, String name) {
        return p.items().stream().filter(i -> i.kind().equals(kind) && i.name().equals(name)).findFirst().orElseThrow();
    }

    private static List<String> paths(Preview p) {
        return p.findings().stream().map(Finding::path).toList();
    }

    @Test
    void theFixtureIsAPlaybookTheReaderAcceptsWithoutFindings() throws IOException {
        assertEquals(List.of(), PlaybookReader.read(Files.readString(dir.resolve("playbook.json"))).findings());
    }

    @Test
    void aFolderWithEveryKindYieldsSixItemsInTheOrderOfTheConfirmation() throws IOException {
        Preview p = preview("user");

        assertEquals(List.of(), p.findings());
        assertEquals(List.of(
                "skill spectropowers:brainstorming new",
                "skill spectropowers:debugging new",
                "command p:ship new",
                "hook pre_tool_use run_command new",
                "agent reviewer new",
                "workflow build.js not-run"), kindNameState(p));
        assertEquals("p", p.playbook());
        assertEquals(dir.toString(), p.dir());
        assertEquals("user", p.hooksOrigin());

        Item brainstorming = item(p, "skill", "spectropowers:brainstorming");
        assertEquals("skills/spectropowers/brainstorming", brainstorming.source());
        assertEquals(home.resolve("skills/spectropowers/brainstorming").toString(), brainstorming.target());
        assertEquals("sessions", brainstorming.scope());
        assertEquals(ContentHash.tree(SafeWalk.walk(dir, dir.resolve("skills/spectropowers/brainstorming"))),
                brainstorming.sha256());
        assertTrue(brainstorming.bytes() > 0);

        Item ship = item(p, "command", "p:ship");
        assertEquals("commands/ship.md", ship.source());
        assertEquals(home.resolve("skills/p/ship").toString(), ship.target());
        assertEquals("sessions", ship.scope());

        Item agent = item(p, "agent", "reviewer");
        assertEquals("agents/reviewer.md", agent.source());
        assertEquals("runs", agent.scope());
        assertNull(agent.target());

        Item workflow = item(p, "workflow", "build.js");
        assertEquals("none", workflow.scope());
        assertEquals("workflows/build.js", workflow.source());
    }

    @Test
    void aHookCarriesItsResolvedCommandAndTheFullTextOfTheScriptsBesideIt() throws IOException {
        Item hook = item(preview(), "hook", "pre_tool_use run_command");

        assertEquals("sh " + home.resolve("playbook-hooks/p") + "/guard.sh", hook.command());
        assertEquals("hooks/hooks.json#0", hook.source());
        assertEquals("tool-calls", hook.scope());
        assertEquals(home.resolve("playbook-hooks/p").toString(), hook.target());
        assertEquals(1, hook.files().size(), "hooks.json itself is not a script file");
        assertEquals("guard.sh", hook.files().get(0).path());
        assertEquals("#!/bin/sh\nexit 0\n", hook.files().get(0).text());
        assertEquals(ContentHash.hook("pre_tool_use", "run_command", hook.command(), 5), hook.sha256());
    }

    @Test
    void promptCharsIsTheSumOfTheBulletsOfEverySkillAndCommand() throws IOException {
        int expected = ("- spectropowers:brainstorming: Shape an idea.".length() + 1)
                + ("- spectropowers:debugging: Find the cause first.".length() + 1)
                + ("- p:ship: Ship it.".length() + 1);
        assertEquals(expected, preview().promptChars());
    }

    @Test
    void theContentsHashIsStableAndFollowsEveryKindIncludingAgentsAndWorkflows() throws IOException {
        String base = preview().contentsHash();
        assertEquals(base, preview().contentsHash(), "a second preview of the same folder hashes the same");

        write("skills/spectropowers/debugging/SKILL.md", "---\nname: debugging\ndescription: Find the cause first.\n---\nbody two!\n");
        String skillChanged = preview().contentsHash();
        assertNotEquals(base, skillChanged);

        write("agents/reviewer.md", "---\nname: reviewer\ndescription: Reads the diff.\ntype: explore\n---\nYou are the reviewer!\n");
        String agentChanged = preview().contentsHash();
        assertNotEquals(skillChanged, agentChanged);

        write("workflows/build.js", "export default 2;\n");
        assertNotEquals(agentChanged, preview().contentsHash());
    }

    @Test
    void changingOnlyTheHookCommandChangesTheContentsHash() throws IOException {
        String before = preview().contentsHash();
        write("hooks/hooks.json", HOOKS.replace("guard.sh", "other.sh"));
        String after = preview().contentsHash();
        assertNotEquals(before, after);
    }

    @Test
    void aSkillFolderAlreadyUnderTheHomeIsTaken() throws IOException {
        Files.createDirectories(home.resolve("skills/spectropowers/brainstorming"));

        Preview p = preview();

        assertEquals("taken", item(p, "skill", "spectropowers:brainstorming").state());
        assertEquals("new", item(p, "skill", "spectropowers:debugging").state());
    }

    @Test
    void aProjectRootSkillOfTheSamePackAndFolderIsTaken() throws IOException {
        Files.createDirectories(project.resolve("spectropowers/debugging"));

        Preview p = preview();

        assertEquals("taken", item(p, "skill", "spectropowers:debugging").state());
        assertEquals("new", item(p, "skill", "spectropowers:brainstorming").state());
    }

    @Test
    void aCommandTargetThatExistsIsTaken() throws IOException {
        Files.createDirectories(home.resolve("skills/p/ship"));
        assertEquals("taken", item(preview(), "command", "p:ship").state());
    }

    @Test
    void aUserSettingsHookEqualInAllFourFieldsThatTheLedgerDoesNotRecordIsTaken() throws IOException {
        String command = "sh " + home.resolve("playbook-hooks/p") + "/guard.sh";
        Files.createDirectories(home);
        Files.writeString(home.resolve("settings.json"), "{\"hooks\":[{\"event\":\"pre_tool_use\",\"matcher\":\"run_command\","
                + "\"command\":" + jsonString(command) + ",\"timeoutSeconds\":5}]}");

        assertEquals("taken", item(preview(), "hook", "pre_tool_use run_command").state());

        Files.writeString(home.resolve("settings.json"), "{\"hooks\":[{\"event\":\"pre_tool_use\",\"matcher\":\"run_command\","
                + "\"command\":" + jsonString(command) + ",\"timeoutSeconds\":6}]}");
        assertEquals("new", item(preview(), "hook", "pre_tool_use run_command").state(),
                "a hook that differs in one field is not the same hook");
    }

    private static String jsonString(String text) {
        return "\"" + text.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
    }

    @Test
    void aLinkInsideASkillFolderIsAFindingWithItsPathAndTheSkillIsNotListed() throws IOException {
        Path outside = Files.writeString(tmp.resolve("outside.txt"), "x");
        Files.createSymbolicLink(dir.resolve("skills/spectropowers/debugging/notes.txt"), outside);

        Preview p = preview();

        assertEquals(List.of("skills/spectropowers/debugging/notes.txt"), paths(p));
        assertTrue(p.findings().get(0).message().contains("symbolic link"), p.findings().get(0).message());
        assertEquals(List.of(
                "skill spectropowers:brainstorming new",
                "command p:ship new",
                "hook pre_tool_use run_command new",
                "agent reviewer new",
                "workflow build.js not-run"), kindNameState(p));
    }

    @Test
    void aHooksEntryWithAFieldOutsideTheFourIsAFindingAtThatField() throws IOException {
        write("hooks/hooks.json", """
            [ { "event": "pre_tool_use", "command": "sh {hooks}/guard.sh", "source": "x" } ]
            """);

        Preview p = preview();

        assertEquals(List.of("hooks/hooks.json[0].source"), paths(p));
        assertEquals(List.of(), p.items().stream().filter(i -> i.kind().equals("hook")).toList());
    }

    @Test
    void aHooksEntryWithAnUnknownEventIsAFindingWithTheMessageHookConfigThrows() throws IOException {
        write("hooks/hooks.json", """
            [ { "event": "pre-tool-use", "command": "sh {hooks}/guard.sh" } ]
            """);

        Preview p = preview();

        assertEquals(List.of("hooks/hooks.json[0].event"), paths(p));
        assertTrue(p.findings().get(0).message().contains("Unknown hook event \"pre-tool-use\""), p.findings().get(0).message());
    }

    @Test
    void aHookFileThatIsNotUtf8IsAFindingAndNoHookIsListed() throws IOException {
        Files.write(dir.resolve("hooks/guard.sh"), new byte[] {(byte) 0xC3, (byte) 0x28});

        Preview p = preview();

        assertEquals(List.of("hooks/guard.sh"), paths(p));
        assertTrue(p.findings().get(0).message().contains("UTF-8"), p.findings().get(0).message());
        assertEquals(0, p.items().stream().filter(i -> i.kind().equals("hook")).count());
    }

    @Test
    void aCommandWithoutADescriptionIsAFinding() throws IOException {
        write("commands/ship.md", "---\n---\nRun the release.\n");

        Preview p = preview();

        assertEquals(List.of("commands/ship.md#description"), paths(p));
        assertEquals(0, p.items().stream().filter(i -> i.kind().equals("command")).count());
    }

    @Test
    void aFindingOfTheAgentFileIsPassedOnWithItsPath() throws IOException {
        write("agents/reviewer.md", "---\nname: reviewer\ndescription: Reads the diff.\ntype: wizard\n---\nbody\n");

        Preview p = preview();

        assertEquals(List.of("agents/reviewer.md#type"), paths(p));
        assertEquals(0, p.items().stream().filter(i -> i.kind().equals("agent")).count());
    }

    @Test
    void aSkillWhoseFrontmatterNameDiffersFromItsFolderIsAFinding() throws IOException {
        write("skills/spectropowers/debugging/SKILL.md", "---\nname: bug-hunt\ndescription: d\n---\nbody\n");

        Preview p = preview();

        assertEquals(List.of("skills/spectropowers/debugging/SKILL.md#name"), paths(p));
        assertEquals(0, p.items().stream().filter(i -> i.name().equals("spectropowers:debugging")).count());
    }

    @Test
    void aLedgerEntryMakesAnUntouchedItemSameAndNamesWhichSideChanged() throws IOException {
        Path source = dir.resolve("skills/spectropowers/brainstorming");
        Path target = home.resolve("skills/spectropowers/brainstorming");
        Files.createDirectories(target);
        Files.copy(source.resolve("SKILL.md"), target.resolve("SKILL.md"));
        Files.writeString(target.resolve("LICENSE"), "MIT\n");
        Files.writeString(target.resolve("spectro-install.json"), "{}");
        String sha = ContentHash.tree(SafeWalk.walk(dir, source));
        ledger.put(new InstallLedger.Install("p", dir.toString(), "old", "2026-10-10", List.of(
                new InstallLedger.Item("skill", "spectropowers:brainstorming", "skills/spectropowers/brainstorming", sha,
                        target.toString(), List.of("LICENSE", "PROVENANCE.md", "spectro-install.json"), null))));

        assertEquals("same", item(preview(), "skill", "spectropowers:brainstorming").state());
        assertEquals("new", item(preview(), "skill", "spectropowers:debugging").state());

        Files.writeString(target.resolve("SKILL.md"), "---\nname: brainstorming\ndescription: Shape an idea.\n---\nedited by hand\n");
        assertEquals("copy-changed", item(preview(), "skill", "spectropowers:brainstorming").state());

        Files.copy(source.resolve("SKILL.md"), target.resolve("SKILL.md"), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        write("skills/spectropowers/brainstorming/SKILL.md", "---\nname: brainstorming\ndescription: Shape an idea.\n---\nnew upstream\n");
        assertEquals("source-changed", item(preview(), "skill", "spectropowers:brainstorming").state());
    }

    @Test
    void aTargetThatExistsWhileTheLedgerHoldsNoItemForItIsTakenEvenWithAnInstallRecorded() throws IOException {
        Files.createDirectories(home.resolve("skills/spectropowers/debugging"));
        ledger.put(new InstallLedger.Install("p", dir.toString(), "old", "2026-10-10", List.of()));

        assertEquals("taken", item(preview(), "skill", "spectropowers:debugging").state());
    }

    @Test
    void thePreviewWritesNothingToTheHome() throws IOException {
        preview();
        assertTrue(Files.notExists(home), "the preview does not create the home folder");
        assertTrue(Files.notExists(tmp.resolve("home/playbook-installs.json")));
    }
}
