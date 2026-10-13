package dev.spectroscope.core.skills;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 558, integrator decision 3: the workspace source is the session's own
 * working folder, its {@code .spectro} and {@code .claude} skills, commands and
 * agents, read in place.
 */
class WorkspaceItemsTest {

    @TempDir Path ws;

    private void write(String rel, String text) throws IOException {
        Path f = ws.resolve(rel);
        Files.createDirectories(f.getParent());
        Files.writeString(f, text);
    }

    private static Map<String, String> byPlain(SessionCatalogue.Layer layer, String kind) {
        return layer.entries().stream().filter(e -> e.kind().equals(kind))
                .collect(Collectors.toMap(SessionCatalogue.Entry::plain, SessionCatalogue.Entry::body));
    }

    @Test
    void skillsComeFromBothFoldersAndTheSpectroCopyWinsInsideTheWorkspace() throws IOException {
        write(".claude/skills/alpha/SKILL.md", "---\nname: alpha\ndescription: from claude\n---\nclaude alpha");
        write(".claude/skills/shared/SKILL.md", "---\nname: shared\n---\nclaude shared");
        write(".spectro/skills/shared/SKILL.md", "---\nname: shared\n---\nspectro shared");
        write(".spectro/skills/pack/tdd/SKILL.md", "---\nname: tdd\n---\nred first");

        SessionCatalogue.Layer layer = WorkspaceItems.read(ws);

        assertEquals(SessionCatalogue.WORKSPACE, layer.source());
        assertEquals(SessionCatalogue.WORKSPACE, layer.namespace());
        assertEquals(Map.of("alpha", "claude alpha", "shared", "spectro shared", "pack:tdd", "red first"),
                byPlain(layer, SessionCatalogue.SKILL));
    }

    @Test
    void commandsAreTheMarkdownFilesOfBothCommandFolders() throws IOException {
        write(".claude/commands/deploy.md", "---\ndescription: Deploy the app\nargument-hint: [env]\n---\nDeploy it now.");
        write(".spectro/commands/review.md", "Review the diff line by line.");
        write(".claude/commands/notes.txt", "not a command");
        write(".claude/commands/nested/deep.md", "---\ndescription: deep\n---\nnot read");

        SessionCatalogue.Layer layer = WorkspaceItems.read(ws);

        assertEquals(Map.of("deploy", "Deploy it now.", "review", "Review the diff line by line."),
                byPlain(layer, SessionCatalogue.COMMAND));
        SessionCatalogue.Entry deploy = layer.entries().stream().filter(e -> e.plain().equals("deploy")).findFirst()
                .orElseThrow();
        assertEquals("Deploy the app", deploy.description());
    }

    @Test
    void agentsTakeTheirTypeFromTheFileOrFromTheToolsTheyName() throws IOException {
        write(".spectro/agents/scout.md", "---\nname: scout\ndescription: Looks around\ntype: explore\n---\nLook, never edit.");
        write(".claude/agents/reader.md", "---\nname: reader\ndescription: Reads\ntools: Read, Grep, Glob\n---\nRead only.");
        write(".claude/agents/fixer.md", "---\nname: fixer\ndescription: Fixes\ntools: Read, Edit, Bash\nmodel: opus\n---\nFix it.");
        write(".claude/agents/helper.md", "---\nname: helper\ndescription: Helps\n---\nHelp with anything.");
        write(".claude/agents/empty.md", "---\nname: empty\ndescription: nothing\n---\n");
        write(".claude/agents/bad.md", "---\nname: ../bad\ndescription: escapes\n---\nbody");

        SessionCatalogue.Layer layer = WorkspaceItems.read(ws);

        Map<String, String> types = layer.entries().stream().filter(e -> e.kind().equals(SessionCatalogue.AGENT))
                .collect(Collectors.toMap(SessionCatalogue.Entry::plain, SessionCatalogue.Entry::agentType));
        assertEquals(Map.of("scout", "explore", "reader", "explore", "fixer", "worker", "helper", "worker"), types);
        assertEquals("Look, never edit.", byPlain(layer, SessionCatalogue.AGENT).get("scout"));
    }

