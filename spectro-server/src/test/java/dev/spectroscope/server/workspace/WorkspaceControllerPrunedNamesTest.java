package dev.spectroscope.server.workspace;

import dev.spectroscope.server.session.SessionWorkspaces;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.mock.web.MockHttpServletRequest;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 351 re-review, finding 2: since the dot-rule left the tree,
 * {@link WorkspaceController#PRUNED_NAMES} is the listing's ONLY filter and
 * nothing measured it. The reviewer proved it by taking {@code "dist"} and
 * {@code "out"} out of the set and watching the whole suite stay green.
 *
 * <p>The trap on the other side is card 312's, hit three times on this board:
 * a hand-list guarded by a test that types the same hand-list is two copies of
 * one lie. So the fixture below is tied to the constant in BOTH directions.
 * {@link #theFixtureCoversEveryNameTheSourcePrunes} fails when a name is added
 * to the source and to nowhere else, and
 * {@link #everyPrunedNameIsGoneAsADirectoryAndAsAFile} fails when a name is
 * taken out of the source, because the fixture then finds it in the tree. All
 * three bites were run: add a name, remove {@code "dist"}, and make the
 * predicate answer {@code false} — each one red, each mutation confirmed in the
 * working tree before its colour was read.</p>
 */
class WorkspaceControllerPrunedNamesTest {

    /**
     * What the fixture builds and asserts on. Typed out on purpose so a removal
     * from the source has something to contradict it — and pinned to the source
     * by {@link #theFixtureCoversEveryNameTheSourcePrunes} so it cannot quietly
     * fall behind an addition.
     */
    private static final Set<String> EXPECTED = Set.of(
            ".git", "build", "node_modules", "target", "dist", "out",
            ".venv", ".next", ".tox", ".gradle", ".mypy_cache", ".pytest_cache",
            ".DS_Store");

    @TempDir
    Path root;

    private String session;

    @BeforeEach
    void registerTheSessionsWorkspace() {
        session = "ws-pruned-" + System.nanoTime();
        SessionWorkspaces.resolved(session, root.toString());
    }

    private List<WorkspaceController.FileNode> treeOf(WorkspaceController.FilesResponse res) {
        return res.entries();
    }

    private WorkspaceController.FilesResponse tree() {
        return (WorkspaceController.FilesResponse)
                new WorkspaceController().files(session, null, new MockHttpServletRequest()).getBody();
    }

    private static List<String> names(List<WorkspaceController.FileNode> nodes) {
        return nodes.stream().map(WorkspaceController.FileNode::name).toList();
    }

    @Test
    void theFixtureCoversEveryNameTheSourcePrunes() {
        // The direction card 312 keeps losing: a name added to the constant and
        // to nothing else has to break something. This is that something.
        assertThat(EXPECTED)
                .as("every name in WorkspaceController.PRUNED_NAMES is measured below")
                .isEqualTo(WorkspaceController.PRUNED_NAMES);
    }

    @Test
    void everyPrunedNameIsGoneAsADirectoryAndAsAFile() throws Exception {
        // The filter tests one bare path segment, so it must not care whether
        // the segment is a folder or a file. Both shapes, both measured, and a
        // real sibling beside them so a filter that ate everything would fail
        // just as loudly as one that ate nothing.
        Files.createDirectories(root.resolve("asFiles"));
        for (String pruned : EXPECTED) {
            Files.createDirectories(root.resolve(pruned));
            Files.writeString(root.resolve(pruned).resolve("inside.txt"), "noise");
            Files.writeString(root.resolve("asFiles").resolve(pruned), "noise");
        }
        Files.createDirectories(root.resolve("src"));
        Files.writeString(root.resolve("src/Main.java"), "class Main {}");

        WorkspaceController.FilesResponse res = tree();

        assertThat(res.truncated()).isFalse();
        assertThat(names(treeOf(res)))
                .containsExactly("asFiles", "src")
                .doesNotContainAnyElementsOf(EXPECTED);
        WorkspaceController.FileNode asFiles = treeOf(res).get(0);
        assertThat(names(asFiles.children()))
                .as("the same names pruned when they are files, not directories")
                .isEmpty();
        WorkspaceController.FileNode src = treeOf(res).get(1);
        assertThat(names(src.children())).containsExactly("Main.java");
    }

    @Test
    void aNameThatMerelyLooksLikeAPrunedOneSurvives() throws Exception {
        // The filter matches whole segments. Without this, "prune anything
        // containing build" would pass the test above and quietly eat the
        // operator's own folders.
        for (String near : new String[] {"builder", "outbox", "dist-tools", "my-node_modules", ".gitignore"}) {
            Files.writeString(root.resolve(near), "mine");
        }

        assertThat(names(treeOf(tree())))
                .containsExactly(".gitignore", "builder", "dist-tools", "my-node_modules", "outbox");
    }
}
