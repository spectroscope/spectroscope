package dev.spectroscope.core.tools;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.playbook.PlaybookFolderFence;
import dev.spectroscope.core.tools.Tool.ToolContext;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.function.Function;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 554 fix round 1, criterion 8d hardened from the owner's model: a
 * playbook is never written by a session. The two tools that create or change
 * a file, {@code write_file} and {@code edit_file}, refuse every path under a
 * registered playbook folder, in every permission mode, the extended one
 * included, and also when the playbook folder lies inside the workspace.
 * One exception (owner, 2026-10-13, card 558): a playbook folder that is the
 * session's working folder, by real path, is written like any working folder.
 */
@Timeout(value = 10, unit = TimeUnit.SECONDS)
class PlaybookFolderFenceTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Map<String, Tool> TOOLS = StandardTools.all(10).stream()
            .collect(Collectors.toMap(Tool::name, Function.identity()));

    @TempDir Path root;

    private Path workspace;
    private String registryBefore;

    @BeforeEach
    void layout() throws IOException {
        workspace = Files.createDirectories(root.resolve("ws")).toRealPath();
        Path registry = PlaybookFolderFence.registryFile();
        registryBefore = Files.exists(registry) ? Files.readString(registry) : null;
    }

    @AfterEach
    void restoreRegistry() throws IOException {
        Path registry = PlaybookFolderFence.registryFile();
        if (registryBefore == null) {
            Files.deleteIfExists(registry);
        } else {
            Files.writeString(registry, registryBefore);
        }
    }

    /** A playbook folder with its file, registered the way the server registers one. */
    private static Path registeredPlaybook(Path folder) throws IOException {
        Files.createDirectories(folder);
        Files.writeString(folder.resolve("playbook.json"), "{ \"id\": \"p\" }\n");
        Path real = folder.toRealPath();
        Path registry = PlaybookFolderFence.registryFile();
        Files.createDirectories(registry.getParent());
        Files.writeString(registry, JSON.writeValueAsString(Map.of("folders", List.of(real.toString()),
                "active", Map.of())));
        return real;
    }

    /** Several registered folders, each with its file, in one registry. */
    private static void register(Path... folders) throws IOException {
        List<String> real = new java.util.ArrayList<>();
        for (Path folder : folders) {
            Files.createDirectories(folder);
            Files.writeString(folder.resolve("playbook.json"), "{ \"id\": \"p\" }\n");
            real.add(folder.toRealPath().toString());
        }
        Path registry = PlaybookFolderFence.registryFile();
        Files.createDirectories(registry.getParent());
        Files.writeString(registry, JSON.writeValueAsString(Map.of("folders", real, "active", Map.of())));
    }

    private ToolContext fenced() {
        return fenced(workspace);
    }

    private static ToolContext fenced(Path cwd) {
        return new ToolContext(cwd, new CancelSignal());
    }

    private ToolContext extended() {
        return extended(workspace);
    }

    private static ToolContext extended(Path cwd) {
        return new ToolContext(cwd, new CancelSignal(), "main", "c1", event -> { },
                attachment -> { }, change -> { }, millis -> { }, true);
    }

    private static String run(String tool, ObjectNode input, ToolContext context) {
        return TOOLS.get(tool).execute(input, context);
    }

    private static ObjectNode write(String path) {
        return JSON.createObjectNode().put("path", path).put("content", "changed\n");
    }

    private static ObjectNode edit(String path) {
        return JSON.createObjectNode().put("path", path).put("old_string", "\"p\"").put("new_string", "\"q\"");
    }

    @Test
    void aPlaybookFolderInsideTheWorkspaceIsNeverWrittenInAnyMode() throws IOException {
        Path pb = registeredPlaybook(workspace.resolve("pb"));
        for (ToolContext context : List.of(fenced(), extended())) {
            String wrote = run("write_file", write("pb/new.md"), context);
            String edited = run("edit_file", edit("pb/playbook.json"), context);
            String climbed = run("write_file", write("docs/../pb/playbook.json"), context);
            for (String answer : List.of(wrote, edited, climbed)) {
                assertTrue(answer.startsWith("ERROR: ") && answer.contains("playbook folder " + pb)
                        && answer.contains("only read"), answer);
            }
        }
        assertFalse(Files.exists(pb.resolve("new.md")), "nothing was created in the playbook folder");
        assertEquals("{ \"id\": \"p\" }\n", Files.readString(pb.resolve("playbook.json")), "nothing was changed");
        assertTrue(run("write_file", write("notes.md"), fenced()).startsWith("Wrote: notes.md"),
                "the rest of the workspace stays writable");
    }

    @Test
    void theExtendedModeReachesOutsideButNeverIntoAPlaybookFolder() throws IOException {
        Path pb = registeredPlaybook(root.resolve("pb"));
        String wrote = run("write_file", write("../pb/new.md"), extended());
        String edited = run("edit_file", edit("../pb/playbook.json"), extended());
        assertTrue(wrote.startsWith("ERROR: write_file will not change") && wrote.contains("playbook folder " + pb),
                wrote);
        assertTrue(edited.startsWith("ERROR: edit_file will not change") && edited.contains("playbook folder " + pb),
                edited);
        assertFalse(Files.exists(pb.resolve("new.md")));
        assertEquals("{ \"id\": \"p\" }\n", Files.readString(pb.resolve("playbook.json")));
        assertTrue(run("write_file", write("../beside.md"), extended()).startsWith("Wrote: ../beside.md"),
                "positive control: the extended mode still writes outside the workspace");
    }

    @Test
    void aFolderThatIsNotRegisteredIsAnOrdinaryFolder() throws IOException {
        Path other = Files.createDirectories(workspace.resolve("other"));
        Files.writeString(other.resolve("playbook.json"), "{ \"id\": \"p\" }\n");
        registeredPlaybook(root.resolve("pb"));
        assertTrue(run("edit_file", edit("other/playbook.json"), fenced()).startsWith("Edited: other/playbook.json"),
                "only a registered folder is a playbook to the fence");
        Files.deleteIfExists(PlaybookFolderFence.registryFile());
        assertTrue(run("write_file", write("plain.md"), fenced()).startsWith("Wrote: plain.md"),
                "no registry, nothing fenced");
    }

    /**
     * Owner, 2026-10-13: when the playbook folder is the session's working
     * folder, the agent writes there, in every mode, also when the session's
     * folder is named through a link to the same real folder.
     */
    @Test
    void aPlaybookFolderThatIsTheWorkingFolderIsWritableInEveryMode() throws IOException {
        register(workspace);
        Path link = Files.createSymbolicLink(root.resolve("ws-link"), workspace);
        for (ToolContext context : List.of(fenced(), extended(), fenced(link), extended(link))) {
            String wrote = run("write_file", write("notes/new.md"), context);
            assertTrue(wrote.startsWith("Wrote: notes/new.md"), wrote);
        }
        String edited = run("edit_file", edit("playbook.json"), fenced());
        assertTrue(edited.startsWith("Edited: playbook.json"), edited);
        assertEquals("{ \"id\": \"q\" }\n", Files.readString(workspace.resolve("playbook.json")));
        String editedExtended = run("edit_file", JSON.createObjectNode().put("path", "playbook.json")
                .put("old_string", "\"q\"").put("new_string", "\"r\""), extended());
        assertTrue(editedExtended.startsWith("Edited: playbook.json"), editedExtended);
    }

    /**
     * The exception is the working folder only: a second playbook folder
     * inside it, a different registered folder outside it, and a working
     * folder that lies inside a playbook folder all stay fenced.
     */
    @Test
    void onlyTheWorkingFolderItselfIsExceptedAndEveryOtherPlaybookFolderStaysFenced() throws IOException {
        Path nested = workspace.resolve("inner");
        Path other = root.resolve("other-pb");
        register(workspace, nested, other);
        Path nestedReal = nested.toRealPath();
        Path otherReal = other.toRealPath();
        for (ToolContext context : List.of(fenced(), extended())) {
            String inner = run("write_file", write("inner/new.md"), context);
            String innerEdit = run("edit_file", edit("inner/playbook.json"), context);
            for (String answer : List.of(inner, innerEdit)) {
                assertTrue(answer.startsWith("ERROR: ") && answer.contains("playbook folder " + nestedReal), answer);
            }
        }
        String outside = run("write_file", write("../other-pb/new.md"), extended());
        assertTrue(outside.startsWith("ERROR: write_file will not change")
                && outside.contains("playbook folder " + otherReal), outside);
        assertFalse(Files.exists(nested.resolve("new.md")));
        assertFalse(Files.exists(other.resolve("new.md")));
        assertTrue(run("write_file", write("top.md"), fenced()).startsWith("Wrote: top.md"),
                "positive control: the working folder itself is written");

        Path sub = Files.createDirectories(otherReal.resolve("sub"));
        String fromInside = run("write_file", write("new.md"), fenced(sub));
        assertTrue(fromInside.startsWith("ERROR: ") && fromInside.contains("playbook folder " + otherReal),
                "a working folder inside a playbook folder is not that playbook folder: " + fromInside);
        assertFalse(Files.exists(sub.resolve("new.md")));
    }
}
