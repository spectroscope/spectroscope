package dev.spectroscope.server.workspace;

import dev.spectroscope.server.session.SessionWorkspaces;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.mock.web.MockHttpServletRequest;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 351: listing an entry and reading its contents are two decisions, and
 * one predicate used to make both. The operator could not see that a folder
 * held a {@code .claude/launch.json}, so an empty file view read as a
 * regression rather than as an empty folder — while the agent sitting beside
 * him has no dot-file rule at all and reads the same file whenever it likes.
 *
 * <p>These tests hold the two halves apart. The tree shows the name; the
 * content endpoint still refuses the bytes. Whether any dot-file ever becomes
 * READABLE is the owner's call and is not decided here — what is decided is
 * that the two questions have two answers.</p>
 */
class WorkspaceControllerDotEntriesTest {

    @TempDir
    Path root;

    private String session;

    @BeforeEach
    void registerTheSessionsWorkspace() {
        session = "ws-dot-" + System.nanoTime();
        SessionWorkspaces.resolved(session, root.toString());
    }

    private static MockHttpServletRequest local() {
        return new MockHttpServletRequest();
    }

    private WorkspaceController controller() {
        return new WorkspaceController();
    }

    private java.util.List<WorkspaceController.FileNode> tree() {
        return ((WorkspaceController.FilesResponse) controller().files(session, null, local()).getBody()).entries();
    }

    private static java.util.List<String> names(java.util.List<WorkspaceController.FileNode> nodes) {
        return nodes.stream().map(WorkspaceController.FileNode::name).toList();
    }

    @Test
    void theTreeShowsThatALaunchConfigurationExists() throws Exception {
        // The owner's sentence, literally: he could not tell whether a folder
        // had a launch config in it. Now he can, without being handed its bytes.
        Files.createDirectories(root.resolve(".claude"));
        Files.writeString(root.resolve(".claude/launch.json"), "{\"configurations\":[]}");
        Files.writeString(root.resolve("README.md"), "# hello");

        assertThat(names(tree())).contains(".claude");
        WorkspaceController.FileNode claude =
                tree().stream().filter(n -> n.name().equals(".claude")).findFirst().orElseThrow();
        assertThat(claude.dir()).isTrue();
        assertThat(names(claude.children())).containsExactly("launch.json");
        assertThat(claude.children().get(0).path()).isEqualTo(".claude/launch.json");
    }

    @Test
    void theTreeStillPrunesTheIgnoredDirectoriesDotGitAmongThem() throws Exception {
        // .git is BOTH a dot-name and an ignored directory, so it is the one
        // entry the split could lose by accident: drop the ignored list and
        // thousands of loose objects arrive with it.
        Files.createDirectories(root.resolve(".git/objects/ab"));
        Files.writeString(root.resolve(".git/objects/ab/cdef"), "loose object");
        Files.createDirectories(root.resolve("node_modules/x"));
        Files.createDirectories(root.resolve("build"));
        Files.writeString(root.resolve("kept.txt"), "x");

        assertThat(names(tree())).contains("kept.txt").doesNotContain(".git", "node_modules", "build");
    }

    @Test
    void listingADotFileIsNotPermissionToReadIt() throws Exception {
        // The whole point of splitting the predicate. The name is in the tree
        // and the bytes are not served: the guard the class comment promises
        // ("the .env with the API key answers 404") is untouched by the sight.
        Files.writeString(root.resolve(".env"), "ANTHROPIC_API_KEY=sk-not-a-real-key");

        assertThat(names(tree())).contains(".env");
        assertThat(controller().file(".env", session, null, local()).getStatusCode().value()).isEqualTo(404);
    }

    @Test
    void noDotEntryIsReadableYetBecauseThatIsTheOwnersOpenCall() throws Exception {
        // Card 351 criterion 2 offers three shapes and reserves the choice for
        // the owner. What SHIPS is the smallest one: every dot path is listed
        // and none of them opens, so this pins the shipped policy rather than
        // an argument for it. When the owner picks (b) or (c), this test is the
        // one that has to be replaced, deliberately.
        Files.createDirectories(root.resolve(".claude"));
        Files.writeString(root.resolve(".claude/launch.json"), "{}");
        Files.writeString(root.resolve(".gitignore"), "build/");

        for (String path : new String[] {".claude/launch.json", ".gitignore"}) {
            assertThat(controller().file(path, session, null, local()).getStatusCode().value())
                    .as("reading %s", path)
                    .isEqualTo(404);
        }
    }

    @Test
    void aDotSegmentAnywhereInThePathRefusesTheRead() throws Exception {
        // The refusal walks every segment, not just the last one. A readable
        // name under a hidden folder is the case a last-segment check would
        // serve, and the tree now hands out exactly such paths.
        Files.createDirectories(root.resolve("src/.secrets"));
        Files.writeString(root.resolve("src/.secrets/token.txt"), "sk-not-a-real-key");

        assertThat(controller().file("src/.secrets/token.txt", session, null, local()).getStatusCode().value())
                .isEqualTo(404);
    }
}