    @Test
    void aFolderWithoutEitherSubfolderBringsNothing() {
        SessionCatalogue.Layer layer = WorkspaceItems.read(ws);
        assertTrue(layer.entries().isEmpty());
        assertEquals(List.of(), WorkspaceItems.read(null).entries());
    }

    private String typeOf(String name) {
        return WorkspaceItems.read(ws).entries().stream().filter(e -> e.plain().equals(name)).findFirst()
                .orElseThrow().agentType();
    }

    /** Review finding 3: tools as a YAML block list or a flow list, and Bash(...) entries. */
    @Test
    void theToolsOfAnAgentAreReadAsABlockListAFlowListOrALine() throws IOException {
        write(".claude/agents/blockread.md", "---\nname: blockread\ndescription: d\ntools:\n  - Read\n  - Grep\n---\nRead.");
        write(".claude/agents/blockbash.md", "---\nname: blockbash\ndescription: d\ntools:\n  - Read\n  - \"Bash(git log:*)\"\n---\nRun.");
        write(".claude/agents/flowbash.md", "---\nname: flowbash\ndescription: d\ntools: [Read, \"Bash(git log:*)\"]\n---\nRun.");
        write(".claude/agents/linebash.md", "---\nname: linebash\ndescription: d\ntools: Read, Bash(git log:*), Grep\n---\nRun.");
        write(".claude/agents/flowread.md", "---\nname: flowread\ndescription: d\ntools: [\"Read\", 'Glob']\n---\nRead.");

        assertEquals("explore", typeOf("blockread"));
        assertEquals("worker", typeOf("blockbash"));
        assertEquals("worker", typeOf("flowbash"));
        assertEquals("worker", typeOf("linebash"));
        assertEquals("explore", typeOf("flowread"));
    }

    /** A tools key whose value cannot be read as a list runs as the narrower type. */
    @Test
    void aToolsKeyThatCannotBeReadRunsAsExplore() throws IOException {
        write(".claude/agents/scalar.md", "---\nname: scalar\ndescription: d\ntools: |\n  Read\n  Bash\n---\nBody.");
        write(".claude/agents/empty.md", "---\nname: empty\ndescription: d\ntools:\n---\nBody.");
        write(".claude/agents/none.md", "---\nname: none\ndescription: d\n---\nBody.");

        assertEquals("explore", typeOf("scalar"));
        assertEquals("explore", typeOf("empty"));
        assertEquals("worker", typeOf("none"), "no tools key: every tool, as Claude Code reads it");
    }

    /** Review finding 1: the session folder is the home, so its .spectro/skills is the user's root. */
    @Test
    void theUsersOwnSkillRootIsNotReadAgainAsTheWorkspace() throws IOException {
        write(".spectro/skills/mine/SKILL.md", "---\nname: mine\n---\nmy skill");
        write(".spectro/commands/deploy.md", "---\ndescription: Deploy\n---\nDeploy it.");
        write(".claude/skills/theirs/SKILL.md", "---\nname: theirs\n---\nclaude skill");

        SessionCatalogue.Layer layer = WorkspaceItems.read(ws, ws.resolve(".spectro/skills"));

        assertEquals(Map.of("theirs", "claude skill"), byPlain(layer, SessionCatalogue.SKILL));
        assertEquals(Map.of("deploy", "Deploy it."), byPlain(layer, SessionCatalogue.COMMAND));
        assertEquals(Map.of("mine", "my skill", "theirs", "claude skill"),
                byPlain(WorkspaceItems.read(ws, Files.createDirectories(ws.resolve("elsewhere"))), SessionCatalogue.SKILL));
    }
}
